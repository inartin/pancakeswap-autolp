/**
 * Auto-Rebalance Service
 * 
 * Automated position rebalancing based on profit maximization, not fee maximization.
 * Core principle: Net Profit = Fee Income - Impermanent Loss - Transaction Costs
 * 
 * Strategy (Updated Nov 2025):
 * - Wider ranges for stability (TIGHT 1.0-1.5% → NORMAL 1.6-2.0% → WIDE 2.1-3.0%)
 * - Dynamic width selection within mode (interpolated based on ATR position)
 * - IL profitability check (only rebalance when expected fees > costs + 50% margin)
 * - Extended patience (60-180 min wait vs old 3-15 min)
 * - No proactive tightening (disabled to prevent over-rebalancing)
 * - Smart daily limits with exceptions (25/day vs old 40/day)
 * 
 * @module auto-rebalance.service
 */

import { AUTO_REBALANCE_CONFIG, LAMPORTS_PER_SOL, PANCAKESWAP_IDL } from '../config/constants.js';
import { getMarketMetrics_WS, calculateTWAP_WS } from './market-data-ws.service.js';
import { getPositionStatistics } from './position-statistics.service.js';
import { calculateCompleteApr } from '../utils/apr.util.js';
import { isRebalanceProfitable } from '../utils/il-calculator.util.js';
import { fetchPositionRangeData } from '../utils/range.util.js';
import { db } from '../db/index.js';
import { positions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createSolanaConnection } from '../utils/rpc.util.js';
import { getCachedPoolStructure } from '../cache/redis-cache.util.js';
import { BorshCoder } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';

// Debug logging flag
const isDebug = process.env.LOG_LEVEL === 'debug';

// Track previous ATR for volatility spike detection
let previousAtrPercent = null;
let lastAtrCheckTime = null;

// Track recent auto-rebalance executions for hourly churn protection
const recentAutoRebalances = new Map(); // positionId -> number[]
const HOURLY_WINDOW_MS = 60 * 60 * 1000;

// Cache pool tick spacing lookups (5 minute TTL)
const poolTickSpacingCache = new Map(); // poolAddress -> { tickSpacing, cachedAt }
const POOL_CACHE_TTL_MS = 5 * 60 * 1000;

// Shared coder for pool decoding (used by cache util)
const poolCoder = new BorshCoder(PANCAKESWAP_IDL);

// Structured event history (decision + outcomes)
const recentAutoRebalanceEvents = [];
const MAX_EVENT_HISTORY = 200;

// Forced mode overrides (per position, time-limited)
const forcedModeOverrides = new Map(); // positionId -> { mode, expiresAt }

function getForcedModeOverride(positionId) {
    if (positionId == null) {
        return null;
    }
    const entry = forcedModeOverrides.get(positionId);
    if (!entry) {
        return null;
    }
    if (entry.expiresAt > Date.now()) {
        return entry;
    }
    forcedModeOverrides.delete(positionId);
    return null;
}

function setForcedModeOverride(positionId, mode, durationMinutes) {
    if (positionId == null) {
        return;
    }
    if (!mode || !durationMinutes || durationMinutes <= 0) {
        forcedModeOverrides.delete(positionId);
        return;
    }
    const expiresAt = Date.now() + (durationMinutes * 60 * 1000);
    forcedModeOverrides.set(positionId, { mode, expiresAt });
}

function clearForcedModeOverride(positionId) {
    if (positionId == null) {
        return;
    }
    forcedModeOverrides.delete(positionId);
}

function pushEvent(event) {
    const payload = {
        ...event,
        timestamp: new Date().toISOString()
    };
    recentAutoRebalanceEvents.push(payload);
    if (recentAutoRebalanceEvents.length > MAX_EVENT_HISTORY) {
        recentAutoRebalanceEvents.shift();
    }
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`🗒️  Auto-rebalance ${event.type}: ${JSON.stringify(payload)}`);
    }
}

export function logAutoRebalanceDecision(event) {
    pushEvent({ type: 'decision', ...event });
}

export function logAutoRebalanceOutcome(event) {
    pushEvent({ type: 'outcome', ...event });
}

export function getRecentAutoRebalanceEvents() {
    return [...recentAutoRebalanceEvents];
}

/**
 * Determine optimal range mode based on market volatility
 * 
 * @param {number} atrPercent - ATR as percentage of current price
 * @returns {{ mode: string, width: number, baseWaitMinutes: number }}
 */
/**
 * Calculate dynamic width within mode range
 * 
 * Instead of fixed widths, interpolate within mode's min/max based on ATR position.
 * Lower ATR within mode = lower end of range, higher ATR = higher end.
 * 
 * @param {number} atrPercent - Current ATR percentage
 * @param {string} mode - Mode name (TIGHT, NORMAL, WIDE)
 * @param {Object} modeConfig - Mode configuration
 * @returns {number} Dynamic width
 */
export function calculateDynamicWidth(atrPercent, mode, modeConfig) {
    const { minWidth, maxWidth } = modeConfig;
    
    // Determine ATR position within mode's threshold range
    let atrMin, atrMax;
    if (mode === 'TIGHT') {
        atrMin = 0;
        atrMax = AUTO_REBALANCE_CONFIG.RANGE_MODES.TIGHT.atrThreshold;
    } else if (mode === 'NORMAL') {
        atrMin = AUTO_REBALANCE_CONFIG.RANGE_MODES.TIGHT.atrThreshold;
        atrMax = AUTO_REBALANCE_CONFIG.RANGE_MODES.NORMAL.atrThreshold;
    } else { // WIDE
        atrMin = AUTO_REBALANCE_CONFIG.RANGE_MODES.NORMAL.atrThreshold;
        atrMax = 5.0; // Practical upper limit
    }
    
    // Calculate position (0 to 1)
    const atrPosition = (atrPercent - atrMin) / (atrMax - atrMin);
    const atrPositionClamped = Math.min(1, Math.max(0, atrPosition));
    
    // Interpolate width
    const width = minWidth + (maxWidth - minWidth) * atrPositionClamped;
    
    return Number(width.toFixed(2));
}

export function determineRangeMode(atrPercent) {
    const modes = AUTO_REBALANCE_CONFIG.RANGE_MODES;
    
    // Build threshold display string (updated for 3 modes)
    const thresholds = `TIGHT: <${modes.TIGHT.atrThreshold}% | NORMAL: ${modes.TIGHT.atrThreshold}-${modes.NORMAL.atrThreshold}% | WIDE: >${modes.NORMAL.atrThreshold}%`;
    
    let mode, modeConfig;
    
    if (atrPercent < modes.TIGHT.atrThreshold) {
        mode = 'TIGHT';
        modeConfig = modes.TIGHT;
    } else if (atrPercent < modes.NORMAL.atrThreshold) {
        mode = 'NORMAL';
        modeConfig = modes.NORMAL;
    } else {
        mode = 'WIDE';
        modeConfig = modes.WIDE;
    }
    
    // Calculate dynamic width within mode range
    const width = calculateDynamicWidth(atrPercent, mode, modeConfig);
    
    return {
        mode,
        width, // Dynamic width based on ATR position within mode
        baseWaitMinutes: modeConfig.baseWaitMinutes,
        maxWaitMinutes: modeConfig.maxWaitMinutes,
        atrPercent,
        thresholds
    };
}

/**
 * Calculate tightened range width based on price stability
 * 
 * Reduces range width gradually if price has been stable for extended periods.
 * Never goes below minimum threshold (0.1%).
 * 
 * @param {number} baseWidth - Base range width from mode
 * @param {Object} stats - Position statistics
 * @param {number} atrPercent - Current ATR as percentage
 * @returns {number} Adjusted range width
 */
export function calculateTightenedWidth(baseWidth, stats, atrPercent) {
    const config = AUTO_REBALANCE_CONFIG.TIGHTENING;
    
    if (!config.enabled) {
        return baseWidth;
    }
    
    // Check if we have enough in-range time to consider tightening
    const hoursInRange = stats.time_in_range_ms / (1000 * 60 * 60);
    
    if (hoursInRange < 1) {
        // Not enough stability data
        return baseWidth;
    }
    
    // Calculate how many tightening steps we can apply
    const stepsToApply = Math.min(
        Math.floor(hoursInRange / (config.intervalMinutes / 60)),
        config.maxSteps
    );
    
    if (stepsToApply === 0) {
        return baseWidth;
    }
    
    // Apply tightening steps
    let newWidth = baseWidth;
    for (let i = 0; i < stepsToApply; i++) {
        newWidth -= config.stepSize;
        
        // Never go below minimum
        if (newWidth <= config.minimumWidth) {
            return config.minimumWidth;
        }
    }
    
    return Math.max(newWidth, config.minimumWidth);
}

/**
 * Calculate wait time before rebalancing (in milliseconds)
 * 
 * Factors:
 * - Base wait time from mode
 * - Crossback count (chop factor)
 * - Choppy market extension
 * - Maximum wait time cap (prevents infinite wait)
 * 
 * @param {string} mode - Current range mode
 * @param {Object} stats - Position statistics
 * @returns {number} Wait time in milliseconds
 */
export function calculateWaitTime(mode, stats) {
    const config = AUTO_REBALANCE_CONFIG.WAIT_PERIODS;
    const modeConfig = AUTO_REBALANCE_CONFIG.RANGE_MODES[mode];
    
    const crossbacks = stats.crossbacks_90m || 0;
    
    let waitMinutes = modeConfig.baseWaitMinutes;
    
    // Each crossback shortens the wait window (markets chopping)
    if (crossbacks > 0 && config.crossbackReductionMinutes) {
        const reduction = crossbacks * config.crossbackReductionMinutes;
        waitMinutes = Math.max(waitMinutes - reduction, config.minWaitMinutes || 1);
        if (isDebug) console.log(`⚠️  ${crossbacks} crossback(s) detected - reducing wait by ${reduction} minutes (now ${waitMinutes}m)`);
    }
    
    // Choppy markets get capped waits instead of extensions
    if (crossbacks >= config.choppyThreshold && config.choppyWaitCapMinutes) {
        if (waitMinutes > config.choppyWaitCapMinutes && isDebug) {
            console.log(`⚠️  Choppy market (${crossbacks} crossbacks) - capping wait at ${config.choppyWaitCapMinutes} minutes`);
        }
        waitMinutes = Math.min(waitMinutes, config.choppyWaitCapMinutes);
    }
    
    const minWait = config.minWaitMinutes ?? 1;
    const maxWait = config.maxWaitMinutes ?? 120;
    if (waitMinutes < minWait) {
        waitMinutes = minWait;
    } else if (waitMinutes > maxWait) {
        if (isDebug) console.log(`⏱️  Wait time capped at ${maxWait} minutes (was ${waitMinutes} minutes)`);
        waitMinutes = maxWait;
    }
    
    return waitMinutes * 60 * 1000; // Convert to milliseconds
}

/**
 * Check if position should bypass daily limit
 * 
 * Exceptions:
 * 1. Extended OOR (>4 hours)
 * 2. Long gap since last rebalance (>6 hours)
 * 3. Large position stuck OOR (>$500, >2 hours OOR)
 * 
 * @param {Object} stats - Position statistics
 * @param {Object} position - Position data with USD value
 * @returns {{ bypass: boolean, reason: string|null }}
 */
export function shouldBypassDailyLimit(stats, position) {
    const exceptions = AUTO_REBALANCE_CONFIG.SAFETY.BYPASS_EXCEPTIONS;
    
    // Exception 1: Extended OOR
    const oorHours = stats.time_out_of_range_ms / (1000 * 60 * 60);
    if (oorHours > exceptions.extendedOorHours) {
        return {
            bypass: true,
            reason: `Extended OOR (${oorHours.toFixed(1)}h > ${exceptions.extendedOorHours}h threshold)`
        };
    }
    
    // Exception 2: Long gap since last rebalance
    if (stats.last_rebalance_at) {
        const hoursSinceRebalance = (Date.now() - new Date(stats.last_rebalance_at).getTime()) / (1000 * 60 * 60);
        if (hoursSinceRebalance > exceptions.longGapHours) {
            return {
                bypass: true,
                reason: `Long gap since last rebalance (${hoursSinceRebalance.toFixed(1)}h > ${exceptions.longGapHours}h threshold)`
            };
        }
    }
    
    // Exception 3: Large position stuck OOR
    if (position.usd_value > exceptions.largePositionUsd && oorHours > exceptions.largePositionOorHours) {
        return {
            bypass: true,
            reason: `Large position OOR (${formatCurrency(position.usd_value)}, ${oorHours.toFixed(1)}h OOR)`
        };
    }
    
    return { bypass: false, reason: null };
}

/**
 * Check for excessive rebalancing (anti-churn protection)
 * 
 * Simplified to ONLY use rolling hourly limit - no more daily threshold confusion.
 * The hourly limit (default: 4/hour) is the hard safety rail.
 * 
 * @param {Object} stats - Position statistics
 * @returns {{ shouldBlock: boolean, lastRebalanceTime: number|null, minutesAgo: number }} Block decision and timing
 */
export function shouldBlockRebalance(stats, positionId = null) {
    if (!stats.last_rebalance_at) {
        return { shouldBlock: false, lastRebalanceTime: null, minutesAgo: null, rebalancesToday: stats.rebalances_today || 0 };
    }
    
    const lastRebalanceTime = new Date(stats.last_rebalance_at).getTime();
    const minutesAgo = Math.floor((Date.now() - lastRebalanceTime) / (60 * 1000));
    const rebalancesToday = stats.rebalances_today || 0;
    
    // ONLY hourly churn check (rolling 60 minutes) - this is the hard limit
    let hourlyLimitReached = false;
    let recentCount = 0;
    const hourlyLimit = AUTO_REBALANCE_CONFIG.SAFETY.hourlyChurnLimit;
    
    if (positionId != null && Number.isFinite(hourlyLimit) && hourlyLimit > 0) {
        const now = Date.now();
        const cutoff = now - HOURLY_WINDOW_MS;
        const previous = recentAutoRebalances.get(positionId) || [];
        const filtered = previous.filter((ts) => ts > cutoff);
        if (filtered.length !== previous.length) {
            recentAutoRebalances.set(positionId, filtered);
        }
        recentCount = filtered.length;
        hourlyLimitReached = filtered.length >= hourlyLimit;
    }
    
    if (hourlyLimitReached) {
        return {
            shouldBlock: true,
            lastRebalanceTime,
            minutesAgo,
            rebalancesToday,
            hourlyLimitReached: true,
            recentHourlyCount: recentCount
        };
    }
    
    // No block - hourly limit not reached
    return {
        shouldBlock: false,
        lastRebalanceTime,
        minutesAgo,
        rebalancesToday,
        hourlyLimitReached: false,
        recentHourlyCount: recentCount
    };
}

/**
 * Register a successful auto-rebalance execution
 * Maintains rolling 60-minute window for churn protection
 * 
 * @param {number} positionId
 */
export function registerAutoRebalanceExecution(positionId) {
    if (positionId == null) {
        return;
    }
    
    const now = Date.now();
    const cutoff = now - HOURLY_WINDOW_MS;
    const entries = recentAutoRebalances.get(positionId) || [];
    const filtered = entries.filter((ts) => ts > cutoff);
    filtered.push(now);
    recentAutoRebalances.set(positionId, filtered);
}

/**
 * Get tick spacing for a pool (cached, fetches from RPC on miss)
 * 
 * @param {string} poolAddress
 * @returns {Promise<number|null>}
 */
async function getPoolTickSpacing(poolAddress) {
    if (!poolAddress) {
        return null;
    }
    
    const cached = poolTickSpacingCache.get(poolAddress);
    if (cached && (Date.now() - cached.cachedAt) < POOL_CACHE_TTL_MS) {
        return cached.tickSpacing;
    }
    
    try {
        const connection = createSolanaConnection();
        const structure = await getCachedPoolStructure(connection, new PublicKey(poolAddress), poolCoder);
        const tickSpacing = structure?.tickSpacing ?? null;
        if (tickSpacing != null) {
            poolTickSpacingCache.set(poolAddress, { tickSpacing, cachedAt: Date.now() });
        }
        return tickSpacing;
    } catch (error) {
        console.warn(`⚠️  Failed to fetch tick spacing for pool ${poolAddress}: ${error.message}`);
        return cached?.tickSpacing ?? null;
    }
}

/**
 * Quantize desired range percent to pool tick spacing
 * Ensures range width aligns with discrete tick steps
 * 
 * @param {number} desiredPercent
 * @param {number|null} tickSpacing
 * @returns {{ percent: number, stepsPerSide: number }|null}
 */
function quantizeRangePercent(desiredPercent, tickSpacing) {
    if (!Number.isFinite(desiredPercent) || desiredPercent <= 0 || !Number.isFinite(tickSpacing) || tickSpacing <= 0) {
        return null;
    }
    
    const ratioPerStep = Math.pow(1.0001, tickSpacing);
    
    // Solve for number of steps per side required to meet/exceed desired percent
    const exactSteps = Math.log(1 + (desiredPercent / 100)) / Math.log(ratioPerStep);
    const ceilSteps = Math.max(1, Math.ceil(exactSteps));
    const percentForCeil = (Math.pow(ratioPerStep, ceilSteps) - 1) * 100;
    
    return {
        percent: Number(percentForCeil.toFixed(4)),
        stepsPerSide: ceilSteps
    };
}

/**
 * Calculate expected fee benefit vs rebalance cost
 * 
 * Estimates how much additional fees will be earned by tightening range,
 * compared to the cost of rebalancing.
 * 
 * @param {Object} position - Position data
 * @param {number} currentWidth - Current range width (%)
 * @param {number} newWidth - Proposed new width (%)
 * @param {number} poolFeeApr - Pool fee APR (%)
 * @param {number} positionValueUsd - Position value in USD
 * @returns {{ expectedGainUsd: number, rebalanceCostUsd: number, benefitRatio: number }}
 */
export function calculateFeeBenefit(position, stats, currentWidth, newWidth, poolFeeApr, positionValueUsd) {
    // Estimate rebalance cost (0.1% of position value + ~$1 gas)
    const rebalanceCostUsd = (positionValueUsd * 0.001) + 1;
    
    // Calculate liquidity density increase
    // Narrower range = more concentrated liquidity = higher fee capture
    const liquidityMultiplier = currentWidth / newWidth;
    
    const totalFeesUsd = stats?.total_fees_earned_usd ?? 0;
    const timeInRangeMs = stats?.time_in_range_ms ?? 0;
    const totalObservedMs = (stats?.time_in_range_ms ?? 0) + (stats?.time_out_of_range_ms ?? 0);
    const timeInRangeDays = timeInRangeMs / (1000 * 60 * 60 * 24);
    const totalObservedDays = totalObservedMs / (1000 * 60 * 60 * 24);
    
    // Derive baseline daily fees from historical data when available
    let baselineDailyFees = 0;
    if (totalFeesUsd > 0 && timeInRangeDays >= 0.25) {
        // Use in-range time when we have meaningful sample (>= 6 hours)
        baselineDailyFees = totalFeesUsd / Math.max(timeInRangeDays, 0.25);
    } else if (totalFeesUsd > 0 && totalObservedDays >= 0.25) {
        baselineDailyFees = totalFeesUsd / Math.max(totalObservedDays, 0.25);
    } else if (poolFeeApr != null && Number.isFinite(poolFeeApr)) {
        baselineDailyFees = (positionValueUsd * (poolFeeApr / 100)) / 365;
    } else {
        // Fallback heuristic: assume 25% APR equivalent
        const fallbackApr = 25;
        baselineDailyFees = (positionValueUsd * (fallbackApr / 100)) / 365;
    }
    
    const expectedDailyFeesAfter = baselineDailyFees * liquidityMultiplier;
    const additionalDailyFees = Math.max(0, expectedDailyFeesAfter - baselineDailyFees);
    
    // Calculate how many days to break even (optimistic: assume stays in range for 2 days)
    const projectedDays = Math.min(
        3, // don't project too far
        Math.max(1, timeInRangeDays > 0 ? Math.min(2, timeInRangeDays) : 1.5)
    );
    const expectedGainUsd = additionalDailyFees * projectedDays;
    
    // Benefit ratio: gain / cost (should be > 3x for worthwhile)
    const benefitRatio = additionalDailyFees > 0 ? (expectedGainUsd / rebalanceCostUsd) : 0;
    const breakEvenDays = additionalDailyFees > 0 ? (rebalanceCostUsd / additionalDailyFees) : Infinity;
    
    return {
        expectedGainUsd,
        rebalanceCostUsd,
        benefitRatio,
        baselineDailyFees,
        additionalDailyFees,
        breakEvenDays
    };
}

/**
 * Check if range should be tightened (confidence scoring)
 * 
 * Requires ALL confidence gates to pass:
 * - Sustained stability (2+ hours)
 * - High in-range percentage (>96%)
 * - Low crossbacks (≤1)
 * - Few recent rebalances (≤1 in last 4h)
 * - Valuable position (>$250)
 * - High-earning pool (>35% fee APR)
 * - Positive cost-benefit (>3x)
 * 
 * @param {Object} position - Position data
 * @param {Object} stats - Position statistics
 * @param {number} currentWidth - Current range width (%)
 * @param {number} atrPercent - Current ATR percentage
 * @param {number} poolFeeApr - Pool fee APR (%)
 * @returns {{ shouldTighten: boolean, reason: string, newWidth?: number }}
 */
export function shouldTightenRange(position, stats, currentWidth, atrPercent, poolFeeApr) {
    const config = AUTO_REBALANCE_CONFIG.RANGE_OPTIMIZATION.tightening;
    
    if (!config.enabled) {
        return { shouldTighten: false, reason: 'Tightening disabled' };
    }
    
    // Enable debug logging to see all gate results
    const gates = [];
    
    // Gate 1: Position size filter
    gates.push(`Size: $${position.liquidity_usd?.toFixed(0) || 'N/A'} ${position.liquidity_usd >= config.minPositionUsd ? '✓' : '✗'}`);
    if (position.liquidity_usd < config.minPositionUsd) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✗ Gate 1: Position too small ($${position.liquidity_usd.toFixed(2)} < $${config.minPositionUsd})`);
        }
        return { 
            shouldTighten: false, 
            reason: `Position too small ($${position.liquidity_usd.toFixed(2)} < $${config.minPositionUsd})` 
        };
    }
    
    // Gate 2: Pool fee APR filter
    gates.push(`APR: ${poolFeeApr?.toFixed(1) || 'N/A'}% ${poolFeeApr && poolFeeApr >= config.minPoolFeeApr ? '✓' : '✗'}`);
    if (!poolFeeApr || poolFeeApr < config.minPoolFeeApr) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✗ Gate 2: Pool fee APR too low (${poolFeeApr?.toFixed(1) || 'N/A'}% < ${config.minPoolFeeApr}%)`);
        }
        return { 
            shouldTighten: false, 
            reason: `Pool fee APR too low (${poolFeeApr?.toFixed(1) || 'N/A'}% < ${config.minPoolFeeApr}%)` 
        };
    }
    
    // Gate 3: Stability duration
    const hoursInRange = stats.time_in_range_ms / (1000 * 60 * 60);
    gates.push(`Stable: ${hoursInRange.toFixed(1)}h ${hoursInRange >= config.requireStableHours ? '✓' : '✗'}`);
    if (hoursInRange < config.requireStableHours) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✗ Gate 3: Insufficient stability (${hoursInRange.toFixed(1)}h < ${config.requireStableHours}h)`);
        }
        return { 
            shouldTighten: false, 
            reason: `Insufficient stability (${hoursInRange.toFixed(1)}h < ${config.requireStableHours}h)` 
        };
    }
    
    // Gate 4: In-range percentage
    const totalTime = stats.time_in_range_ms + stats.time_out_of_range_ms;
    const inRangePercent = totalTime > 0 ? (stats.time_in_range_ms / totalTime) * 100 : 0;
    gates.push(`In-range: ${inRangePercent.toFixed(1)}% ${inRangePercent >= config.requireInRangePercent ? '✓' : '✗'}`);
    if (inRangePercent < config.requireInRangePercent) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✗ Gate 4: Low in-range time (${inRangePercent.toFixed(1)}% < ${config.requireInRangePercent}%)`);
        }
        return { 
            shouldTighten: false, 
            reason: `Low in-range time (${inRangePercent.toFixed(1)}% < ${config.requireInRangePercent}%)` 
        };
    }
    
    // Gate 5: Crossback count (stability indicator)
    const crossbacks = stats.crossbacks_90m || 0;
    gates.push(`Crossbacks: ${crossbacks} ${crossbacks <= config.maxCrossbacks90m ? '✓' : '✗'}`);
    if (crossbacks > config.maxCrossbacks90m) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✗ Gate 5: Too many crossbacks (${crossbacks} > ${config.maxCrossbacks90m})`);
        }
        return { 
            shouldTighten: false, 
            reason: `Too many crossbacks (${crossbacks} > ${config.maxCrossbacks90m})` 
        };
    }
    
    // Gate 6: Recent rebalance activity
    const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);
    let rebalancesLast4h = 0;
    if (stats.last_rebalance_at) {
        const lastRebalanceTime = new Date(stats.last_rebalance_at).getTime();
        if (lastRebalanceTime > fourHoursAgo) {
            // Approximate: if rebalanced recently, assume multiple in window
            rebalancesLast4h = Math.min(stats.rebalances_today || 0, 3);
        }
    }
    gates.push(`Rebalances(4h): ${rebalancesLast4h} ${rebalancesLast4h <= config.maxRebalancesLast4h ? '✓' : '✗'}`);
    if (rebalancesLast4h > config.maxRebalancesLast4h) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✗ Gate 6: Too many recent rebalances (${rebalancesLast4h} > ${config.maxRebalancesLast4h} in last 4h)`);
        }
        return { 
            shouldTighten: false, 
            reason: `Too many recent rebalances (${rebalancesLast4h} > ${config.maxRebalancesLast4h} in last 4h)` 
        };
    }
    
    // Gate 7: Check if already at minimum
    gates.push(`Width: ${currentWidth}% ${currentWidth > config.minimumWidth ? '✓' : '✗'}`);
    if (currentWidth <= config.minimumWidth) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✗ Gate 7: Already at minimum width (${currentWidth}% ≤ ${config.minimumWidth}%)`);
        }
        return { 
            shouldTighten: false, 
            reason: `Already at minimum width (${currentWidth}% ≤ ${config.minimumWidth}%)` 
        };
    }
    
    // Calculate proposed new width
    const proposedWidth = Math.max(currentWidth - config.stepSize, config.minimumWidth);
    
    // Gate 8: Cost-benefit analysis
    const positionValueUsd = Number.isFinite(position.liquidity_usd)
        ? position.liquidity_usd
        : Math.max(stats?.usd_value_on_open ?? 0, 0);
    
    const benefit = calculateFeeBenefit(
        position, 
        stats,
        currentWidth, 
        proposedWidth, 
        poolFeeApr, 
        positionValueUsd
    );
    
    gates.push(`Benefit: ${benefit.benefitRatio.toFixed(1)}x ${benefit.benefitRatio >= config.minFeeBenefitRatio ? '✓' : '✗'}`);
    if (benefit.benefitRatio < config.minFeeBenefitRatio) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✗ Gate 8: Insufficient benefit ratio (${benefit.benefitRatio.toFixed(1)}x < ${config.minFeeBenefitRatio}x)`);
            // Print summary of all gates when last gate fails
            console.log(`   📊 Tightening gates: ${gates.join(' | ')}`);
        }
        return { 
            shouldTighten: false, 
            reason: `Insufficient benefit ratio (${benefit.benefitRatio.toFixed(1)}x < ${config.minFeeBenefitRatio}x)` 
        };
    }
    
    // All gates passed - allow tightening
    if (isDebug) {
        console.log(`✅ Tightening confidence passed: ${currentWidth}% → ${proposedWidth}%`);
        console.log(`   Expected gain: $${benefit.expectedGainUsd.toFixed(2)}, Cost: $${benefit.rebalanceCostUsd.toFixed(2)}, Ratio: ${benefit.benefitRatio.toFixed(1)}x, Break-even: ${Number.isFinite(benefit.breakEvenDays) ? benefit.breakEvenDays.toFixed(1) : '∞'} days`);
    }
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`   📊 Tightening gates: ${gates.join(' | ')}`);
    }
    
    return {
        shouldTighten: true,
        reason: `All confidence gates passed (stable ${hoursInRange.toFixed(1)}h, ${inRangePercent.toFixed(1)}% in-range, ${benefit.benefitRatio.toFixed(1)}x benefit)`,
        newWidth: proposedWidth
    };
}

/**
 * Check if range should be widened due to volatility spike
 * 
 * Detects sudden ATR increases and widens range preemptively
 * to avoid going out of range.
 * 
 * @param {number} currentAtrPercent - Current ATR percentage
 * @param {number} currentWidth - Current range width (%)
 * @returns {{ shouldWiden: boolean, reason: string, newWidth?: number }}
 */
export function shouldWidenRange(currentAtrPercent, currentWidth) {
    const config = AUTO_REBALANCE_CONFIG.RANGE_OPTIMIZATION.widening;
    
    if (!config.enabled) {
        return { shouldWiden: false, reason: 'Widening disabled' };
    }
    
    // Need previous ATR to detect spike
    if (!previousAtrPercent) {
        previousAtrPercent = currentAtrPercent;
        lastAtrCheckTime = Date.now();
        return { shouldWiden: false, reason: 'Initializing ATR baseline' };
    }
    
    // Check if enough time has passed since last check
    const timeSinceLastCheck = Date.now() - lastAtrCheckTime;
    const checkIntervalMs = config.checkIntervalMinutes * 60 * 1000;
    
    if (timeSinceLastCheck < checkIntervalMs) {
        return { shouldWiden: false, reason: 'Widening check interval not elapsed' };
    }
    
    // Update check time
    lastAtrCheckTime = Date.now();
    
    // Calculate ATR increase ratio
    const atrIncreaseRatio = currentAtrPercent / previousAtrPercent;
    
    // Update previous ATR
    previousAtrPercent = currentAtrPercent;
    
    // Check for volatility spike
    if (atrIncreaseRatio >= config.atrIncreaseThreshold) {
        // Calculate widening amount
        const proposedWidth = Math.min(
            currentWidth + config.wideningStepSize,
            currentWidth + config.maxWidening
        );
        
        if (isDebug) {
            console.log(`⚠️ Volatility spike detected: ATR increased ${((atrIncreaseRatio - 1) * 100).toFixed(1)}%`);
            console.log(`   Widening range: ${currentWidth}% → ${proposedWidth}%`);
        }
        
        return {
            shouldWiden: true,
            reason: `Volatility spike (ATR ${previousAtrPercent.toFixed(2)}% → ${currentAtrPercent.toFixed(2)}%, +${((atrIncreaseRatio - 1) * 100).toFixed(1)}%)`,
            newWidth: proposedWidth
        };
    }
    
    return { shouldWiden: false, reason: 'No volatility spike detected' };
}

/**
 * Calculate optimized range width (replaces calculateTightenedWidth)
 * 
 * Implements adaptive hybrid strategy:
 * - Slow tightening with confidence scoring
 * - Fast widening on volatility spikes
 * - Cost-benefit analysis using pool fee APR
 * 
 * @param {number} baseWidth - Base range width from mode
 * @param {Object} stats - Position statistics
 * @param {Object} position - Position data
 * @param {number} atrPercent - Current ATR as percentage
 * @param {number} poolFeeApr - Pool fee APR percentage
 * @returns {Promise<{ width: number, reason: string }>}
 */
export async function calculateOptimizedWidth(baseWidth, stats, position, atrPercent, poolFeeApr, tickSpacing) {
    // Check for volatility spike first (defensive, fast)
    const widenCheck = shouldWidenRange(atrPercent, baseWidth);
    if (widenCheck.shouldWiden) {
        const quantized = quantizeRangePercent(widenCheck.newWidth, tickSpacing);
        const quantizedWidth = quantized ? quantized.percent : widenCheck.newWidth;
        if (quantized && Math.abs(quantizedWidth - widenCheck.newWidth) > 0.01 && isDebug) {
            console.log(`📏 Tick quantization (widen): ${widenCheck.newWidth}% → ${quantizedWidth}% (${quantized.stepsPerSide} steps/side)`);
        }
        return {
            width: quantizedWidth,
            reason: quantized
                ? `${widenCheck.reason} | Quantized to tick spacing (${quantized.stepsPerSide} steps/side)`
                : widenCheck.reason
        };
    }
    
    // Check for tightening opportunity (aggressive, slow)
    const tightenCheck = shouldTightenRange(position, stats, baseWidth, atrPercent, poolFeeApr);
    if (tightenCheck.shouldTighten) {
        const quantized = quantizeRangePercent(tightenCheck.newWidth, tickSpacing);
        const quantizedWidth = quantized ? quantized.percent : tightenCheck.newWidth;
        if (quantized && Math.abs(quantizedWidth - tightenCheck.newWidth) > 0.01 && isDebug) {
            console.log(`📏 Tick quantization (tighten): ${tightenCheck.newWidth}% → ${quantizedWidth}% (${quantized.stepsPerSide} steps/side)`);
        }
        return {
            width: quantizedWidth,
            reason: quantized
                ? `${tightenCheck.reason} | Quantized to tick spacing (${quantized.stepsPerSide} steps/side)`
                : tightenCheck.reason
        };
    }
    
    // No optimization - use base width
    const quantized = quantizeRangePercent(baseWidth, tickSpacing);
    const quantizedWidth = quantized ? quantized.percent : baseWidth;
    if (quantized && Math.abs(quantizedWidth - baseWidth) > 0.01 && isDebug) {
        console.log(`📏 Tick quantization (base): ${baseWidth}% → ${quantizedWidth}% (${quantized.stepsPerSide} steps/side)`);
    }
    
    return {
        width: quantizedWidth,
        reason: tightenCheck.reason || widenCheck.reason
            ? `${tightenCheck.reason || widenCheck.reason} | Quantized to tick spacing (${quantized?.stepsPerSide ?? 'n/a'} steps/side)`
            : (quantized
                ? `Tick spacing quantization applied (${quantized.stepsPerSide} steps/side)`
                : 'Using base width (no optimization)')
    };
}

/**
 * Check if position should be proactively optimized while IN range
 * 
 * Triggers when:
 * - Position is in range (not OOR)
 * - Current range is much wider than optimal for current volatility
 * - Position has been stable for sufficient time
 * - Cost-benefit analysis is favorable
 * 
 * Example: Position at 3% when market ATR suggests 0.6% would be optimal
 * 
 * @param {Object} position - Position data
 * @param {Object} stats - Position statistics
 * @returns {Promise<{ shouldOptimize: boolean, reason: string, optimalWidth?: number, data?: Object }>}
 */
async function shouldProactivelyOptimizeRange(position, stats) {
    try {
        const config = AUTO_REBALANCE_CONFIG.PROACTIVE_OPTIMIZATION;
        
        // Feature disabled?
        if (!config.enabled) {
            return { shouldOptimize: false, reason: 'Proactive optimization disabled' };
        }
        
        // Safety 1: Must have a current range_percent
        if (!position.range_percent || position.range_percent <= 0) {
            return { shouldOptimize: false, reason: 'No current range_percent' };
        }
        
        // Safety 2: Position must be stable (in range for configured time)
        const hoursInRange = stats.time_in_range_ms / (1000 * 60 * 60);
        const minStableHours = config.minStableMinutes / 60;
        
        if (hoursInRange < minStableHours) {
            return { 
                shouldOptimize: false, 
                reason: `Insufficient stability (${(hoursInRange * 60).toFixed(0)}min < ${config.minStableMinutes}min)` 
            };
        }
        
        // Safety 3: Check anti-churn (don't optimize if rebalanced very recently)
        const churnCheck = shouldBlockRebalance(stats, position.id);
        if (churnCheck.shouldBlock) {
            if (churnCheck.hourlyLimitReached) {
                return {
                    shouldOptimize: false,
                    reason: `Hourly limit reached (${churnCheck.recentHourlyCount}/${AUTO_REBALANCE_CONFIG.SAFETY.hourlyChurnLimit})`
                };
            }
            return {
                shouldOptimize: false,
                reason: `Rebalanced too recently (${churnCheck.minutesAgo}min ago)`
            };
        }
        
        // Get market metrics to determine optimal range
        const metrics = await getMarketMetrics_WS();
        
        if (!metrics.atr15 || !metrics.currentPrice) {
            return {
                shouldOptimize: false,
                reason: 'Insufficient market data (ATR unavailable)'
            };
        }
        
        // Determine what the optimal range SHOULD be based on current volatility
        const optimalMode = determineRangeMode(metrics.atr15.atrPercent);
        const optimalWidth = optimalMode.width;
        const currentWidth = position.range_percent;
        
        // Safety 4: Only optimize if gap is significant
        const widthRatio = currentWidth / optimalWidth;
        
        if (widthRatio < config.minWidthRatio) {
            return {
                shouldOptimize: false,
                reason: `Range gap too small (${currentWidth}% / ${optimalWidth}% = ${widthRatio.toFixed(1)}x < ${config.minWidthRatio}x)`
            };
        }
        
        // Safety 5: Position size check
        if (!position.liquidity_usd || position.liquidity_usd < config.minPositionUsd) {
            return {
                shouldOptimize: false,
                reason: `Position too small ($${position.liquidity_usd?.toFixed(2) || 'N/A'} < $${config.minPositionUsd})`
            };
        }
        
        // Safety 6: Cost-benefit analysis
        const rebalanceCost = (position.liquidity_usd * 0.001) + 1; // 0.1% + ~$1 gas
        
        // Calculate expected fee benefit from tighter range
        // Tighter range = higher liquidity density = more fees
        // Conservative estimate: proportional to concentration increase
        const liquidityMultiplier = currentWidth / optimalWidth;
        const dailyFeesEstimate = position.liquidity_usd * 0.005; // 0.5% daily (conservative)
        const additionalDailyFees = dailyFeesEstimate * (liquidityMultiplier - 1);
        
        // Calculate break-even time
        const daysToBreakEven = rebalanceCost / additionalDailyFees;
        
        if (daysToBreakEven > config.maxDaysToBreakEven) {
            return {
                shouldOptimize: false,
                reason: `Break-even too long (${daysToBreakEven.toFixed(1)} days > ${config.maxDaysToBreakEven} days)`
            };
        }
        
        // All checks passed - allow proactive optimization
        const centerPrice = await calculateTWAP_WS(5) || metrics.currentPrice;
        
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✅ Proactive optimization approved: ${currentWidth}% → ${optimalWidth}% (${widthRatio.toFixed(1)}x)`);
            console.log(`      Stable: ${(hoursInRange * 60).toFixed(0)}min | Break-even: ${daysToBreakEven.toFixed(1)} days | $${position.liquidity_usd?.toFixed(0) || 'N/A'}`);
        }
        
        return {
            shouldOptimize: true,
            reason: `Range ${currentWidth}% → ${optimalWidth}% (${widthRatio.toFixed(1)}x narrower, ATR: ${metrics.atr15.atrPercent.toFixed(2)}%)`,
            optimalWidth,
            data: {
                mode: optimalMode.mode,
                rangeWidth: optimalWidth,
                centerPrice,
                currentPrice: metrics.currentPrice,
                atrPercent: metrics.atr15.atrPercent,
                crossbacks: stats.crossbacks_90m || 0,
                oorDurationMinutes: 0, // Not OOR, just optimizing
                optimizationReason: `Proactive tightening (quiet market)`
            }
        };
        
    } catch (error) {
        console.error(`❌ Error in shouldProactivelyOptimizeRange:`, error.message);
        return {
            shouldOptimize: false,
            reason: `Error: ${error.message}`
        };
    }
}

/**
 * Check if position should be rebalanced (main decision engine)
 * 
 * @param {number} positionId - Position database ID
 * @param {boolean} isManual - Whether this is a manual trigger (/rebalance command)
 * @returns {Promise<{ allow: boolean, reason: string, data?: Object }>}
 */
export async function shouldRebalance(positionId, isManual = false) {
    try {
        let decisionMeta = { positionId, isManual };
        
        // Manual triggers always work
        if (isManual) {
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'manual_allow',
                reason: 'Manual rebalance trigger (/rebalance command)'
            });
            return {
                allow: true,
                reason: 'Manual rebalance trigger (/rebalance command)'
            };
        }
        
        // Get position and statistics
        const [positionRows, stats] = await Promise.all([
            db.select().from(positions).where(eq(positions.id, positionId)).limit(1),
            getPositionStatistics(positionId)
        ]);
        
        const position = positionRows?.[0];
        
        decisionMeta = {
            ...decisionMeta,
            nftMint: position?.nft_mint ?? null,
            poolAddress: position?.pool_address ?? null
        };
        
        if (!position) {
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'blocked',
                reason: 'Position not found in database'
            });
            return {
                allow: false,
                reason: 'Position not found in database'
            };
        }
        
        if (!stats) {
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'blocked',
                reason: 'Position statistics not initialized'
            });
            return {
                allow: false,
                reason: 'Position statistics not initialized'
            };
        }
        
        // Manual override protection (Phase 5: New Strategy)
        // If user manually rebalanced to tight range (<1%), respect it while in-range
        if (!isManual && 
            position.last_rebalance_type === 'manual' && 
            position.range_percent != null &&
            position.range_percent < 1.0 && 
            stats.in_range) {
            if (process.env.LOG_LEVEL === 'debug') {
                console.log(`🔒 Position ${positionId} blocked - Manual tight range (<1%) respected while in-range`);
            }
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'blocked_manual_override',
                reason: `Manual tight range (${position.range_percent.toFixed(2)}%) respected while in-range`
            });
            return {
                allow: false,
                reason: `Manual tight range (${position.range_percent.toFixed(2)}%) respected while in-range`
            };
        }
        
        // Safety check: Position too small
        if (position.liquidity_usd && position.liquidity_usd < AUTO_REBALANCE_CONFIG.SAFETY.minPositionValueUsd) {
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'blocked',
                reason: `Position too small ($${position.liquidity_usd.toFixed(2)} < $${AUTO_REBALANCE_CONFIG.SAFETY.minPositionValueUsd})`
            });
            return {
                allow: false,
                reason: `Position too small ($${position.liquidity_usd.toFixed(2)} < $${AUTO_REBALANCE_CONFIG.SAFETY.minPositionValueUsd})`
            };
        }
        
        // Safety check: Insufficient wallet SOL (would need wallet data - skip for now, will be checked before execution)
        
        // Check anti-churn protection
        const churnCheck = shouldBlockRebalance(stats, position.id);
        if (churnCheck.shouldBlock) {
            if (churnCheck.hourlyLimitReached) {
                logAutoRebalanceDecision({
                    ...decisionMeta,
                    status: 'blocked',
                    reason: `Hourly limit reached (${churnCheck.recentHourlyCount}/${AUTO_REBALANCE_CONFIG.SAFETY.hourlyChurnLimit})`
                });
                if (isDebug) console.log(`🛑 Position ${positionId} blocked - Hourly limit reached (${churnCheck.recentHourlyCount}/${AUTO_REBALANCE_CONFIG.SAFETY.hourlyChurnLimit} in last hour)`);
                return {
                    allow: false,
                    reason: `Hourly limit reached (${churnCheck.recentHourlyCount}/${AUTO_REBALANCE_CONFIG.SAFETY.hourlyChurnLimit})`
                };
            } else {
                logAutoRebalanceDecision({
                    ...decisionMeta,
                    status: 'blocked',
                    reason: `Rebalanced too recently (${churnCheck.rebalancesToday} times today, last ${churnCheck.minutesAgo} minutes ago)`
                });
                // Calculate time until 30-minute cooldown expires
                const cooldownExpires = churnCheck.lastRebalanceTime + (30 * 60 * 1000);
                const minutesRemaining = Math.ceil((cooldownExpires - Date.now()) / (60 * 1000));
                
                if (isDebug) console.log(`🛑 Position ${positionId} blocked - Rebalanced too recently (${churnCheck.rebalancesToday} today, last ${churnCheck.minutesAgo}min ago, wait ${minutesRemaining} more min)`);
                return {
                    allow: false,
                    reason: `Rebalanced too recently (${churnCheck.rebalancesToday} times today, last ${churnCheck.minutesAgo} minutes ago)`
                };
            }
        }
        
        // Check daily limit with smart exceptions
        if (stats.rebalances_today >= AUTO_REBALANCE_CONFIG.SAFETY.baseDailyLimit) {
            const bypass = shouldBypassDailyLimit(stats, position);
            
            if (!bypass.bypass) {
                if (isDebug) console.log(`🛑 Position ${positionId} blocked - Rebalanced ${stats.rebalances_today} times today (daily limit reached)`);
                logAutoRebalanceDecision({
                    ...decisionMeta,
                    status: 'blocked',
                    reason: `Rebalanced too many times today (${stats.rebalances_today} times)`
                });
                return {
                    allow: false,
                    reason: `Rebalanced too many times today (${stats.rebalances_today} times)`
                };
            }
            
            if (isDebug) console.log(`⚠️  Position ${positionId} allowing extra rebalance - ${bypass.reason}`);
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'bypass',
                reason: bypass.reason
            });
        }
        
        // Check if position is out of range
        if (stats.in_range) {
            // Position is in range - but check if we should proactively optimize range width
            const proactiveCheck = await shouldProactivelyOptimizeRange(position, stats);
            
            if (proactiveCheck.shouldOptimize) {
                clearForcedModeOverride(position.id);
                if (isDebug) {
                    console.log(`🔧 Position ${positionId} IN RANGE but range too wide - proactive optimization`);
                    console.log(`   Current: ${position.range_percent}% | Optimal: ${proactiveCheck.optimalWidth}%`);
                    console.log(`   Reason: ${proactiveCheck.reason}`);
                }
                
                logAutoRebalanceDecision({
                    ...decisionMeta,
                    status: 'proactive_allow',
                    reason: proactiveCheck.reason,
                    data: proactiveCheck.data
                });
                
                // Allow rebalance with the optimized parameters
                return {
                    allow: true,
                    reason: `Proactive range optimization: ${proactiveCheck.reason}`,
                    data: proactiveCheck.data
                };
            }
            
            // No optimization needed - position is fine as-is
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'in_range',
                reason: 'Position is in range - no rebalance needed'
            });
            return {
                allow: false,
                reason: 'Position is in range - no rebalance needed'
            };
        }
        
        // Position is OOR - check wait period
        if (!stats.current_oor_started_at) {
            // Just went OOR, start tracking
            if (isDebug) console.log(`🔴 Position ${positionId} went out of range - starting wait timer`);
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'waiting',
                reason: 'Just went out of range'
            });
            return {
                allow: false,
                reason: 'Just went out of range'
            };
        }
        
        // Get market metrics to determine mode
        const metrics = await getMarketMetrics_WS();
        
        if (!metrics.atr15 || !metrics.currentPrice) {
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'blocked',
                reason: 'Insufficient market data for decision (ATR or price unavailable)'
            });
            return {
                allow: false,
                reason: 'Insufficient market data for decision (ATR or price unavailable)'
            };
        }
        
        // Determine range mode based on ATR (market volatility, not crossbacks)
        let rangeMode = determineRangeMode(metrics.atr15.atrPercent);
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`📊 ATR-based mode: ${rangeMode.mode} (${rangeMode.width}%) | ATR: ${metrics.atr15.atrPercent.toFixed(2)}%`);
            console.log(`   Thresholds: ${rangeMode.thresholds}`);
        }
        // Apply learned minimum width if available (overrides ATR if wider)
        if (stats.learned_minimum_width && stats.learned_minimum_width > rangeMode.width) {
            const learnedAge = stats.learned_width_updated_at 
                ? Math.floor((Date.now() - new Date(stats.learned_width_updated_at).getTime()) / (1000 * 60))
                : null;
            if (isDebug) {
                console.log(`📚 Learned minimum width: ${stats.learned_minimum_width.toFixed(2)}% (updated ${learnedAge}min ago)`);
                console.log(`   Overriding ATR-based ${rangeMode.width}% → using learned ${stats.learned_minimum_width.toFixed(2)}%`);
            }
            rangeMode.width = stats.learned_minimum_width;
        }
        
        // Forced mode overrides (frequency-based with cooldown)
        const rebalancesToday = stats.rebalances_today || 0;
        const safetyConfig = AUTO_REBALANCE_CONFIG.SAFETY;
        const forcedModeCooldownMinutes = safetyConfig?.forcedModeCooldownMinutes ?? 45;
        const forceNormalThreshold = safetyConfig?.forceNormalDailyThreshold ?? 6;
        const forceWideThreshold = safetyConfig?.forceWideDailyThreshold ?? 10;
        const minutesSinceRebalance = stats.last_rebalance_at
            ? Math.floor((Date.now() - new Date(stats.last_rebalance_at).getTime()) / (60 * 1000))
            : Infinity;
        const withinForcedCooldown = minutesSinceRebalance <= forcedModeCooldownMinutes;
        
        let forcedModeApplied = null;
        const activeForcedMode = getForcedModeOverride(position.id);
        if (activeForcedMode) {
            const forcedModeConfig = AUTO_REBALANCE_CONFIG.RANGE_MODES[activeForcedMode.mode];
            if (forcedModeConfig) {
                // Use max width for forced modes (defensive positioning)
                const forcedWidth = forcedModeConfig.maxWidth;
                rangeMode = {
                    mode: activeForcedMode.mode,
                    width: forcedWidth,
                    baseWaitMinutes: forcedModeConfig.baseWaitMinutes,
                    maxWaitMinutes: forcedModeConfig.maxWaitMinutes
                };
                forcedModeApplied = activeForcedMode.mode;
                if (isDebug) console.log(`🔒 Forced mode override active: ${activeForcedMode.mode} (expires ${new Date(activeForcedMode.expiresAt).toISOString()})`);
            } else {
                clearForcedModeOverride(position.id);
            }
        } else if (withinForcedCooldown && rebalancesToday >= forceWideThreshold) {
            const forced = AUTO_REBALANCE_CONFIG.RANGE_MODES.WIDE;
            if (forced) {
                // Use max width for WIDE mode (defensive)
                rangeMode = {
                    mode: 'WIDE',
                    width: forced.maxWidth,
                    baseWaitMinutes: forced.baseWaitMinutes,
                    maxWaitMinutes: forced.maxWaitMinutes
                };
                forcedModeApplied = 'WIDE';
                setForcedModeOverride(position.id, 'WIDE', forcedModeCooldownMinutes);
                if (isDebug) console.log(`⚠️  High rebalance frequency (${rebalancesToday} today) - forcing ATR mode → WIDE for ${forcedModeCooldownMinutes} minutes`);
            }
        } else if (withinForcedCooldown && rebalancesToday >= forceNormalThreshold && rangeMode.mode === 'TIGHT') {
            const forced = AUTO_REBALANCE_CONFIG.RANGE_MODES.NORMAL;
            if (forced) {
                // Use max width for NORMAL mode (defensive)
                rangeMode = {
                    mode: 'NORMAL',
                    width: forced.maxWidth,
                    baseWaitMinutes: forced.baseWaitMinutes,
                    maxWaitMinutes: forced.maxWaitMinutes
                };
                forcedModeApplied = 'NORMAL';
                setForcedModeOverride(position.id, 'NORMAL', forcedModeCooldownMinutes);
                if (isDebug) console.log(`⚠️  Elevated rebalance frequency (${rebalancesToday} today) - forcing TIGHT → NORMAL for ${forcedModeCooldownMinutes} minutes`);
            }
        } else if (rebalancesToday > 0 && isDebug) {
            console.log(`📈 Rebalance frequency: ${rebalancesToday} today (thresholds: ${forceNormalThreshold}/${forceWideThreshold}) - keeping ${rangeMode.mode} mode`);
        }
        
        // Get crossback count for wait time adjustment
        const crossbacks = stats.crossbacks_90m || 0;
        
        // Calculate wait time with crossback-based adjustments
        // High crossbacks = rebalance faster to stop thrashing
        const waitTimeMs = calculateWaitTime(rangeMode.mode, stats);
        const oorStartTime = new Date(stats.current_oor_started_at).getTime();
        const timeOorMs = Date.now() - oorStartTime;
        const timeOorHours = timeOorMs / (1000 * 60 * 60);
        
        // Safety check: If position has been OOR for >2 hours total, rebalance regardless of wait time
        // This prevents extremely choppy markets from never rebalancing
        if (timeOorHours > 2) {
            if (isDebug) console.log(`⚠️  Position ${positionId} out of range for ${timeOorHours.toFixed(1)} hours - rebalancing now`);
        } else if (timeOorMs < waitTimeMs) {
            const remainingMinutes = Math.ceil((waitTimeMs - timeOorMs) / (1000 * 60));
            const oorMinutes = Math.floor(timeOorMs / (1000 * 60));
            logAutoRebalanceDecision({
                ...decisionMeta,
                status: 'waiting',
                reason: `Waiting ${remainingMinutes} more minutes before rebalancing`,
                data: {
                    mode: rangeMode.mode,
                    waitMinutesRemaining: remainingMinutes,
                    timeOutOfRangeMinutes: oorMinutes
                }
            });
            return {
                allow: false,
                reason: `Waiting ${remainingMinutes} more minutes before rebalancing`
            };
        }
        
        // IL PROFITABILITY CHECK (Phase 2: New Strategy)
        // Only rebalance if: Expected Fees > IL Cost + Tx Cost + 50% margin
        if (!isManual && !stats.in_range) {
            try {
                // Fetch current token holdings and position data
                const connection = createSolanaConnection();
                const rangeData = await fetchPositionRangeData(connection, position.personal_position_pda);
                
                // For out-of-range positions being rebalanced to centered positions,
                // the target optimal ratio is approximately 50/50 in USD terms
                const optimalToken0Percent = 0.5;
                const rangeDataWithOptimal = {
                    ...rangeData,
                    optimalToken0Percent
                };
                
                const profitCheck = await isRebalanceProfitable(position, rangeDataWithOptimal);
                
                if (!profitCheck.profitable) {
                    if (isDebug) console.log(`🚫 Position ${positionId} blocked - ${profitCheck.reason}`);
                    logAutoRebalanceDecision({
                        ...decisionMeta,
                        status: 'blocked_unprofitable',
                        reason: profitCheck.reason,
                        data: {
                            breakEvenRatio: profitCheck.breakEvenRatio,
                            estimatedIL: profitCheck.estimatedIL,
                            estimatedCosts: profitCheck.estimatedCosts,
                            expectedFees: profitCheck.expectedFees,
                            netProfit: profitCheck.netProfit
                        }
                    });
                    
                    return {
                        allow: false,
                        reason: profitCheck.reason,
                        data: profitCheck
                    };
                }
                
                // Rebalance is profitable - log decision
                if (isDebug) console.log(`💰 Position ${positionId} profitable - ${profitCheck.reason}`);
                logAutoRebalanceDecision({
                    ...decisionMeta,
                    status: 'il_check_passed',
                    reason: profitCheck.reason,
                    data: {
                        breakEvenRatio: profitCheck.breakEvenRatio,
                        estimatedIL: profitCheck.estimatedIL,
                        estimatedCosts: profitCheck.estimatedCosts,
                        expectedFees: profitCheck.expectedFees,
                        netProfit: profitCheck.netProfit
                    }
                });
            } catch (error) {
                console.warn(`⚠️  IL profitability check failed: ${error.message}`);
                console.warn(`   Continuing with rebalance (IL check optional)`);
                // Don't block rebalance if IL check fails - treat as passed
            }
        }
        
        // All checks passed - allow rebalance
        // Fetch pool metrics for fee APR (for optimization)
        let poolFeeApr = null;
        try {
            const aprData = await calculateCompleteApr({
                poolId: position.pool_address,
                inRange: stats.in_range,
                positionLiquidity: position.liquidity,
                poolLiquidity: position.pool_liquidity,
                positionValueUsd: position.liquidity_usd
            });
            poolFeeApr = aprData.feeApr;
        } catch (error) {
            console.warn(`⚠️  Could not fetch pool fee APR: ${error.message}`);
            // Continue without fee APR (optimization will use base width)
        }
        
        // Calculate optimal range width with adaptive optimization
        const tickSpacing = await getPoolTickSpacing(position.pool_address);
        if (!tickSpacing) {
            console.warn(`⚠️  Tick spacing unavailable for pool ${position.pool_address} - using unquantized width`);
        }
        
        const optimization = await calculateOptimizedWidth(
            rangeMode.width, 
            stats, 
            position, 
            metrics.atr15.atrPercent,
            poolFeeApr,
            tickSpacing || null
        );
        
        const optimalWidth = optimization.width;
        
        // Log optimization decision
        if (isDebug) {
            if (optimization.width !== rangeMode.width) {
                console.log(`📐 Position ${positionId} - Range optimized: ${rangeMode.width}% → ${optimization.width}% (${optimization.reason})`);
            } else {
                console.log(`📐 Position ${positionId} - Range unchanged: ${rangeMode.width}% (${optimization.reason})`);
            }
        }
        
        // Get center price (TWAP_5m)
        const centerPrice = await calculateTWAP_WS(5) || metrics.currentPrice;
        
        if (isDebug) console.log(`✅ Position ${positionId} READY - Rebalancing with ${rangeMode.mode} mode (±${optimalWidth}%)`);
        logAutoRebalanceDecision({
            ...decisionMeta,
            status: 'allow',
            reason: 'All conditions met for auto-rebalance',
            data: {
                mode: rangeMode.mode,
                rangeWidth: optimalWidth,
                centerPrice,
                atrPercent: metrics.atr15.atrPercent,
                crossbacks,
                oorDurationMinutes: Math.floor(timeOorMs / (1000 * 60)),
                optimizationReason: optimization.reason,
                forcedMode: forcedModeApplied
            }
        });
        
        return {
            allow: true,
            reason: 'All conditions met for auto-rebalance',
            data: {
                mode: rangeMode.mode,
                rangeWidth: optimalWidth,
                centerPrice,
                currentPrice: metrics.currentPrice,
                atrPercent: metrics.atr15.atrPercent,
                crossbacks: crossbacks,
                oorDurationMinutes: Math.floor(timeOorMs / (1000 * 60)),
                optimizationReason: optimization.reason,
                forcedMode: forcedModeApplied
            }
        };
        
    } catch (error) {
        console.error('❌ Error in shouldRebalance:', error.message);
        logAutoRebalanceDecision({
            positionId,
            isManual,
            status: 'error',
            reason: error.message
        });
        return {
            allow: false,
            reason: `Error: ${error.message}`
        };
    }
}

/**
 * Check all active positions for auto-rebalance opportunities
 * 
 * Only checks positions where auto_rebalance_enabled = true
 * 
 * @returns {Promise<Array<{ positionId: number, decision: Object }>>}
 */
export async function checkAllPositionsForRebalance() {
    try {
        // Get all active positions with auto-rebalance enabled
        const activePositions = await db.select()
            .from(positions)
            .where(eq(positions.status, 'active'));
        
        if (!activePositions || activePositions.length === 0) {
            return [];
        }
        
        // Filter to only positions with auto-rebalance enabled
        const eligiblePositions = activePositions.filter(pos => pos.auto_rebalance_enabled);
        
        if (eligiblePositions.length === 0) {
            // No positions have auto-rebalance enabled (silent - not worth logging every 30s)
            return [];
        }
        
        // Fetch current market metrics to show in summary
        const metrics = await getMarketMetrics_WS();
        const atrValue = metrics.atr15?.atrPercent || null;
        const currentMode = atrValue ? determineRangeMode(atrValue) : null;
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`\n🔍 Auto-Rebalance Check (${eligiblePositions.length} position(s))`);
        }
        
        if (atrValue && currentMode && process.env.LOG_LEVEL === 'debug') {
            console.log(`📊 Market: SOL $${metrics.currentPrice?.toFixed(2) || 'N/A'} | ATR: ${atrValue.toFixed(2)}% → ${currentMode.mode} mode (${currentMode.width}%)`);
        }
        
        const results = [];
        
        for (const position of eligiblePositions) {
            const decision = await shouldRebalance(position.id, false);
            
            if (decision.allow) {
                results.push({
                    positionId: position.id,
                    nftMint: position.nft_mint,
                    poolAddress: position.pool_address,
                    decision
                });
                // Already logged in shouldRebalance function
            } else {
                // Skip logging - already logged in shouldRebalance if important
            }
        }
        
        if (results.length > 0 && isDebug) {
            console.log(`\n🚀 Rebalancing ${results.length} position(s)...\n`);
        } 
        
        return results;
        
    } catch (error) {
        console.error('❌ Error checking positions for rebalance:', error.message);
        return [];
    }
}

/**
 * Format currency for console output
 * @param {number} value 
 * @returns {string}
 */
function formatCurrency(value) {
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

