/**
 * Market Data WebSocket Service
 * 
 * Real-time market metrics from Jupiter WebSocket price stream.
 * Stores price history and calculates TWAP, ATR, and drift from live data.
 * 
 * This is an alternative to market-data.service.js which uses HTTP polling.
 * Both can coexist - this provides faster, more granular data.
 * 
 * Storage: Redis sorted set (timestamp → price)
 * Retention: 120 minutes rolling window
 * Update frequency: Every price tick (~1-2 seconds)
 * 
 * @module market-data-ws.service
 */

import { isRedisReady } from '../cache/redis-cache.util.js';
import Redis from 'ioredis';
import { fetchSolUsdCandles } from './market-data.service.js';

// Redis configuration
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || null;
const REDIS_DB = parseInt(process.env.REDIS_DB || '0', 10);

// Price history configuration
const PRICE_HISTORY_KEY = 'ws:price:history:sol';
const RETENTION_MINUTES = 120;
const RETENTION_MS = RETENTION_MINUTES * 60 * 1000;

// In-memory fallback when Redis unavailable
const memoryPriceHistory = [];
const MAX_MEMORY_ENTRIES = 7200; // ~2 hours at 1 price/second

// Redis client (lazy initialized)
let redis = null;

/**
 * Get Redis client (lazy initialization)
 */
function getRedis() {
    if (!redis && isRedisReady()) {
        redis = new Redis({
            host: REDIS_HOST,
            port: REDIS_PORT,
            password: REDIS_PASSWORD,
            db: REDIS_DB,
            lazyConnect: false,
            maxRetriesPerRequest: 1
        });
    }
    return redis;
}

/**
 * Store a price point from WebSocket
 * 
 * Called by jupiter-price-ws.service.js on each price update.
 * Stores in Redis sorted set with timestamp as score.
 * 
 * @param {number} price - SOL price in USD
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {Promise<void>}
 */
export async function storePricePoint(price, timestamp = Date.now()) {
    // Always store in memory (fallback)
    memoryPriceHistory.push({ price, timestamp });
    
    // Trim memory if too large
    if (memoryPriceHistory.length > MAX_MEMORY_ENTRIES) {
        memoryPriceHistory.shift();
    }
    
    // Store in Redis if available
    const client = getRedis();
    if (client) {
        try {
            // Add to sorted set (score = timestamp, member = price:timestamp for uniqueness)
            await client.zadd(PRICE_HISTORY_KEY, timestamp, `${price}:${timestamp}`);
            
            // Remove old entries beyond retention window
            const cutoff = timestamp - RETENTION_MS;
            await client.zremrangebyscore(PRICE_HISTORY_KEY, '-inf', cutoff);
        } catch (error) {
            // Silent fail - memory fallback handles it
        }
    }
}

/**
 * Get price history from Redis or memory
 * 
 * @param {number} minutes - How many minutes of history to retrieve
 * @returns {Promise<Array<{price: number, timestamp: number}>>}
 */
export async function getPriceHistory(minutes = 120) {
    const cutoff = Date.now() - (minutes * 60 * 1000);
    
    // Try Redis first
    const client = getRedis();
    if (client) {
        try {
            const entries = await client.zrangebyscore(
                PRICE_HISTORY_KEY,
                cutoff,
                '+inf',
                'WITHSCORES'
            );
            
            if (entries && entries.length > 0) {
                const history = [];
                for (let i = 0; i < entries.length; i += 2) {
                    const [priceStr] = entries[i].split(':');
                    const timestamp = parseInt(entries[i + 1], 10);
                    history.push({
                        price: parseFloat(priceStr),
                        timestamp
                    });
                }
                return history;
            }
        } catch (error) {
            // Fall through to memory
        }
    }
    
    // Fallback to memory
    return memoryPriceHistory.filter(p => p.timestamp >= cutoff);
}

/**
 * Build synthetic OHLC candles from price history
 * 
 * Groups price points into 1-minute buckets and calculates:
 * - Open: First price in bucket
 * - High: Maximum price in bucket
 * - Low: Minimum price in bucket  
 * - Close: Last price in bucket
 * 
 * @param {number} minutes - How many minutes of candles
 * @returns {Promise<Array<{timestamp: number, open: number, high: number, low: number, close: number}>>}
 */
export async function buildSyntheticCandles(minutes = 120) {
    const history = await getPriceHistory(minutes);
    
    if (history.length === 0) {
        return [];
    }
    
    // Group by minute bucket
    const buckets = new Map();
    
    for (const point of history) {
        // Round timestamp down to minute
        const bucketTime = Math.floor(point.timestamp / 60000) * 60000;
        
        if (!buckets.has(bucketTime)) {
            buckets.set(bucketTime, []);
        }
        buckets.get(bucketTime).push(point);
    }
    
    // Convert buckets to candles
    const candles = [];
    
    for (const [timestamp, points] of buckets) {
        if (points.length === 0) continue;
        
        // Sort by timestamp within bucket
        points.sort((a, b) => a.timestamp - b.timestamp);
        
        const prices = points.map(p => p.price);
        
        candles.push({
            timestamp: Math.floor(timestamp / 1000), // Convert to seconds (like HTTP API)
            open: points[0].price,
            high: Math.max(...prices),
            low: Math.min(...prices),
            close: points[points.length - 1].price
        });
    }
    
    // Sort by timestamp
    candles.sort((a, b) => a.timestamp - b.timestamp);
    
    return candles;
}

/**
 * Calculate TWAP from WebSocket price history
 * 
 * @param {number} windowMinutes - Window size in minutes
 * @returns {Promise<number|null>} TWAP or null if insufficient data
 */
export async function calculateTWAP_WS(windowMinutes) {
    const history = await getPriceHistory(windowMinutes);
    
    if (history.length < 10) { // Need at least 10 data points
        console.warn(`⚠️  Insufficient WS data for ${windowMinutes}m TWAP (have ${history.length} points)`);
        return null;
    }
    
    // Simple average of all prices in window
    const sum = history.reduce((acc, p) => acc + p.price, 0);
    return sum / history.length;
}

/**
 * Calculate ATR from synthetic WebSocket candles
 * 
 * @param {number} windowMinutes - Window size in minutes
 * @returns {Promise<{atr: number, atrPercent: number}|null>} ATR or null if insufficient data
 */
export async function calculateATR_WS(windowMinutes) {
    const candles = await buildSyntheticCandles(windowMinutes + 1);
    
    if (candles.length < windowMinutes) {
        console.warn(`⚠️  Insufficient WS candles for ${windowMinutes}m ATR (have ${candles.length})`);
        return null;
    }
    
    // Take the most recent candles
    const recentCandles = candles.slice(-windowMinutes - 1);
    
    // Calculate true range for each candle
    const trueRanges = [];
    for (let i = 1; i < recentCandles.length; i++) {
        const candle = recentCandles[i];
        const prevClose = recentCandles[i - 1].close;
        
        const tr = Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - prevClose),
            Math.abs(candle.low - prevClose)
        );
        
        trueRanges.push(tr);
    }
    
    if (trueRanges.length === 0) {
        return null;
    }
    
    // Average true range
    const atr = trueRanges.reduce((acc, tr) => acc + tr, 0) / trueRanges.length;
    
    // Convert to percentage of current price
    const currentPrice = recentCandles[recentCandles.length - 1].close;
    const atrPercent = (atr / currentPrice) * 100;
    
    return { atr, atrPercent };
}

/**
 * Calculate price drift from WebSocket data
 * 
 * @param {number} twapWindowMinutes - TWAP window (e.g., 5)
 * @param {number} driftWindowMinutes - Drift measurement window (e.g., 15)
 * @returns {Promise<number|null>} Drift in % per hour
 */
export async function calculateDrift_WS(twapWindowMinutes, driftWindowMinutes) {
    const history = await getPriceHistory(driftWindowMinutes + twapWindowMinutes);
    
    if (history.length < 20) {
        return null;
    }
    
    // Sort by timestamp
    history.sort((a, b) => a.timestamp - b.timestamp);
    
    // Get prices from start of window
    const startCutoff = history[0].timestamp + (twapWindowMinutes * 60 * 1000);
    const startPrices = history.filter(p => p.timestamp < startCutoff);
    
    if (startPrices.length < 5) {
        return null;
    }
    
    // Get prices from end of window (most recent)
    const endCutoff = Date.now() - (twapWindowMinutes * 60 * 1000);
    const endPrices = history.filter(p => p.timestamp >= endCutoff);
    
    if (endPrices.length < 5) {
        return null;
    }
    
    // Calculate TWAPs
    const twapStart = startPrices.reduce((acc, p) => acc + p.price, 0) / startPrices.length;
    const twapEnd = endPrices.reduce((acc, p) => acc + p.price, 0) / endPrices.length;
    
    // Calculate drift as % change per hour
    const priceChange = twapEnd - twapStart;
    const priceChangePercent = (priceChange / twapStart) * 100;
    const hours = driftWindowMinutes / 60;
    const driftPerHour = priceChangePercent / hours;
    
    return driftPerHour;
}

/**
 * Get current price from most recent WebSocket data
 * 
 * @returns {Promise<number|null>} Current price or null
 */
export async function getCurrentPrice_WS() {
    // Check memory first (fastest)
    if (memoryPriceHistory.length > 0) {
        const latest = memoryPriceHistory[memoryPriceHistory.length - 1];
        const ageMs = Date.now() - latest.timestamp;
        
        // Only return if fresh (< 5 seconds old)
        if (ageMs < 5000) {
            return latest.price;
        }
    }
    
    // Try Redis
    const client = getRedis();
    if (client) {
        try {
            const entries = await client.zrange(PRICE_HISTORY_KEY, -1, -1, 'WITHSCORES');
            if (entries && entries.length >= 2) {
                const [priceStr] = entries[0].split(':');
                return parseFloat(priceStr);
            }
        } catch (error) {
            // Silent fail
        }
    }
    
    return null;
}

/**
 * Get all market metrics from WebSocket data
 * 
 * Drop-in replacement for getMarketMetrics() from market-data.service.js
 * 
 * @returns {Promise<{
 *   currentPrice: number|null,
 *   twap5: number|null,
 *   twap15: number|null,
 *   atr15: {atr: number, atrPercent: number}|null,
 *   atr1h: {atr: number, atrPercent: number}|null,
 *   drift5x15: number|null,
 *   dataAge: number,
 *   candleCount: number,
 *   source: string
 * }>}
 */
export async function getMarketMetrics_WS() {
    const history = await getPriceHistory(120);
    
    if (history.length === 0) {
        return {
            currentPrice: null,
            twap5: null,
            twap15: null,
            atr15: null,
            atr1h: null,
            drift5x15: null,
            dataAge: null,
            candleCount: 0,
            source: 'websocket'
        };
    }
    
    // Current price (most recent)
    const sortedHistory = [...history].sort((a, b) => b.timestamp - a.timestamp);
    const currentPrice = sortedHistory[0].price;
    const dataAge = Math.floor((Date.now() - sortedHistory[0].timestamp) / 1000);
    
    // Build synthetic candles for count
    const candles = await buildSyntheticCandles(120);
    
    // Calculate all metrics in parallel
    const [twap5, twap15, atr15, atr1h, drift5x15] = await Promise.all([
        calculateTWAP_WS(5),
        calculateTWAP_WS(15),
        calculateATR_WS(15),
        calculateATR_WS(60),
        calculateDrift_WS(5, 15)
    ]);
    
    return {
        currentPrice,
        twap5,
        twap15,
        atr15,
        atr1h,
        drift5x15,
        dataAge,
        candleCount: candles.length,
        source: 'websocket'
    };
}

/**
 * Get data statistics for diagnostics
 * 
 * @returns {Promise<{memoryCount: number, redisCount: number, oldestTimestamp: number, newestTimestamp: number}>}
 */
export async function getDataStats() {
    let redisCount = 0;
    
    const client = getRedis();
    if (client) {
        try {
            redisCount = await client.zcard(PRICE_HISTORY_KEY);
        } catch (error) {
            // Ignore
        }
    }
    
    const oldest = memoryPriceHistory.length > 0 ? memoryPriceHistory[0].timestamp : 0;
    const newest = memoryPriceHistory.length > 0 ? memoryPriceHistory[memoryPriceHistory.length - 1].timestamp : 0;
    
    return {
        memoryCount: memoryPriceHistory.length,
        redisCount,
        oldestTimestamp: oldest,
        newestTimestamp: newest,
        ageMinutes: newest > 0 ? Math.floor((newest - oldest) / 60000) : 0
    };
}

/**
 * Clear all stored price history (for testing)
 */
export async function clearHistory() {
    memoryPriceHistory.length = 0;
    
    const client = getRedis();
    if (client) {
        try {
            await client.del(PRICE_HISTORY_KEY);
        } catch (error) {
            // Ignore
        }
    }
}

/**
 * Backfill missing price history from HTTP API
 * 
 * Called on startup to fill gaps when bot was offline.
 * Fetches historical candles and converts them to price points.
 * 
 * @returns {Promise<{backfilled: number, gapMinutes: number}>}
 */
export async function backfillFromHttp() {
    try {
        const stats = await getDataStats();
        const now = Date.now();
        
        // Calculate how many minutes of data we're missing
        let gapMinutes = RETENTION_MINUTES; // Default: full 120 minutes
        
        if (stats.newestTimestamp > 0) {
            // We have some data - calculate gap from newest to now
            const gapMs = now - stats.newestTimestamp;
            gapMinutes = Math.ceil(gapMs / 60000);
            
            // If gap is small (< 2 minutes), no need to backfill
            if (gapMinutes < 2) {
                if (process.env.LOG_LEVEL === 'debug') {
                    console.log(`   ✅ Price history is fresh (${gapMinutes}min gap)`);
                }
                return { backfilled: 0, gapMinutes: 0 };
            }
        }
        
        // Cap at retention window
        gapMinutes = Math.min(gapMinutes, RETENTION_MINUTES);
        
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   📥 Backfilling ${gapMinutes} minutes of price history...`);
        }
        
        // Fetch historical candles from HTTP API
        const candles = await fetchSolUsdCandles({
            candles: gapMinutes,
            force: true // Skip rate limit on startup
        });
        
        if (!candles || candles.length === 0) {
            console.warn('   ⚠️  No candles returned from HTTP API');
            return { backfilled: 0, gapMinutes };
        }
        
        // Convert candles to price points
        // Each candle has: time (seconds), open, high, low, close, volume
        // We'll use the close price and convert timestamp to milliseconds
        let stored = 0;
        
        for (const candle of candles) {
            const timestamp = candle.time * 1000; // Convert seconds to ms
            const price = candle.close;
            
            // Store as price point
            await storePricePoint(price, timestamp);
            stored++;
        }
        
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`   ✅ Backfilled ${stored} candles (${gapMinutes}min gap)`);
        }
        
        return { backfilled: stored, gapMinutes };
        
    } catch (error) {
        console.error('   ❌ Backfill failed:', error.message);
        return { backfilled: 0, gapMinutes: 0 };
    }
}

/**
 * Initialize price history with backfill
 * 
 * Call this on startup before relying on TWAP/ATR calculations.
 * 
 * @returns {Promise<void>}
 */
export async function initializePriceHistory() {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log('📊 Initializing price history...');
    }
    
    // Backfill from HTTP if we have gaps
    const result = await backfillFromHttp();
    
    // Show current stats
    const stats = await getDataStats();
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`   📈 Price history: ${stats.memoryCount} points, ${stats.ageMinutes}min coverage`);
        
        if (stats.ageMinutes >= 5) {
            console.log(`   ✅ TWAP/ATR available (${stats.ageMinutes}min of data)`);
        } else {
            console.log(`   ⏳ TWAP/ATR will be available in ~${5 - stats.ageMinutes} minutes`);
        }
    }
}

