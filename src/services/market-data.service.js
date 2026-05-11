/**
 * Market Data Service
 * 
 * Fetches and stores SOL/USD price history for auto-rebalancing decisions.
 * Calculates TWAP, ATR, and drift metrics from stored candles.
 * 
 * Data Source: Jupiter Price API (1-minute candles)
 * Storage: SQLite database (price_history table)
 * Retention: 2 hours rolling window (120 candles)
 * 
 * @module market-data.service
 */

import { db } from '../db/index.js';
import { price_history } from '../db/schema.js';
import { gte, desc, sql } from 'drizzle-orm';
import {
    JUPITER_PRICE_API_BASE_URL,
    JUPITER_API_HEADERS,
    SOL_MINT,
    PRICE_HISTORY_CANDLE_COUNT
} from '../config/constants.js';

// Rate limiting: Track last API call to prevent bans
// NOTE: This is SEPARATE from the Jupiter Token API rate limiter in jupiter-api.util.js
// Different endpoints have independent rate limits
let lastFetchTime = 0;
const MIN_FETCH_INTERVAL_MS = 60000; // 60 seconds minimum between Price API calls
const MAX_CANDLES_PER_REQUEST = 1440; // 24 hours max (API limit)
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const isDebug = LOG_LEVEL === 'debug';
/**
 * Check if enough time has passed since last API call (rate limiting)
 * 
 * @param {boolean} [force=false] - Skip rate limit check
 * @returns {boolean} True if can fetch, false if too soon
 */
function canFetchNow(force = false) {
    if (force) return true;

    const now = Date.now();
    const timeSinceLastFetch = now - lastFetchTime;

    if (timeSinceLastFetch < MIN_FETCH_INTERVAL_MS) {
        const waitSeconds = Math.ceil((MIN_FETCH_INTERVAL_MS - timeSinceLastFetch) / 1000);
        console.warn(`⏳ Jupiter Price API rate limit: Must wait ${waitSeconds}s before next fetch`);
        return false;
    }

    return true;
}

/**
 * Fetch price candles from Jupiter API
 * 
 * @param {Object} options - Fetch options
 * @param {string} [options.interval='1_MINUTE'] - Candle interval
 * @param {number} [options.candles=120] - Number of candles to fetch
 * @param {number} [options.to] - End timestamp (ms), defaults to now
 * @param {boolean} [options.force=false] - Skip rate limit check (use with caution)
 * @returns {Promise<Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>>}
 */
export async function fetchSolUsdCandles(options = {}) {
    const {
        interval = '1_MINUTE',
        candles = 120,
        to = Date.now(),
        force = false
    } = options;

    // Rate limiting check
    if (!canFetchNow(force)) {
        throw new Error('Rate limit: Too many requests. Wait before retrying.');
    }

    try {
        // Clamp candles to API maximum
        const candlesToFetch = Math.min(candles, MAX_CANDLES_PER_REQUEST);

        if (candles > MAX_CANDLES_PER_REQUEST) {
            console.warn(`⚠️  Requested ${candles} candles, clamped to API max: ${MAX_CANDLES_PER_REQUEST}`);
        }

        // Build API URL
        const url = `${JUPITER_PRICE_API_BASE_URL}/${SOL_MINT}?` +
            `interval=${interval}&` +
            `to=${to}&` +
            `candles=${candlesToFetch}&` +
            `type=price&` +
            `quote=usd`;


        const response = await fetch(url, {
            headers: JUPITER_API_HEADERS
        });

        if (!response.ok) {
            throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        if (!data.candles || !Array.isArray(data.candles)) {
            throw new Error('Invalid response format from Jupiter API');
        }

        // Update last fetch time on success
        lastFetchTime = Date.now();

        return data.candles;

    } catch (error) {
        console.error('❌ Failed to fetch SOL/USD candles:', error.message);
        throw error;
    }
}

/**
 * Store price candles in database
 * 
 * @param {Array<Object>} candles - Candles to store
 * @returns {Promise<number>} Number of candles stored
 */
export async function storePriceCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) {
        return 0;
    }

    try {
        // Convert to database format
        const records = candles.map(candle => ({
            timestamp: candle.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume
        }));

        // Insert with conflict resolution (ignore duplicates)
        await db.insert(price_history)
            .values(records)
            .onConflictDoNothing(); // Requires unique constraint on timestamp

        return records.length;

    } catch (error) {
        console.error('❌ Failed to store price candles:', error.message);
        throw error;
    }
}

/**
 * Clean up old price candles beyond retention window
 * 
 * @param {number} [keepCount=120] - Number of most recent candles to keep
 * @returns {Promise<number>} Number of candles deleted
 */
export async function cleanupOldCandles(keepCount = PRICE_HISTORY_CANDLE_COUNT) {
    try {
        // Get timestamp of the Nth most recent candle
        const recentCandles = await db.select({ timestamp: price_history.timestamp })
            .from(price_history)
            .orderBy(desc(price_history.timestamp))
            .limit(keepCount);

        if (recentCandles.length < keepCount) {
            // Not enough candles to clean up
            return 0;
        }

        const cutoffTimestamp = recentCandles[recentCandles.length - 1].timestamp;

        // Delete candles older than cutoff
        const result = await db.delete(price_history)
            .where(sql`${price_history.timestamp} < ${cutoffTimestamp}`);
        if (isDebug) console.log(`🗑️  Cleaned up old price candles (kept last ${keepCount})`);
        return result.changes || 0;

    } catch (error) {
        console.error('❌ Failed to cleanup old candles:', error.message);
        return 0;
    }
}

/**
 * Get recent price candles from database
 * 
 * @param {number} count - Number of candles to retrieve
 * @returns {Promise<Array<{timestamp:number, open:number, high:number, low:number, close:number, volume:number}>>}
 */
export async function getRecentCandles(count = 120) {
    try {
        const candles = await db.select()
            .from(price_history)
            .orderBy(desc(price_history.timestamp))
            .limit(count);

        // Return in chronological order (oldest first)
        return candles.reverse();

    } catch (error) {
        console.error('❌ Failed to get recent candles:', error.message);
        return [];
    }
}

/**
 * Calculate TWAP (Time-Weighted Average Price) over a window
 * 
 * @param {number} windowMinutes - Window size in minutes
 * @returns {Promise<number|null>} TWAP price or null if insufficient data
 */
export async function calculateTWAP(windowMinutes) {
    try {
        const candles = await getRecentCandles(windowMinutes);

        if (candles.length < windowMinutes) {
            console.warn(`⚠️  Insufficient data for ${windowMinutes}m TWAP (have ${candles.length} candles)`);
            return null;
        }

        // Use closing prices for TWAP
        const sum = candles.reduce((acc, c) => acc + c.close, 0);
        const twap = sum / candles.length;

        return twap;

    } catch (error) {
        console.error(`❌ Failed to calculate ${windowMinutes}m TWAP:`, error.message);
        return null;
    }
}

/**
 * Calculate ATR (Average True Range) over a window
 * 
 * ATR measures volatility by averaging the true range of each candle.
 * True Range = max(high - low, |high - prev_close|, |low - prev_close|)
 * 
 * @param {number} windowMinutes - Window size in minutes
 * @returns {Promise<{atr: number, atrPercent: number}|null>} ATR and ATR% or null if insufficient data
 */
export async function calculateATR(windowMinutes) {
    try {
        const candles = await getRecentCandles(windowMinutes + 1); // Need +1 for prev_close

        if (candles.length < windowMinutes + 1) {
            console.warn(`⚠️  Insufficient data for ${windowMinutes}m ATR (have ${candles.length} candles)`);
            return null;
        }

        // Calculate true range for each candle
        const trueRanges = [];
        for (let i = 1; i < candles.length; i++) {
            const candle = candles[i];
            const prevClose = candles[i - 1].close;

            const tr = Math.max(
                candle.high - candle.low,
                Math.abs(candle.high - prevClose),
                Math.abs(candle.low - prevClose)
            );

            trueRanges.push(tr);
        }

        // Average true range
        const atr = trueRanges.reduce((acc, tr) => acc + tr, 0) / trueRanges.length;

        // Convert to percentage of current price
        const currentPrice = candles[candles.length - 1].close;
        const atrPercent = (atr / currentPrice) * 100;

        return { atr, atrPercent };

    } catch (error) {
        console.error(`❌ Failed to calculate ${windowMinutes}m ATR:`, error.message);
        return null;
    }
}

/**
 * Calculate price drift (slope of TWAP over time)
 * 
 * Drift = (TWAP_now - TWAP_start) / TWAP_start / hours * 100
 * Expressed as % per hour
 * 
 * @param {number} twapWindowMinutes - TWAP calculation window (e.g., 5)
 * @param {number} driftWindowMinutes - Drift measurement window (e.g., 15)
 * @returns {Promise<number|null>} Drift in % per hour, or null if insufficient data
 */
export async function calculateDrift(twapWindowMinutes, driftWindowMinutes) {
    try {
        const candles = await getRecentCandles(driftWindowMinutes + twapWindowMinutes);

        if (candles.length < driftWindowMinutes + twapWindowMinutes) {
            console.warn(`⚠️  Insufficient data for drift calculation`);
            return null;
        }

        // Calculate TWAP at start of drift window
        const startCandles = candles.slice(0, twapWindowMinutes);
        const twapStart = startCandles.reduce((acc, c) => acc + c.close, 0) / startCandles.length;

        // Calculate TWAP at end of drift window (most recent)
        const endCandles = candles.slice(-twapWindowMinutes);
        const twapEnd = endCandles.reduce((acc, c) => acc + c.close, 0) / endCandles.length;

        // Calculate drift as % change per hour
        const priceChange = twapEnd - twapStart;
        const priceChangePercent = (priceChange / twapStart) * 100;
        const hours = driftWindowMinutes / 60;
        const driftPerHour = priceChangePercent / hours;

        return driftPerHour;

    } catch (error) {
        console.error('❌ Failed to calculate drift:', error.message);
        return null;
    }
}

/**
 * Get all market metrics needed for auto-rebalance decisions
 * 
 * @returns {Promise<{
 *   currentPrice: number,
 *   twap5: number|null,
 *   twap15: number|null,
 *   atr15: {atr:number, atrPercent:number}|null,
 *   atr1h: {atr:number, atrPercent:number}|null,
 *   drift5x15: number|null,
 *   dataAge: number,
 *   candleCount: number
 * }>}
 */
export async function getMarketMetrics() {
    try {
        const candles = await getRecentCandles(120);

        if (candles.length === 0) {
            return {
                currentPrice: null,
                twap5: null,
                twap15: null,
                atr15: null,
                atr1h: null,
                drift5x15: null,
                dataAge: null,
                candleCount: 0
            };
        }

        // Current price (most recent close)
        const currentPrice = candles[candles.length - 1].close;

        // Data freshness (seconds since last candle)
        const lastCandleTime = candles[candles.length - 1].timestamp;
        const dataAge = Math.floor((Date.now() / 1000) - lastCandleTime);

        // Calculate all metrics in parallel
        const [twap5, twap15, atr15, atr1h, drift5x15] = await Promise.all([
            calculateTWAP(5),
            calculateTWAP(15),
            calculateATR(15),
            calculateATR(60),
            calculateDrift(5, 15)
        ]);

        return {
            currentPrice,
            twap5,
            twap15,
            atr15,
            atr1h,
            drift5x15,
            dataAge,
            candleCount: candles.length
        };

    } catch (error) {
        console.error('❌ Failed to get market metrics:', error.message);
        throw error;
    }
}

/**
 * Get current SOL price from cached candles (fast, no API call)
 * 
 * Returns the most recent closing price from price_history.
 * This is much faster than API calls (~2ms vs 200-500ms).
 * Returns null if no recent data (caller should fall back to API).
 * 
 * @param {number} [maxAgeSeconds=120] - Max age in seconds for data to be considered fresh
 * @returns {Promise<number|null>} SOL price in USD or null if stale/unavailable
 */
export async function getCurrentSolPrice(maxAgeSeconds = 120) {
    try {
        const candles = await getRecentCandles(1);
        
        if (candles.length === 0) {
            return null;
        }
        
        const lastCandle = candles[0];
        const ageSeconds = Math.floor(Date.now() / 1000) - lastCandle.timestamp;
        
        // Return null if data is too stale
        if (ageSeconds > maxAgeSeconds) {
            return null;
        }
        return lastCandle.close;
        
    } catch (error) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log('NO CANDLE PRICE');
        }
        // Fail silently - caller will fall back to API
        return null;
    }
}

/**
 * Get rate limit status
 * 
 * @returns {{canFetch: boolean, lastFetchAgo: number, waitTime: number}}
 */
export function getRateLimitStatus() {
    const now = Date.now();
    const lastFetchAgo = lastFetchTime > 0 ? now - lastFetchTime : Infinity;
    const waitTime = Math.max(0, MIN_FETCH_INTERVAL_MS - lastFetchAgo);
    const canFetch = lastFetchAgo >= MIN_FETCH_INTERVAL_MS;

    return {
        canFetch,
        lastFetchAgo: Math.floor(lastFetchAgo / 1000), // seconds
        waitTime: Math.ceil(waitTime / 1000) // seconds
    };
}

/**
 * Calculate gap between last stored candle and now
 * 
 * @returns {Promise<{lastTimestamp: number, gapMinutes: number, candlesNeeded: number}>}
 */
async function calculateDataGap() {
    const recentCandles = await getRecentCandles(1);

    if (recentCandles.length === 0) {
        // No data - need full 2-hour window
        return {
            lastTimestamp: 0,
            gapMinutes: 120,
            candlesNeeded: PRICE_HISTORY_CANDLE_COUNT
        };
    }

    const lastCandleTime = recentCandles[0].timestamp; // Unix timestamp in seconds
    const nowSeconds = Math.floor(Date.now() / 1000);
    const gapSeconds = nowSeconds - lastCandleTime;
    const gapMinutes = Math.floor(gapSeconds / 60);

    // Add small buffer (1 candle) to ensure no gaps
    const candlesNeeded = Math.min(gapMinutes + 1, MAX_CANDLES_PER_REQUEST);

    return {
        lastTimestamp: lastCandleTime,
        gapMinutes,
        candlesNeeded
    };
}

/**
 * Update price history with smart gap-based fetching
 * 
 * Strategy:
 * - Calculate exact gap between last stored candle and now
 * - Fetch only the candles needed to fill the gap
 * - Handle offline periods by backfilling automatically
 * - Respect rate limits (30s minimum between fetches)
 * - Clamp to API maximum (1440 candles = 24 hours)
 * 
 * Examples:
 * - Bot offline for 1 hour → fetches 60 candles
 * - Normal operation (30s since last) → fetches 1-2 candles
 * - First run → fetches 120 candles (2 hours)
 * - Bot offline for 24+ hours → fetches 1440 candles (API max)
 * 
 * @param {boolean} [force=false] - Force fetch even if rate limited
 * @returns {Promise<{fetched: number, stored: number, cleaned: number, gapFilled: number, skipped: boolean}>}
 */
export async function updatePriceHistory(force = false) {
    try {
        // Calculate how many candles we need
        const gap = await calculateDataGap();

        // If no gap or tiny gap (< 1 minute), skip unless forced
        if (gap.candlesNeeded <= 1 && !force) {
            return {
                fetched: 0,
                stored: 0,
                cleaned: 0,
                gapFilled: 0,
                skipped: true
            };
        }

        // Log what we're about to do
        if (isDebug) {
            if (gap.gapMinutes === 0) {
                console.log(`📊 Initializing price history (first run)`);
            } else if (gap.gapMinutes > 60) {
                console.log(`📊 Backfilling price history: ${gap.gapMinutes}m gap (bot was offline)`);
            } else {
                console.log(`📊 Updating price history: ${gap.gapMinutes}m gap`);
            }
        }

        // Fetch exact number of candles needed
        const candles = await fetchSolUsdCandles({
            candles: gap.candlesNeeded,
            force
        });

        // Store candles (will ignore duplicates)
        const stored = await storePriceCandles(candles);

        // Cleanup old candles beyond retention window
        const cleaned = await cleanupOldCandles();


        return {
            fetched: candles.length,
            stored,
            cleaned,
            gapFilled: gap.gapMinutes,
            skipped: false
        };

    } catch (error) {
        // If rate limited, return gracefully
        if (error.message.includes('Rate limit')) {
            if (process.env.LOG_LEVEL === 'debug') {
                console.log(`⏳ ${error.message}`);
            }
            return {
                fetched: 0,
                stored: 0,
                cleaned: 0,
                gapFilled: 0,
                skipped: true
            };
        }

        console.error('❌ Failed to update price history:', error.message);
        throw error;
    }
}

