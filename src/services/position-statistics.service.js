// src/services/position-statistics.service.js

import { db } from '../db/index.js';
import { position_statistics, positions, position_apr_history } from '../db/schema.js';
import { eq, sql, and, gte, desc } from 'drizzle-orm';

/**
 * Record a crossback event and learn from the width that failed
 * Maintains a sliding window of recent crossback widths to calculate learned minimum
 * 
 * @param {number} positionId 
 * @param {Object} stats - Current position statistics
 */
async function recordCrossbackWidth(positionId, stats) {
    try {
        // Get the position to find current range width
        const positionRows = await db.select()
            .from(positions)
            .where(eq(positions.id, positionId))
            .limit(1);
        
        if (!positionRows || positionRows.length === 0) {
            return;
        }
        
        const position = positionRows[0];
        const currentWidth = position.range_percent;
        
        if (!currentWidth || currentWidth <= 0) {
            return;
        }
        
        // Parse existing crossback history (keep last 10 for learning)
        const MAX_CROSSBACK_HISTORY = 10;
        let crossbackHistory = [];
        
        if (stats.recent_crossback_widths) {
            try {
                crossbackHistory = JSON.parse(stats.recent_crossback_widths);
            } catch (e) {
                console.warn(`⚠️  Failed to parse crossback history for position ${positionId}:`, e.message);
            }
        }
        
        // Add current width + timestamp
        const now = Date.now();
        crossbackHistory.push([currentWidth, now]);
        
        // Keep only recent entries (last 10)
        if (crossbackHistory.length > MAX_CROSSBACK_HISTORY) {
            crossbackHistory = crossbackHistory.slice(-MAX_CROSSBACK_HISTORY);
        }
        
        // Calculate learned minimum: 95th percentile of failed widths + 20% safety margin
        // This ensures we pick a width wider than 95% of historical failures
        const sortedWidths = crossbackHistory.map(([w]) => w).sort((a, b) => a - b);
        const p95Index = Math.floor(sortedWidths.length * 0.95);
        const p95Width = sortedWidths[p95Index] || sortedWidths[sortedWidths.length - 1];
        const learnedMinimum = p95Width * 1.2; // Add 20% safety margin
        
        // Update statistics
        await db.update(position_statistics)
            .set({
                recent_crossback_widths: JSON.stringify(crossbackHistory),
                learned_minimum_width: learnedMinimum,
                learned_width_updated_at: new Date()
            })
            .where(eq(position_statistics.position_id, positionId));
        
    } catch (error) {
        console.error(`❌ Error recording crossback width for position ${positionId}:`, error.message);
    }
}

/**
 * Initialize statistics for a new position
 * 
 * @param {number} positionId - Position database ID
 * @param {number} initialUsdValue - Initial position value in USD
 * @param {number|null} solPriceAtOpen - SOL/USD price when position was opened (for P/L calculation)
 */
export async function initializePositionStatistics(positionId, initialUsdValue, solPriceAtOpen = null) {
    const result = await db.insert(position_statistics)
        .values({
            position_id: positionId,
            usd_value_on_open: initialUsdValue,
            sol_price_at_open: solPriceAtOpen,
            first_monitored_at: new Date(),
            current_mode: 'TIGHT',
            active_width_pct: 0.6,
            guard_width_pct: 0.9
        })
        .returning();
    
    return result[0];
}

/**
 * Update time tracking when price moves out of range
 */
export async function markOutOfRange(positionId) {
    const stats = await getPositionStatistics(positionId);
    
    if (!stats) {
        // console.warn(`⚠️ No statistics found for position ${positionId}, skipping OOR tracking`);
        return;
    }
    
    const now = new Date();
    const updates = {
        in_range: false,
        last_price_check_at: now,
        updated_at: now
    };
    
    // Only set current_oor_started_at if position wasn't already OOR
    // This preserves the original timestamp so wait times work correctly
    if (stats.in_range || !stats.current_oor_started_at) {
        updates.current_oor_started_at = now;
    }
    
    // Don't increment crossback if already out of range
    // (crossback is only when moving FROM in-range TO out-of-range)
    
    await db.update(position_statistics)
        .set(updates)
        .where(eq(position_statistics.position_id, positionId));
}

/**
 * Update time tracking when price moves back into range
 * Records crossback event (re-entry into range after being OOR)
 * 
 * Grace Period Logic:
 * - If position was only briefly OOR (< 2 min), keep the OOR timer running
 * - This prevents choppy markets from constantly resetting the rebalance timer
 * - Timer only resets if position stays in range for meaningful period
 */
export async function markBackInRange(positionId) {
    const stats = await getPositionStatistics(positionId);
    
    if (!stats) {
        // console.warn(`⚠️ No statistics found for position ${positionId}, skipping back-in-range tracking`);
        return;
    }
    
    const now = new Date();
    const updates = {
        in_range: true,
        last_price_check_at: now,
        updated_at: now
    };
    
    // Grace period: Only clear OOR timer if position was OOR for long enough
    // If position bounces in/out quickly (< 2 min OOR), keep the original timer
    const GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes
    const shouldKeepTimer = stats.current_oor_started_at && 
                           (now.getTime() - new Date(stats.current_oor_started_at).getTime()) < GRACE_PERIOD_MS;
    
    if (shouldKeepTimer) {
        // Position bounced back quickly - keep OOR timer running
        // Don't clear current_oor_started_at
    } else {
        // Position was OOR long enough, or never was OOR - clear the timer
        updates.current_oor_started_at = null;
    }
    
    // If was out of range, record the crossback (re-entry)
    if (!stats.in_range) {
        updates.crossbacks_90m = stats.crossbacks_90m + 1;
        updates.last_crossback_at = now;
        
        // Learn from this crossback: record the width that failed
        await recordCrossbackWidth(positionId, stats);
    }
    
    await db.update(position_statistics)
        .set(updates)
        .where(eq(position_statistics.position_id, positionId));
}

/**
 * Update accumulated time metrics (call every monitoring cycle)
 */
export async function updateAccumulatedTime(positionId, elapsedMs, currentlyInRange) {
    // Verify stats row exists first
    const stats = await getPositionStatistics(positionId);
    if (!stats) {
        // console.warn(`⚠️ No statistics row for position ${positionId}, skipping time accumulation`);
        return;
    }
    
    const updates = {
        last_price_check_at: new Date(),
        updated_at: new Date()
    };
    
    if (currentlyInRange) {
        updates.time_in_range_ms = sql`${position_statistics.time_in_range_ms} + ${elapsedMs}`;
    } else {
        updates.time_out_of_range_ms = sql`${position_statistics.time_out_of_range_ms} + ${elapsedMs}`;
    }
    
    // Expire crossbacks older than 90 minutes
    if (stats.last_crossback_at) {
        const minutesSinceLastCrossback = (Date.now() - new Date(stats.last_crossback_at).getTime()) / (1000 * 60);
        if (minutesSinceLastCrossback > 90) {
            // Reset crossbacks if last one was over 90 minutes ago
            updates.crossbacks_90m = 0;
        }
    }
    
    const result = await db.update(position_statistics)
        .set(updates)
        .where(eq(position_statistics.position_id, positionId))
        .returning();
    
    if (!result || result.length === 0) {
        console.error(`❌ Failed to update statistics for position ${positionId} - row not found or update failed`);
    }
}

/**
 * Increment rebalance counter (Section 5 safety rails)
 */
export async function recordRebalance(positionId, costUsd) {
    
    await db.update(position_statistics)
        .set({
            last_rebalance_at: new Date(),
            rebalances_count_lifetime: sql`${position_statistics.rebalances_count_lifetime} + 1`,
            rebalances_today: sql`${position_statistics.rebalances_today} + 1`,
            last_rebalance_cost_usd: costUsd,
            total_rebalance_cost_usd: sql`${position_statistics.total_rebalance_cost_usd} + ${costUsd}`,
            updated_at: new Date()
        })
        .where(eq(position_statistics.position_id, positionId));
}

/**
 * Record claimed rewards
 * 
 * @param {number} positionId
 * @param {number} claimedUsd - Total USD value of claimed rewards
 */
export async function recordClaim(positionId, claimedUsd) {
    await db.update(position_statistics)
        .set({
            total_claimed_usd: sql`${position_statistics.total_claimed_usd} + ${claimedUsd}`,
            total_fees_earned_usd: sql`${position_statistics.total_fees_earned_usd} + ${claimedUsd}`,
            updated_at: new Date()
        })
        .where(eq(position_statistics.position_id, positionId));
}

/**
 * Record rebalance P/L from worth tracking system
 * 
 * @param {number} positionId - Position ID
 * @param {number} plUsd - P/L in USD (negative = loss, positive = gain)
 */
export async function recordRebalancePL(positionId, plUsd) {
    await db.update(position_statistics)
        .set({
            cumulative_rebalance_pl_usd: sql`${position_statistics.cumulative_rebalance_pl_usd} + ${plUsd}`,
            last_rebalance_pl_usd: plUsd,
            updated_at: new Date()
        })
        .where(eq(position_statistics.position_id, positionId));
}

/**
 * Record compounded value
 * 
 * @param {number} positionId
 * @param {number} compoundedUsd - Total USD value compounded back into position
 */
export async function recordCompound(positionId, compoundedUsd) {
    
    await db.update(position_statistics)
        .set({
            total_compounded_usd: sql`${position_statistics.total_compounded_usd} + ${compoundedUsd}`,
            updated_at: new Date()
        })
        .where(eq(position_statistics.position_id, positionId));
}

/**
 * Record claim transaction fee
 * 
 * @param {number} positionId
 * @param {number} feeSol - Transaction fee in SOL
 */
export async function recordClaimFee(positionId, feeSol) {
    await db.update(position_statistics)
        .set({
            total_claim_fees_sol: sql`${position_statistics.total_claim_fees_sol} + ${feeSol}`,
            last_claim_fee_sol: feeSol,
            claim_transactions_count: sql`${position_statistics.claim_transactions_count} + 1`,
            updated_at: new Date()
        })
        .where(eq(position_statistics.position_id, positionId));
}

/**
 * Record compound transaction fees (includes claim, swaps, and add liquidity)
 * 
 * @param {number} positionId
 * @param {number} totalFeeSol - Total transaction fees in SOL for entire compound operation
 */
export async function recordCompoundFees(positionId, totalFeeSol) {
    console.log(`📊 Recording compound fees for position ${positionId}: ${totalFeeSol.toFixed(6)} SOL`);
    
    await db.update(position_statistics)
        .set({
            total_compound_fees_sol: sql`${position_statistics.total_compound_fees_sol} + ${totalFeeSol}`,
            last_compound_fee_sol: totalFeeSol,
            compound_transactions_count: sql`${position_statistics.compound_transactions_count} + 1`,
            updated_at: new Date()
        })
        .where(eq(position_statistics.position_id, positionId));
}

/**
 * Reset daily counter at UTC midnight (Section 5)
 */
export async function resetDailyCounters() {
    const now = new Date();
    
    await db.update(position_statistics)
        .set({
            rebalances_today: 0,
            daily_reset_at: now,
            updated_at: now
        });
}

/**
 * Carry over statistics from old position to new position (used during rebalance)
 * 
 * This is CRITICAL for maintaining continuity of metrics across rebalances.
 * Without this, daily caps, time tracking, and PnL would reset on every rebalance!
 * 
 * @param {number} oldPositionId - Old position ID (being closed)
 * @param {number} newPositionId - New position ID (just opened)
 * @returns {Promise<void>}
 */
export async function carryOverStatistics(oldPositionId, newPositionId) {
    console.log(`📊 Carrying over statistics from position ${oldPositionId} → ${newPositionId}`);
    
    const oldStats = await getPositionStatistics(oldPositionId);
    const newStats = await getPositionStatistics(newPositionId);
    
    if (!oldStats) {
        console.warn(`⚠️ No old statistics found for position ${oldPositionId}, cannot carry over`);
        return;
    }
    
    if (!newStats) {
        console.error(`❌ No new statistics found for position ${newPositionId}, cannot carry over`);
        return;
    }
    
    // Carry over all cumulative metrics
    await db.update(position_statistics)
        .set({
            // Keep time tracking from old position
            time_in_range_ms: oldStats.time_in_range_ms,
            time_out_of_range_ms: oldStats.time_out_of_range_ms,
            
            // Keep rebalance history
            rebalances_count_lifetime: oldStats.rebalances_count_lifetime,
            rebalances_today: oldStats.rebalances_today,
            last_rebalance_at: oldStats.last_rebalance_at,
            
            // Keep crossback history
            crossbacks_90m: oldStats.crossbacks_90m,
            last_crossback_at: oldStats.last_crossback_at,
            
            // Keep mode state
            current_mode: oldStats.current_mode,
            mode_changed_at: oldStats.mode_changed_at,
            active_width_pct: oldStats.active_width_pct,
            guard_width_pct: oldStats.guard_width_pct,
            
            // Keep financial tracking (CRITICAL for PnL)
            total_claimed_usd: oldStats.total_claimed_usd,
            total_compounded_usd: oldStats.total_compounded_usd,
            total_fees_earned_usd: oldStats.total_fees_earned_usd,
            total_rebalance_cost_usd: oldStats.total_rebalance_cost_usd,
            last_rebalance_cost_usd: oldStats.last_rebalance_cost_usd,
            cumulative_rebalance_pl_usd: oldStats.cumulative_rebalance_pl_usd,
            last_rebalance_pl_usd: oldStats.last_rebalance_pl_usd,
            
            // Preserve original position tracking (CRITICAL for lifetime P/L)
            usd_value_on_open: oldStats.usd_value_on_open,
            sol_price_at_open: oldStats.sol_price_at_open,
            
            // Keep performance metrics
            net_pnl_usd: oldStats.net_pnl_usd,
            roi_percent: oldStats.roi_percent,
            time_in_range_percent: oldStats.time_in_range_percent,
            
            // Reset current OOR episode (new position starts fresh)
            current_oor_started_at: null,
            in_range: true, // Assume new position starts in range
            
            // Keep original monitoring start time
            first_monitored_at: oldStats.first_monitored_at,
            
            // Keep daily reset timestamp
            daily_reset_at: oldStats.daily_reset_at,
            
            updated_at: new Date()
        })
        .where(eq(position_statistics.position_id, newPositionId));
    
    // Also carry over APR history
    await carryOverAprHistory(oldPositionId, newPositionId);
    
    console.log(`✅ Statistics carried over successfully (maintained continuity across rebalance)`);
}

/**
 * Get statistics for a position
 */
export async function getPositionStatistics(positionId) {
    const result = await db.select()
        .from(position_statistics)
        .where(eq(position_statistics.position_id, positionId))
        .limit(1);
    
    return result[0] || null;
}

/**
 * Calculate derived metrics (time_in_range_percent, net_pnl_usd, roi_percent)
 * These are computed from stored values and optionally written back to DB
 * 
 * @param {number} positionId
 * @param {boolean} updateDb - Whether to write calculated values back to database
 * @returns {Promise<{time_in_range_percent: number|null, net_pnl_usd: number, roi_percent: number|null}>}
 */
export async function calculateDerivedMetrics(positionId, updateDb = false) {
    const stats = await getPositionStatistics(positionId);
    
    if (!stats) {
        return { time_in_range_percent: null, net_pnl_usd: 0, roi_percent: null };
    }
    
    // Calculate time in range percentage
    const totalTime = stats.time_in_range_ms + stats.time_out_of_range_ms;
    const time_in_range_percent = totalTime > 0 
        ? (stats.time_in_range_ms / totalTime) * 100 
        : null;
    
    // Calculate total transaction fees in USD (estimate using SOL price if available)
    // For now, we'll store SOL fees and convert to USD in the dashboard
    const total_transaction_fees_usd = stats.total_transaction_fees_usd || 0;
    
    // Calculate net PnL (fees + compounds - costs - transaction fees)
    const net_pnl_usd = (stats.total_fees_earned_usd + stats.total_compounded_usd) - 
                        stats.total_rebalance_cost_usd - total_transaction_fees_usd;
    
    // Calculate ROI percentage
    const roi_percent = stats.usd_value_on_open > 0 
        ? (net_pnl_usd / stats.usd_value_on_open) * 100 
        : null;
    
    // Optionally update database
    if (updateDb) {
        await db.update(position_statistics)
            .set({
                time_in_range_percent,
                net_pnl_usd,
                roi_percent,
                updated_at: new Date()
            })
            .where(eq(position_statistics.position_id, positionId));
    }
    
    return {
        time_in_range_percent,
        net_pnl_usd,
        roi_percent
    };
}

/**
 * Get statistics with calculated derived metrics (doesn't update DB)
 * Use this when displaying statistics to users
 * 
 * @param {number} positionId
 * @returns {Promise<Object|null>} Statistics with calculated fields
 */
export async function getPositionStatisticsWithMetrics(positionId) {
    const stats = await getPositionStatistics(positionId);
    
    if (!stats) {
        return null;
    }
    
    // Calculate derived metrics on-the-fly
    const derived = await calculateDerivedMetrics(positionId, false);
    
    // Return stats with calculated fields
    return {
        ...stats,
        ...derived
    };
}

// ============================================================================
// APR HISTORY TRACKING
// ============================================================================

/**
 * Record an APR snapshot for a position
 * Should be called periodically (every ~4 hours) to build history for averages
 * 
 * @param {number} positionId - Position database ID
 * @param {Object} aprData - APR data from calculateCompleteApr()
 * @param {number|null} aprData.positionApr - Position-specific APR percentage
 * @param {number|null} aprData.poolApr - Pool baseline APR percentage
 * @param {boolean} inRange - Whether position is currently in range
 * @param {number|null} positionValueUsd - Current position value in USD
 * @param {number|null} rangePercent - Position range width percentage (e.g., 0.6 for ±0.6%)
 */
export async function recordAprSnapshot(positionId, aprData, inRange, positionValueUsd, rangePercent = null) {
    try {
        await db.insert(position_apr_history)
            .values({
                position_id: positionId,
                recorded_at: new Date(),
                position_apr: aprData?.positionApr ?? null,
                pool_apr: aprData?.poolApr ?? null,
                in_range: inRange,
                position_value_usd: positionValueUsd ?? null,
                range_percent: rangePercent ?? null
            });
    } catch (error) {
        console.error(`❌ Failed to record APR snapshot for position ${positionId}:`, error.message);
    }
}

/**
 * Get average APR for a position over a time period
 * Only considers snapshots where position was in range (APR = 0 when out of range)
 * 
 * @param {number} positionId - Position database ID
 * @param {number} hoursBack - How many hours of history to consider
 * @returns {Promise<{avgPositionApr: number|null, avgPoolApr: number|null, avgRangePercent: number|null, sampleCount: number, inRangePercent: number|null}>}
 */
export async function getAverageApr(positionId, hoursBack) {
    try {
        const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
        
        const snapshots = await db.select()
            .from(position_apr_history)
            .where(and(
                eq(position_apr_history.position_id, positionId),
                gte(position_apr_history.recorded_at, cutoffTime)
            ))
            .orderBy(desc(position_apr_history.recorded_at));
        
        if (!snapshots || snapshots.length === 0) {
            return { avgPositionApr: null, avgPoolApr: null, avgRangePercent: null, sampleCount: 0, inRangePercent: null };
        }
        
        // Calculate averages (include all snapshots, APR is 0 when out of range)
        let positionAprSum = 0;
        let poolAprSum = 0;
        let rangePercentSum = 0;
        let positionAprCount = 0;
        let poolAprCount = 0;
        let rangePercentCount = 0;
        let inRangeCount = 0;
        
        for (const snapshot of snapshots) {
            // For position APR: use actual value (already 0 when out of range)
            if (snapshot.position_apr != null) {
                positionAprSum += snapshot.position_apr;
                positionAprCount++;
            }
            
            // For pool APR: use actual value regardless of range
            if (snapshot.pool_apr != null) {
                poolAprSum += snapshot.pool_apr;
                poolAprCount++;
            }
            
            // For range percent: track average range width
            if (snapshot.range_percent != null) {
                rangePercentSum += snapshot.range_percent;
                rangePercentCount++;
            }
            
            if (snapshot.in_range) {
                inRangeCount++;
            }
        }
        
        const avgPositionApr = positionAprCount > 0 ? positionAprSum / positionAprCount : null;
        const avgPoolApr = poolAprCount > 0 ? poolAprSum / poolAprCount : null;
        const avgRangePercent = rangePercentCount > 0 ? rangePercentSum / rangePercentCount : null;
        const inRangePercent = snapshots.length > 0 ? (inRangeCount / snapshots.length) * 100 : null;
        
        return {
            avgPositionApr,
            avgPoolApr,
            avgRangePercent,
            sampleCount: snapshots.length,
            inRangePercent
        };
    } catch (error) {
        console.error(`❌ Failed to get average APR for position ${positionId}:`, error.message);
        return { avgPositionApr: null, avgPoolApr: null, avgRangePercent: null, sampleCount: 0, inRangePercent: null };
    }
}

/**
 * Get daily average APR (last 24 hours)
 * 
 * @param {number} positionId
 * @returns {Promise<{avgPositionApr: number|null, avgPoolApr: number|null, sampleCount: number}>}
 */
export async function getDailyAverageApr(positionId) {
    return getAverageApr(positionId, 24);
}

/**
 * Get monthly average APR (last 30 days)
 * 
 * @param {number} positionId
 * @returns {Promise<{avgPositionApr: number|null, avgPoolApr: number|null, sampleCount: number}>}
 */
export async function getMonthlyAverageApr(positionId) {
    return getAverageApr(positionId, 30 * 24); // 30 days
}

/**
 * Get lifetime average APR (all time - all available data)
 * 
 * @param {number} positionId
 * @returns {Promise<{avgPositionApr: number|null, avgPoolApr: number|null, avgRangePercent: number|null, sampleCount: number, inRangePercent: number|null, totalDays: number}>}
 */
export async function getLifetimeAverageApr(positionId) {
    try {
        const snapshots = await db.select()
            .from(position_apr_history)
            .where(eq(position_apr_history.position_id, positionId))
            .orderBy(desc(position_apr_history.recorded_at));
        
        if (!snapshots || snapshots.length === 0) {
            return { avgPositionApr: null, avgPoolApr: null, avgRangePercent: null, sampleCount: 0, inRangePercent: null, totalDays: 0 };
        }
        
        // Calculate averages (include all snapshots, APR is 0 when out of range)
        let positionAprSum = 0;
        let poolAprSum = 0;
        let rangePercentSum = 0;
        let positionAprCount = 0;
        let poolAprCount = 0;
        let rangePercentCount = 0;
        let inRangeCount = 0;
        
        for (const snapshot of snapshots) {
            // For position APR: use actual value (already 0 when out of range)
            if (snapshot.position_apr != null) {
                positionAprSum += snapshot.position_apr;
                positionAprCount++;
            }
            
            // For pool APR: use actual value regardless of range
            if (snapshot.pool_apr != null) {
                poolAprSum += snapshot.pool_apr;
                poolAprCount++;
            }
            
            // For range percent: track average range width
            if (snapshot.range_percent != null) {
                rangePercentSum += snapshot.range_percent;
                rangePercentCount++;
            }
            
            if (snapshot.in_range) {
                inRangeCount++;
            }
        }
        
        const avgPositionApr = positionAprCount > 0 ? positionAprSum / positionAprCount : null;
        const avgPoolApr = poolAprCount > 0 ? poolAprSum / poolAprCount : null;
        const avgRangePercent = rangePercentCount > 0 ? rangePercentSum / rangePercentCount : null;
        const inRangePercent = snapshots.length > 0 ? (inRangeCount / snapshots.length) * 100 : null;
        
        // Calculate total days from oldest to newest snapshot
        const oldestSnapshot = snapshots[snapshots.length - 1];
        const newestSnapshot = snapshots[0];
        const totalDays = Math.ceil((new Date(newestSnapshot.recorded_at) - new Date(oldestSnapshot.recorded_at)) / (1000 * 60 * 60 * 24));
        
        return {
            avgPositionApr,
            avgPoolApr,
            avgRangePercent,
            sampleCount: snapshots.length,
            inRangePercent,
            totalDays: Math.max(1, totalDays) // At least 1 day
        };
    } catch (error) {
        console.error(`❌ Failed to get lifetime average APR for position ${positionId}:`, error.message);
        return { avgPositionApr: null, avgPoolApr: null, avgRangePercent: null, sampleCount: 0, inRangePercent: null, totalDays: 0 };
    }
}

/**
 * Clean up old APR history records (retention: 400 days)
 * Should be called periodically (e.g., once per day)
 */
export async function cleanupOldAprHistory() {
    try {
        const RETENTION_DAYS = 400;
        // Convert to Unix timestamp in seconds (SQLite stores timestamps as integers)
        const cutoffTimestamp = Math.floor((Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000);
        
        const result = await db.delete(position_apr_history)
            .where(sql`${position_apr_history.recorded_at} < ${cutoffTimestamp}`);
        
        console.log(`🧹 APR history cleanup: removed records older than ${RETENTION_DAYS} days`);
    } catch (error) {
        console.error('❌ Failed to cleanup APR history:', error.message);
    }
}

/**
 * Record APR snapshots for all active positions
 * This is the main entry point for the periodic APR recording job
 * 
 * Scans on-chain for real positions (like /positions does) rather than trusting
 * potentially stale DB records.
 * 
 * @param {Function} calculateAprFn - Function to calculate APR (to avoid circular imports)
 * @param {Function} fetchRangeDataFn - Function to fetch position range data (takes NFT mint string)
 * @param {Function} findPositionsFn - Function to find positions on-chain (takes connection, walletAddress)
 * @param {Object} connection - Solana connection
 */
export async function recordAprForAllActivePositions(calculateAprFn, fetchRangeDataFn, findPositionsFn, connection) {
    try {
        // Get all wallets that have active positions
        const walletsWithPositions = await db.selectDistinct({ 
            wallet_id: positions.wallet_id 
        })
            .from(positions)
            .where(eq(positions.status, 'active'));
        
        if (!walletsWithPositions || walletsWithPositions.length === 0) {
            return;
        }
        
        // Import wallets table for address lookup
        const { wallets } = await import('../db/schema.js');
        
        let totalRecorded = 0;
        let totalFailed = 0;
        
        for (const { wallet_id } of walletsWithPositions) {
            try {
                // Get wallet address
                const walletRows = await db.select()
                    .from(wallets)
                    .where(eq(wallets.id, wallet_id))
                    .limit(1);
                
                if (!walletRows || walletRows.length === 0) continue;
                const walletAddress = walletRows[0].wallet_address;
                
                // Scan on-chain for real positions (like /positions does)
                const onChainPositions = await findPositionsFn(connection, walletAddress);
                
                if (!onChainPositions || onChainPositions.length === 0) continue;
                
                console.log(`📊 Recording APR for ${onChainPositions.length} position(s) in wallet ${walletAddress.slice(0, 8)}...`);
                
                for (const onChainPos of onChainPositions) {
                    try {
                        // Fetch range data using position PDA (NOT the NFT mint!)
                        const rangeData = await fetchRangeDataFn(onChainPos.positionPda);
                        
                        if (!rangeData) {
                            console.warn(`   ⚠️ No range data for position ${onChainPos.mintAddress.slice(0, 8)}..., skipping`);
                            totalFailed++;
                            continue;
                        }
                        
                        // Find matching DB position by NFT mint
                        const dbPositions = await db.select()
                            .from(positions)
                            .where(eq(positions.nft_mint, onChainPos.mintAddress))
                            .limit(1);
                        
                        if (!dbPositions || dbPositions.length === 0) {
                            // Position exists on-chain but not in DB - skip for now
                            // (will be created when user runs /positions)
                            continue;
                        }
                        
                        const dbPosition = dbPositions[0];
                        
                        // Calculate APR
                        const aprData = await calculateAprFn({
                            poolId: rangeData.poolId,
                            inRange: rangeData.inRange,
                            positionLiquidity: rangeData.liquidity,
                            poolLiquidity: rangeData.poolLiquidity,
                            positionValueUsd: rangeData.liquidityValueUsd
                        });
                        
                        // Get range percent from DB or calculate from range data
                        let rangePercent = dbPosition.range_percent;
                        if (rangePercent == null && rangeData.lowerPrice && rangeData.upperPrice && rangeData.lowerPrice > 0) {
                            const priceRatio = rangeData.upperPrice / rangeData.lowerPrice;
                            if (Number.isFinite(priceRatio) && priceRatio > 0) {
                                const spreadFraction = (priceRatio - 1) / (priceRatio + 1);
                                if (Number.isFinite(spreadFraction) && spreadFraction > 0) {
                                    rangePercent = spreadFraction * 100;
                                }
                            }
                        }
                        
                        // Record the snapshot
                        await recordAprSnapshot(
                            dbPosition.id,
                            aprData,
                            rangeData.inRange,
                            rangeData.liquidityValueUsd,
                            rangePercent
                        );
                        
                        totalRecorded++;
                        
                    } catch (posError) {
                        console.error(`   ❌ Failed to record APR for position ${onChainPos.mintAddress.slice(0, 8)}...:`, posError.message);
                        totalFailed++;
                    }
                }
                
            } catch (walletError) {
                console.error(`   ❌ Failed to process wallet ${wallet_id}:`, walletError.message);
            }
        }
        
        if (totalRecorded > 0 || totalFailed > 0) {
            console.log(`✅ APR snapshots recorded: ${totalRecorded} success, ${totalFailed} failed`);
        }
        
    } catch (error) {
        console.error('❌ Failed to record APR for all positions:', error.message);
    }
}

/**
 * Carry over APR history from old position to new position (during rebalance)
 * Updates position_id in history records to point to the new position
 * 
 * @param {number} oldPositionId - Old position ID being closed
 * @param {number} newPositionId - New position ID just opened
 */
export async function carryOverAprHistory(oldPositionId, newPositionId) {
    try {
        await db.update(position_apr_history)
            .set({ position_id: newPositionId })
            .where(eq(position_apr_history.position_id, oldPositionId));
        
        console.log(`📊 APR history carried over from position ${oldPositionId} → ${newPositionId}`);
    } catch (error) {
        console.error(`❌ Failed to carry over APR history:`, error.message);
    }
}