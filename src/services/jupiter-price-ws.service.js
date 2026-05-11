/**
 * Jupiter Price WebSocket Service
 * 
 * Real-time price streaming for SOL and CAKE tokens via Jupiter WebSocket API.
 * Prices are cached in Redis with 60s TTL for ultra-fast lookups (~1ms).
 * 
 * This is a HYBRID approach:
 * - WebSocket → Redis for real-time current prices (this service)
 * - SQLite candle history for TWAP/ATR calculations (market-data.service.js)
 * 
 * @module jupiter-price-ws.service
 */

import WebSocket from 'ws';
import { 
    initializeRedis,
    setCachedPrice,
    getCachedPrice 
} from '../cache/redis-cache.util.js';
import { 
    SOL_MINT, 
    CAKE_MINT, 
    JUPITER_WS_URL, 
    JUPITER_WS_HEADERS 
} from '../config/constants.js';
import { storePricePoint } from './market-data-ws.service.js';

// WebSocket state
let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let heartbeatInterval = null;

// Price cache (in-memory fallback when Redis unavailable)
const memoryCache = new Map();

// Configuration
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MEMORY_CACHE_MAX_AGE_MS = 120000; // 2 minutes for memory fallback

// Subscribed tokens
const SUBSCRIBED_TOKENS = [SOL_MINT, CAKE_MINT];

// Token mint to key mapping
const MINT_TO_KEY = {
    [SOL_MINT]: 'sol',
    [CAKE_MINT]: 'cake'
};

/**
 * Store price in Redis and memory cache
 * 
 * @param {string} mint - Token mint address
 * @param {number} price - Token price in USD
 * @param {number} blockId - Solana block ID
 */
async function storePrice(mint, price, blockId) {
    const key = MINT_TO_KEY[mint];
    if (!key) return;

    const timestamp = Date.now();
    const data = {
        price,
        blockId,
        timestamp
    };

    // Always update memory cache (fallback)
    memoryCache.set(key, data);

    // Store in Redis if available (uses shared connection)
    await setCachedPrice(key, data);
    
    // For SOL: Also store in price history for TWAP/ATR calculations
    if (mint === SOL_MINT) {
        await storePricePoint(price, timestamp);
    }
}

/**
 * Get cached price from Redis or memory
 * 
 * @param {string} key - Price key ('sol' or 'cake')
 * @param {number} maxAgeSeconds - Maximum age in seconds
 * @returns {Promise<number|null>} Price or null if unavailable/stale
 */
async function getPriceFromCache(key, maxAgeSeconds = 60) {
    // Try Redis first (uses shared connection)
    const cached = await getCachedPrice(key);
    if (cached) {
        const ageSeconds = (Date.now() - cached.timestamp) / 1000;
        if (ageSeconds <= maxAgeSeconds) {
            return cached.price;
        }
    }

    // Fallback to memory cache
    const memCached = memoryCache.get(key);
    if (memCached) {
        const ageMs = Date.now() - memCached.timestamp;
        if (ageMs < MEMORY_CACHE_MAX_AGE_MS && ageMs / 1000 <= maxAgeSeconds) {
            return memCached.price;
        }
    }

    return null;
}

/**
 * Handle incoming WebSocket message
 * 
 * @param {Buffer|string} data - Raw message data
 */
function handleMessage(data) {
    try {
        const message = JSON.parse(data.toString());

        if (message.type === 'prices' && Array.isArray(message.data)) {
            for (const priceUpdate of message.data) {
                const { assetId, price, blockId } = priceUpdate;
                
                if (SUBSCRIBED_TOKENS.includes(assetId)) {
                    void storePrice(assetId, price, blockId);
                    
                    // Debug log (only in debug mode)
                    if (process.env.LOG_LEVEL === 'debug') {
                        const key = MINT_TO_KEY[assetId];
                        // console.log(`💰 ${key.toUpperCase()}: $${price.toFixed(4)} (block ${blockId})`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('❌ Failed to parse WebSocket message:', error.message);
    }
}

/**
 * Send subscription message
 */
function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const subscribeMessage = {
        type: 'subscribe:prices',
        assets: SUBSCRIBED_TOKENS
    };

    ws.send(JSON.stringify(subscribeMessage));
}

/**
 * Start heartbeat to check connection health
 */
function startHeartbeat() {
    stopHeartbeat();
    
    heartbeatInterval = setInterval(() => {
        // Check if connection is still alive
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn('⚠️  WebSocket connection lost, reconnecting...');
            stopHeartbeat();
            scheduleReconnect();
        }
    }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop heartbeat
 */
function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

/**
 * Calculate reconnect delay with exponential backoff
 * 
 * @returns {number} Delay in milliseconds
 */
function getReconnectDelay() {
    const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
        MAX_RECONNECT_DELAY_MS
    );
    return delay;
}

/**
 * Schedule reconnection attempt
 */
function scheduleReconnect() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`❌ Jupiter WebSocket: Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
        return;
    }

    const delay = getReconnectDelay();
    reconnectAttempts++;

    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`🔄 Jupiter WebSocket: Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    }

    reconnectTimeout = setTimeout(() => {
        void connect();
    }, delay);
}

/**
 * Connect to Jupiter WebSocket
 * 
 * @returns {Promise<void>}
 */
async function connect() {
    // Clean up existing connection
    if (ws) {
        try {
            ws.terminate();
        } catch (_) {
            // Ignore
        }
        ws = null;
    }

    try {
        ws = new WebSocket(JUPITER_WS_URL, {
            headers: JUPITER_WS_HEADERS
        });

        ws.on('open', () => {
            if (process.env.LOG_LEVEL === 'debug') {
                console.log('✅ Jupiter WebSocket connected');
            }
            isConnected = true;
            reconnectAttempts = 0;
            
            // Subscribe to prices
            subscribe();
            
            // Start heartbeat
            startHeartbeat();
        });

        ws.on('message', handleMessage);

        ws.on('error', (error) => {
            console.error('❌ Jupiter WebSocket error:', error.message);
        });

        ws.on('close', (code, reason) => {
            isConnected = false;
            stopHeartbeat();
            
            const reasonStr = reason?.toString() || 'unknown';
            console.warn(`⚠️  Jupiter WebSocket closed: ${code} - ${reasonStr}`);
            
            // Schedule reconnection
            scheduleReconnect();
        });

        ws.on('ping', () => {
            ws.pong();
        });

    } catch (error) {
        console.error('❌ Failed to create Jupiter WebSocket:', error.message);
        scheduleReconnect();
    }
}

/**
 * Start the Jupiter Price WebSocket service
 * 
 * Connects to Jupiter WebSocket and subscribes to SOL and CAKE price updates.
 * Prices are cached in Redis with 60s TTL.
 * 
 * @returns {Promise<void>}
 * 
 * @example
 * import { startPriceWebSocket } from './services/jupiter-price-ws.service.js';
 * await startPriceWebSocket();
 */
export async function startPriceWebSocket() {
    // Ensure Redis is initialized (uses shared connection)
    initializeRedis();
    
    if (process.env.LOG_LEVEL === 'debug') {
        console.log('🚀 Starting Jupiter Price WebSocket...');
    }
    await connect();
}

/**
 * Stop the Jupiter Price WebSocket service
 * 
 * Cleanly closes the WebSocket connection and clears all timers.
 * 
 * @returns {void}
 */
export function stopPriceWebSocket() {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log('🛑 Stopping Jupiter Price WebSocket...');
    }
    
    stopHeartbeat();
    
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    
    if (ws) {
        try {
            ws.close(1000, 'Service stopping');
        } catch (_) {
            ws.terminate();
        }
        ws = null;
    }
    
    isConnected = false;
    reconnectAttempts = 0;
    
    if (process.env.LOG_LEVEL === 'debug') {
        console.log('✅ Jupiter Price WebSocket stopped');
    }
}

/**
 * Get current SOL price from cache
 * 
 * Returns the most recent SOL price from Redis/memory cache.
 * Falls back to null if no recent price available.
 * 
 * @param {number} [maxAgeSeconds=60] - Maximum age in seconds for cached price
 * @returns {Promise<number|null>} SOL price in USD or null if unavailable/stale
 * 
 * @example
 * const solPrice = await getSolPrice();
 * if (solPrice) {
 *   console.log(`SOL: $${solPrice.toFixed(2)}`);
 * }
 */
export async function getSolPrice(maxAgeSeconds = 60) {
    return getPriceFromCache('sol', maxAgeSeconds);
}

/**
 * Get current CAKE price from cache
 * 
 * Returns the most recent CAKE price from Redis/memory cache.
 * Falls back to null if no recent price available.
 * 
 * @param {number} [maxAgeSeconds=60] - Maximum age in seconds for cached price
 * @returns {Promise<number|null>} CAKE price in USD or null if unavailable/stale
 * 
 * @example
 * const cakePrice = await getCakePrice();
 * if (cakePrice) {
 *   console.log(`CAKE: $${cakePrice.toFixed(2)}`);
 * }
 */
export async function getCakePrice(maxAgeSeconds = 60) {
    return getPriceFromCache('cake', maxAgeSeconds);
}

/**
 * Get price for any subscribed token by mint address
 * 
 * @param {string} mint - Token mint address
 * @param {number} [maxAgeSeconds=60] - Maximum age in seconds
 * @returns {Promise<number|null>} Token price in USD or null
 * 
 * @example
 * const price = await getTokenPriceWs(SOL_MINT);
 */
export async function getTokenPriceWs(mint, maxAgeSeconds = 60) {
    const key = MINT_TO_KEY[mint];
    if (!key) return null;
    
    return getPriceFromCache(key, maxAgeSeconds);
}

/**
 * Check if WebSocket is connected
 * 
 * @returns {boolean} True if connected
 */
export function isWebSocketConnected() {
    return isConnected && ws && ws.readyState === WebSocket.OPEN;
}

/**
 * Get WebSocket status for diagnostics
 * 
 * @returns {{connected: boolean, reconnectAttempts: number, subscribedTokens: number, memoryCacheSize: number}}
 */
export function getWebSocketStatus() {
    return {
        connected: isConnected,
        reconnectAttempts,
        subscribedTokens: Object.keys(MINT_TO_KEY).length,
        memoryCacheSize: memoryCache.size
    };
}
