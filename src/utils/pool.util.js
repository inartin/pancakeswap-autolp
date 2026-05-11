import { getCachedPoolMetrics, setCachedPoolMetrics } from '../cache/redis-cache.util.js';

/**
 * Fetches PancakeSwap pool metrics including TVL and APR data
 * 
 * Uses 30-second Redis cache and 2-second timeout for optimal performance
 * 
 * @param {string} poolId - The pool address/ID to fetch metrics for
 * @returns {Promise<{tvl: number|null, poolApr: number|null, feeApr: number|null}|null>} Pool metrics or null on error
 */
export async function fetchPCSPoolMetrics(poolId) {
  // Try cache first (30 second TTL)
  const cached = await getCachedPoolMetrics(poolId);
  if (cached) {
    return cached;
  }

  // Fetch from API with timeout
  try {
    const url = `https://sol-explorer.pancakeswap.com/api/cached/v1/pools/info/ids?ids=${poolId}`;
    
    // Add 2 second timeout to prevent slow API from blocking
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!res.ok) return null;
    const json = await res.json();
    const arr = json && json.data;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const item = arr[0];
    const tvl = typeof item.tvl === "number" ? item.tvl : null;
    const day = item && item.day;
    const poolApr = day && typeof day.apr === "number" ? day.apr : null;
    const feeApr = day && typeof day.feeApr === "number" ? day.feeApr : null;
    
    const metrics = { tvl, poolApr, feeApr };
    
    // Cache the result (fire and forget)
    setCachedPoolMetrics(poolId, metrics).catch(() => {});
    
    return metrics;
  } catch (error) {
    // Timeout or network error
    return null;
  }
}