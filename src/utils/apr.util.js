/**
 * APR Calculation Utilities
 * 
 * Complete standalone module for calculating position APR based on pool metrics,
 * liquidity share, and range status. Includes pool metrics fetching.
 */

import { fetchPCSPoolMetrics } from './pool.util.js';

/**
 * Helper: Convert various types to BigInt
 * 
 * @param {any} x - Value to convert
 * @returns {bigint|null} BigInt value or null
 */
function toBigInt(x) {
  if (x == null) return null;
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return BigInt(x);
  if (typeof x === "string") return BigInt(x);
  if (typeof x.toString === "function") return BigInt(x.toString());
  return null;
}

/**
 * Calculate position-specific APR based on pool metrics and liquidity share
 * 
 * Formula: positionApr ≈ poolApr × share × (poolTVL / positionValue)
 * where share = positionLiquidity / poolLiquidity (only when in range)
 * 
 * @param {Object} options - Calculation parameters
 * @param {boolean} options.inRange - Whether position is in range
 * @param {number|null} options.poolDayApr - Pool APR percentage (e.g., 25.5 for 25.5%)
 * @param {number|null} options.poolTvlUsd - Pool TVL in USD
 * @param {bigint|number|string} options.positionLiquidity - Position liquidity amount
 * @param {bigint|number|string} options.poolLiquidity - Total pool liquidity
 * @param {number} options.positionValueUsd - Position value in USD
 * @returns {number|null} Position APR percentage or null if cannot be calculated
 */
export function calculatePositionApr({
  inRange,
  poolDayApr,
  poolTvlUsd,
  positionLiquidity,
  poolLiquidity,
  positionValueUsd
}) {
  // Position APR is 0% when out of range
  if (!inRange) {
    return 0;
  }

  // Check if we have all required data
  if (
    poolDayApr == null ||
    poolTvlUsd == null ||
    !positionValueUsd ||
    positionValueUsd <= 0
  ) {
    return null;
  }

  // Calculate position share: s = L_pos / L_pool
  const Lpos = toBigInt(positionLiquidity) ?? 0n;
  const Lpool = toBigInt(poolLiquidity) ?? 0n;
  
  if (Lpool === 0n) {
    return null;
  }

  const share = Number(Lpos) / Number(Lpool);

  // Position APR approximation: scale pool APR by active share and USD normalization
  // positionApr ≈ poolDayApr * share * (poolTVL / positionValue)
  const positionApr = poolDayApr * share * (poolTvlUsd / positionValueUsd);

  return positionApr;
}

/**
 * Calculate estimated income based on APR and position value
 * 
 * @param {number|null} aprPct - APR percentage (e.g., 25.5 for 25.5%)
 * @param {number} positionValueUsd - Position value in USD
 * @returns {{estHourUsd: number|null, estDayUsd: number|null}} Estimated hourly and daily income in USD
 */
export function calculateEstimatedIncome(aprPct, positionValueUsd) {
  if (aprPct == null || !positionValueUsd || positionValueUsd <= 0) {
    return { estHourUsd: null, estDayUsd: null };
  }

  const aprDecimal = aprPct / 100;
  const estDayUsd = positionValueUsd * aprDecimal / 365;
  const estHourUsd = estDayUsd / 24;

  return { estHourUsd, estDayUsd };
}

/**
 * Get current APR for display (pool APR when in range, 0% when out of range)
 * 
 * @param {boolean} inRange - Whether position is in range
 * @param {number|null} poolDayApr - Pool APR percentage
 * @returns {number|null} Current APR percentage
 */
export function getCurrentApr(inRange, poolDayApr) {
  return inRange ? (poolDayApr ?? null) : 0;
}

/**
 * Complete APR calculation with pool metrics fetching
 * 
 * All-in-one function that fetches pool metrics and calculates position APR.
 * 
 * @param {Object} options - Calculation parameters
 * @param {string} options.poolId - Pool address
 * @param {boolean} options.inRange - Whether position is in range
 * @param {bigint|number|string} options.positionLiquidity - Position liquidity amount
 * @param {bigint|number|string} options.poolLiquidity - Total pool liquidity
 * @param {number} options.positionValueUsd - Position value in USD
 * @returns {Promise<{
 *   poolApr: number|null,
 *   feeApr: number|null,
 *   tvl: number|null,
 *   currentApr: number|null,
 *   positionApr: number|null,
 *   estHourUsd: number|null,
 *   estDayUsd: number|null
 * }>} Complete APR data
 */
export async function calculateCompleteApr({
  poolId,
  inRange,
  positionLiquidity,
  poolLiquidity,
  positionValueUsd
}) {
  // Fetch pool metrics
  const poolMetrics = await fetchPCSPoolMetrics(poolId);
  const poolApr = poolMetrics && poolMetrics.poolApr != null ? poolMetrics.poolApr : null;
  const feeApr = poolMetrics && poolMetrics.feeApr != null ? poolMetrics.feeApr : null;
  const tvl = poolMetrics && poolMetrics.tvl != null ? poolMetrics.tvl : null;

  // Calculate current APR (what the pool is earning)
  const currentApr = getCurrentApr(inRange, poolApr);

  // Calculate position-specific APR
  const positionApr = calculatePositionApr({
    inRange,
    poolDayApr: poolApr,
    poolTvlUsd: tvl,
    positionLiquidity,
    poolLiquidity,
    positionValueUsd
  });

  // Calculate estimated income
  const { estHourUsd, estDayUsd } = calculateEstimatedIncome(positionApr, positionValueUsd);

  return {
    poolApr,
    feeApr,
    tvl,
    currentApr,
    positionApr,
    estHourUsd,
    estDayUsd
  };
}
