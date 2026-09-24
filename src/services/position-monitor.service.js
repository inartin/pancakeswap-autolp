import { db } from '../db/index.js';
import { positions, alert_history, proximity_alerts, position_statistics } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { createSolanaConnection } from '../utils/rpc.util.js';
import { PANCAKESWAP_IDL, METEORA_IDL, METEORA_PROGRAM_ID, PRICE_CACHE_TTL_MS, ALERT_COOLDOWN_MS, PROXIMITY_COOLDOWN_MS } from '../config/constants.js';
import { BorshCoder } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { getMintDecimals } from '../utils/token.util.js';
import { binIdToPrice } from '../utils/meteora-dlmm.util.js';
import { logAlertTrigger } from './alert.service.js';
import { 
    markOutOfRange, 
    markBackInRange, 
    updateAccumulatedTime 
} from './position-statistics.service.js';

/**
 * Position Monitor Service
 *
 * Checks all active positions for out-of-range status using on-chain pool price
 * and records alert triggers with cooldown to avoid spam.
 * Also supports proximity-zone detection (emission gated by option).
 *
 * Defaults (from constants.js):
 * - Price cache TTL: PRICE_CACHE_TTL_MS (10 seconds)
 * - Out-of-range cooldown: ALERT_COOLDOWN_MS (2 minutes)
 * - Proximity cooldown: PROXIMITY_COOLDOWN_MS (2 minutes)
 */
export class PositionMonitorService {
    constructor(options = {}) {
        this.connection = createSolanaConnection();
        this.priceCache = new Map(); // poolAddress -> { price: number, ts: number }
        this.cacheTtlMs = options.cacheTtlMs ?? PRICE_CACHE_TTL_MS;
        this.cooldownMs = options.cooldownMs ?? ALERT_COOLDOWN_MS;
        this.proximityCooldownMs = options.proximityCooldownMs ?? PROXIMITY_COOLDOWN_MS;
        this.emitProximity = options.emitProximity ?? false; // off by default until scheduler handles it
        this.coder = new BorshCoder(PANCAKESWAP_IDL);
        this.meteoraCoder = new BorshCoder(METEORA_IDL);
        this.meteoraPoolAddresses = new Set();
        this.lastCheckTime = null; // Track last check time for accumulated time calculations
    }

    /**
     * Check all active positions and return newly triggered out-of-range alerts
     *
     * @returns {Promise<Array<{positionId:number,walletId:number,poolAddress:string,lowerPrice:number|null,upperPrice:number|null,currentPrice:number,type:'out_of_range'|'back_in_range'|'proximity',direction?:'below'|'above',lowerAlertPrice?:number,upperAlertPrice?:number}>>}
     */
    async checkAllPositions() {
        const activePositions = await db.select()
            .from(positions)
            .where(eq(positions.status, 'active'));

        if (!Array.isArray(activePositions) || activePositions.length === 0) {
            return [];
        }

        // Fetch unique pool prices with cache
        const uniquePools = Array.from(new Set(activePositions.map(p => p.pool_address)));
        const poolPriceMap = await this.batchGetCurrentPrices(uniquePools);

        const now = Date.now();
        const triggered = [];
        
        // Track monitoring cycle time for accumulated time updates
        const cycleIntervalMs = this.lastCheckTime ? (now - this.lastCheckTime) : 0;
        this.lastCheckTime = now;
        for (const pos of activePositions) {
            const isMeteora = this.meteoraPoolAddresses?.has(pos.pool_address) || false;
            const currentPrice = poolPriceMap.get(pos.pool_address);
            if (typeof currentPrice !== 'number' || !isFinite(currentPrice)) {
                if (process.env.LOG_LEVEL === 'debug') {
                    console.log(`⚠️ Position ${pos.id}: No valid price, skipping`);
                }
                continue;
            }
            // Check out_of_range config from proximity_alerts (if any)
            const config = await this.getOutOfRangeConfig(pos.id);
            
            // Determine range status EARLY (needed for accumulation)
            const hasLower = typeof pos.lower_price === 'number' && isFinite(pos.lower_price);
            const hasUpper = typeof pos.upper_price === 'number' && isFinite(pos.upper_price);
            const outBelow = hasLower && currentPrice < pos.lower_price;
            const outAbove = hasUpper && currentPrice > pos.upper_price;
            const inRange = (hasLower && hasUpper) ? (!outBelow && !outAbove) : false;
            
            // 🔥 UPDATE ACCUMULATED TIME FIRST (before any continue statements)
            // This ensures time is tracked even if alerts are disabled
            if (cycleIntervalMs > 0) {
                void updateAccumulatedTime(pos.id, cycleIntervalMs, inRange).catch(err => {
                    console.error(`❌ Failed to update accumulated time for position ${pos.id}:`, err.message);
                });
            }
            
            // 🔥 UPDATE RANGE STATUS (critical for auto-rebalance, independent of alerts)
            // This must happen regardless of alert settings
            // Use DB stats instead of alert history (works even with alerts disabled)
            const stats = await this.getPositionStats(pos.id);
            const wasInRange = stats?.in_range;
            
            if (inRange && !wasInRange) {
                // Position came back in range - update DB status
                void markBackInRange(pos.id).catch(err => {
                    console.error(`Failed to mark position ${pos.id} back in range:`, err.message);
                });
            } else if ((outBelow || outAbove) && wasInRange !== false) {
                // Position went out of range - update DB status (only if not already marked OOR)
                void markOutOfRange(pos.id).catch(err => {
                    console.error(`Failed to mark position ${pos.id} out of range:`, err.message);
                });
            }
            
            // Now proceed with alert logic (may have continue statements)
            if (config && config.out_of_range_enabled === false) {
                continue; // alerts disabled for this position (but range status is already updated above)
            }
            const cooldownMs = ((config && typeof config.out_of_range_cooldown_minutes === 'number')
                ? config.out_of_range_cooldown_minutes
                : (this.cooldownMs / 60000)) * 60000;

            if (inRange) {
                // If last alert was out_of_range, emit back_in_range once
                const lastType = await this.getLastAlertType(pos.id);
                if (lastType === 'out_of_range') {
                    await logAlertTrigger(pos.id, 'back_in_range', currentPrice);
                    
                    // Range status already updated above (line 91-95)
                    
                    triggered.push({
                        positionId: pos.id,
                        walletId: pos.wallet_id,
                        poolAddress: pos.pool_address,
                        lowerPrice: hasLower ? pos.lower_price : null,
                        upperPrice: hasUpper ? pos.upper_price : null,
                        currentPrice,
                        type: 'back_in_range',
                        isMeteora
                    });
                }

                // Proximity detection while in-range (edge-triggered with config change detection)
                try {
                    const prox = await this.getProximityConfig(pos.id);
                    if (prox && prox.enabled === true && hasLower && hasUpper) {
                        const inLowerZone = typeof prox.lower_alert_price === 'number'
                            && isFinite(prox.lower_alert_price)
                            && currentPrice >= pos.lower_price
                            && currentPrice <= prox.lower_alert_price;
                        const inUpperZone = typeof prox.upper_alert_price === 'number'
                            && isFinite(prox.upper_alert_price)
                            && currentPrice <= pos.upper_price
                            && currentPrice >= prox.upper_alert_price;

                        if (inLowerZone || inUpperZone) {
                            // Edge-triggered: only alert if not already in a proximity episode
                            // OR if proximity threshold configuration changed
                            const lastAlert = await this.getLastAlertData(pos.id);

                            // Check if threshold configuration changed since last proximity alert
                            const configChanged =
                                lastAlert?.alert_type === 'proximity' &&
                                typeof lastAlert.proximity_threshold_percent === 'number' &&
                                typeof prox.threshold_percentage === 'number' &&
                                lastAlert.proximity_threshold_percent !== prox.threshold_percentage;

                            if (lastAlert?.alert_type !== 'proximity' || configChanged) {
                                // Entering proximity zone (first time, re-entering, or config changed)
                                if (this.emitProximity) {
                                    await logAlertTrigger(pos.id, 'proximity', currentPrice, prox.threshold_percentage);
                                    triggered.push({
                                        positionId: pos.id,
                                        walletId: pos.wallet_id,
                                        poolAddress: pos.pool_address,
                                        lowerPrice: pos.lower_price,
                                        upperPrice: pos.upper_price,
                                        currentPrice,
                                        type: 'proximity',
                                        lowerAlertPrice: prox.lower_alert_price,
                                        upperAlertPrice: prox.upper_alert_price,
                                        isMeteora
                                    });
                                }
                            }
                            // Else: still in same proximity episode with same config — suppress repeats
                        }
                    }
                } catch (_) {
                    // ignore proximity detection errors to keep monitor robust
                }
                continue;
            }

            // Out of range path (edge-triggered):
            // Only emit when the last alert type is not already 'out_of_range'.
            if (outBelow || outAbove) {
                const lastType = await this.getLastAlertType(pos.id);
                if (lastType === 'out_of_range') {
                    // Still in the same out-of-range episode — suppress repeats
                    continue;
                }

                await logAlertTrigger(pos.id, 'out_of_range', currentPrice, true);
                
                // Range status already updated above (line 96-100)

                triggered.push({
                    positionId: pos.id,
                    walletId: pos.wallet_id,
                    poolAddress: pos.pool_address,
                    lowerPrice: hasLower ? pos.lower_price : null,
                    upperPrice: hasUpper ? pos.upper_price : null,
                    currentPrice,
                    type: 'out_of_range',
                    direction: outBelow ? 'below' : 'above',
                    isMeteora
                });
            }
        }

        return triggered;
    }

    /**
     * Get out_of_range configuration from proximity_alerts if present
     * @param {number} positionId
     * @returns {Promise<{out_of_range_enabled:boolean,out_of_range_cooldown_minutes:number}|null>}
     */
    async getOutOfRangeConfig(positionId) {
        const rows = await db.select()
            .from(proximity_alerts)
            .where(eq(proximity_alerts.position_id, positionId))
            .limit(1);
        const row = rows && rows[0];
        if (!row) return null;
        return {
            out_of_range_enabled: !!row.out_of_range_enabled,
            out_of_range_cooldown_minutes: typeof row.out_of_range_cooldown_minutes === 'number'
                ? row.out_of_range_cooldown_minutes
                : 60
        };
    }

    /**
     * Get proximity configuration if present
     * @param {number} positionId
     * @returns {Promise<{enabled:boolean,threshold_percentage:number,lower_alert_price:number,upper_alert_price:number,last_triggered_at?:number|Date}|null>}
     */
    async getProximityConfig(positionId) {
        const rows = await db.select()
            .from(proximity_alerts)
            .where(eq(proximity_alerts.position_id, positionId))
            .limit(1);
        const row = rows && rows[0];
        if (!row) return null;
        return {
            enabled: !!row.enabled,
            threshold_percentage: typeof row.threshold_percentage === 'number' ? row.threshold_percentage : NaN,
            lower_alert_price: typeof row.lower_alert_price === 'number' ? row.lower_alert_price : NaN,
            upper_alert_price: typeof row.upper_alert_price === 'number' ? row.upper_alert_price : NaN,
            last_triggered_at: row.last_triggered_at,
            proximity_cooldown_minutes: typeof row.proximity_cooldown_minutes === 'number' ? row.proximity_cooldown_minutes : undefined
        };
    }

    /**
     * Batch fetch current prices for pools with TTL cache
     * @param {string[]} poolAddresses
     * @returns {Promise<Map<string, number>>}
     */
    async batchGetCurrentPrices(poolAddresses) {
        const entries = await Promise.all(poolAddresses.map(async (addr) => {
            try {
                const price = await this.getCurrentPoolPrice(addr);
                return [addr, price];
            } catch {
                return [addr, null];
            }
        }));

        const map = new Map();
        for (const [addr, price] of entries) {
            if (typeof price === 'number' && isFinite(price)) {
                map.set(addr, price);
            }
        }
        return map;
    }

    /**
     * Get current pool price with cache
     * @param {string} poolAddress
     * @returns {Promise<number|null>}
     */
    async getCurrentPoolPrice(poolAddress) {
        const cached = this.priceCache.get(poolAddress);
        const now = Date.now();
        if (cached && (now - cached.ts) < this.cacheTtlMs) {
            return cached.price;
        }

        const price = await this.fetchCurrentPoolPrice(poolAddress);
        if (typeof price === 'number' && isFinite(price)) {
            this.priceCache.set(poolAddress, { price, ts: now });
            return price;
        }
        return null;
    }

    /**
     * Fetch current pool price from on-chain data
     * @param {string} poolAddress
     * @returns {Promise<number>}
     */
    async fetchCurrentPoolPrice(poolAddress) {
        const poolPk = new PublicKey(poolAddress);
        const ai = await this.connection.getAccountInfo(poolPk);
        if (!ai) {
            throw new Error('Pool account not found');
        }

        // Support Meteora DLMM pools
        if (ai.owner.equals(METEORA_PROGRAM_ID)) {
            this.meteoraPoolAddresses.add(poolAddress);
            const pairData = this.meteoraCoder.accounts.decode('LbPair', ai.data);
            const [dec0Maybe, dec1Maybe] = await Promise.all([
                getMintDecimals(this.connection, pairData.token_x_mint),
                getMintDecimals(this.connection, pairData.token_y_mint)
            ]);
            const decimals0 = typeof dec0Maybe === 'number' ? dec0Maybe : 9;
            const decimals1 = typeof dec1Maybe === 'number' ? dec1Maybe : 9;
            return binIdToPrice(pairData.active_id, pairData.bin_step, decimals0, decimals1);
        }

        const pool = this.coder.accounts.decode('PoolState', ai.data);

        // Extract sqrt_price_x64 and token mints
        const sqrtPriceX64 = BigInt(pool.sqrt_price_x64.toString());
        const mint0 = new PublicKey(pool.token_mint_0);
        const mint1 = new PublicKey(pool.token_mint_1);

        // Fetch decimals (fallback to 9 if missing)
        const [dec0Maybe, dec1Maybe] = await Promise.all([
            getMintDecimals(this.connection, mint0),
            getMintDecimals(this.connection, mint1)
        ]);
        const decimals0 = typeof dec0Maybe === 'number' ? dec0Maybe : 9;
        const decimals1 = typeof dec1Maybe === 'number' ? dec1Maybe : 9;

        // Convert sqrt_price_x64 (Q64) to price (token1 per token0)
        const Q64 = 1n << 64n;
        const sqrt = Number(sqrtPriceX64) / Number(Q64);
        const priceRaw = sqrt * sqrt;
        const priceAdjFactor = Math.pow(10, decimals0 - decimals1);
        const price = priceRaw * priceAdjFactor;
        return price;
    }

    /**
     * Get last out_of_range alert time for a position
     * @param {number} positionId
     * @returns {Promise<Date|null>}
     */
    async getLastOutOfRangeAt(positionId) {
        const rows = await db.select()
            .from(alert_history)
            .where(and(
                eq(alert_history.position_id, positionId),
                eq(alert_history.alert_type, 'out_of_range')
            ))
            .orderBy(desc(alert_history.triggered_at))
            .limit(1);

        const row = rows && rows[0];
        if (!row) return null;

        const t = row.triggered_at;
        let lastAtMs = 0;
        if (t instanceof Date) {
            lastAtMs = t.getTime();
        } else if (typeof t === 'number' && isFinite(t)) {
            // If already in milliseconds (> ~2001-09), use as-is; otherwise treat as seconds
            lastAtMs = t > 1e12 ? t : t * 1000;
        } else {
            const n = Number(t);
            if (!Number.isFinite(n)) return null;
            lastAtMs = n > 1e12 ? n : n * 1000;
        }
        return new Date(lastAtMs);
    }

    /**
     * Get position statistics (for range status tracking)
     */
    async getPositionStats(positionId) {
        try {
            const results = await db.select()
                .from(position_statistics)
                .where(eq(position_statistics.position_id, positionId))
                .limit(1);
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            console.error(`Failed to get stats for position ${positionId}:`, error.message);
            return null;
        }
    }

    /**
     * Get the type of the latest alert for a position
     * @param {number} positionId
     * @returns {Promise<string|null>}
     */
    async getLastAlertType(positionId) {
        const rows = await db.select()
            .from(alert_history)
            .where(eq(alert_history.position_id, positionId))
            .orderBy(desc(alert_history.triggered_at))
            .limit(1);
        const row = rows && rows[0];
        return row?.alert_type || null;
    }

    /**
     * Get full data from last alert (for threshold comparison)
     * @param {number} positionId
     * @returns {Promise<{alert_type:string,proximity_threshold_percent?:number}|null>}
     */
    async getLastAlertData(positionId) {
        const rows = await db.select()
            .from(alert_history)
            .where(eq(alert_history.position_id, positionId))
            .orderBy(desc(alert_history.triggered_at))
            .limit(1);
        return rows?.[0] || null;
    }
}

export default PositionMonitorService;


