/**
 * Impermanent Loss Calculator
 * 
 * Estimates IL cost and compares with expected fee income
 * to make profitable rebalancing decisions.
 * 
 * Core philosophy: Only rebalance when Net Profit > 0
 * Net Profit = Expected Fees - (IL Cost + Transaction Costs)
 * 
 * @module utils/il-calculator
 */

import { calculateCompleteApr } from './apr.util.js';
import { AUTO_REBALANCE_CONFIG } from '../config/constants.js';

/**
 * Estimate impermanent loss from token holdings deviation
 * 
 * When a position goes out of range, token holdings become imbalanced.
 * Rebalancing forces a swap back to optimal ratio, crystallizing this loss.
 * 
 * Formula: IL ≈ deviation × totalValue × severityFactor
 * where deviation = |current0Percent - optimal0Percent|
 * 
 * @param {number} current0Usd - Current USD value of token0 holdings
 * @param {number} current1Usd - Current USD value of token1 holdings
 * @param {number} optimal0Percent - Optimal token0 percentage (0-1) from CLMM math
 * @returns {number} Estimated IL in USD
 * 
 * @example
 * // Position worth $1000 with 70% token0, 30% token1 (optimal: 50/50)
 * const il = estimateImpermanentLoss(700, 300, 0.5);
 * // Returns: 0.2 * 1000 * 0.6 = $120 estimated IL
 */
export function estimateImpermanentLoss(current0Usd, current1Usd, optimal0Percent) {
  const totalUsd = current0Usd + current1Usd;
  if (totalUsd === 0) return 0;
  
  const current0Percent = current0Usd / totalUsd;
  const deviation = Math.abs(current0Percent - optimal0Percent);
  
  const config = AUTO_REBALANCE_CONFIG.SAFETY.IL_BREAKEVEN;
  const estimatedIL = deviation * totalUsd * config.ilSeverityFactor;
  
  return estimatedIL;
}

/**
 * Estimate rebalance costs (gas + slippage)
 * 
 * Total rebalance cost breakdown:
 * - Gas cost: ~$0.10 for close + swap + open operations
 * - Slippage: ~1.5% of position value (average on Solana DEXes)
 * 
 * @param {number} positionValueUsd - Position value in USD
 * @returns {number} Estimated costs in USD
 * 
 * @example
 * const costs = estimateRebalanceCosts(1000);
 * // Returns: 0.10 + (1000 * 0.015) = $15.10
 */
export function estimateRebalanceCosts(positionValueUsd) {
  const gasCost = 0.10; // ~$0.10 for full rebalance operation (Solana)
  const slippageCost = positionValueUsd * 0.015; // 1.5% average slippage
  return gasCost + slippageCost;
}

/**
 * Estimate fee income if position stays in range
 * 
 * Projects future fee earnings based on:
 * - Current pool fee APR
 * - Position value
 * - Expected time in range after rebalance
 * 
 * Formula: fees = positionValue × (feeApr / 100 / 8760) × hours
 * 
 * @param {number} positionValueUsd - Position value in USD
 * @param {number} poolFeeApr - Pool fee APR percentage (e.g., 50 for 50%)
 * @param {number} [hoursInRange=12] - Expected hours in range after rebalance
 * @returns {number} Estimated fee income in USD
 * 
 * @example
 * // $1000 position, 50% APR, 12 hours in range
 * const fees = estimateFeeIncome(1000, 50, 12);
 * // Returns: 1000 × (50/100/8760) × 12 = $6.85
 */
export function estimateFeeIncome(positionValueUsd, poolFeeApr, hoursInRange = 12) {
  if (!poolFeeApr || poolFeeApr <= 0) return 0;
  const hourlyRate = poolFeeApr / 100 / 8760; // 8760 hours per year
  return positionValueUsd * hourlyRate * hoursInRange;
}

/**
 * Check if rebalance is profitable (IL + costs vs expected fees)
 * 
 * Decision logic:
 * 1. Calculate IL from current token imbalance
 * 2. Calculate transaction costs (gas + slippage)
 * 3. Estimate fee income if we rebalance and stay in range
 * 4. Require: expectedFees ≥ totalCosts × minBreakEvenRatio
 * 
 * @param {Object} position - Position from database
 * @param {string} position.pool_address - Pool address for APR lookup
 * @param {number} position.liquidity_usd - Position value in USD
 * @param {bigint|string} position.liquidity - Position liquidity amount
 * @param {bigint|string} position.pool_liquidity - Pool total liquidity
 * @param {Object} rangeData - Position range data
 * @param {number} rangeData.amount0Usd - USD value of token0
 * @param {number} rangeData.amount1Usd - USD value of token1
 * @param {number} rangeData.optimalToken0Percent - Optimal token0 ratio (0-1)
 * @returns {Promise<Object>} Profitability analysis
 * @returns {boolean} returns.profitable - Whether rebalance is profitable
 * @returns {number} returns.breakEvenRatio - Ratio of expected fees to costs
 * @returns {number} returns.estimatedIL - Estimated IL in USD
 * @returns {number} returns.estimatedCosts - Transaction costs in USD
 * @returns {number} returns.totalCost - Total cost (IL + transaction costs)
 * @returns {number} returns.expectedFees - Expected fee income
 * @returns {number} returns.netProfit - Net profit (fees - costs)
 * @returns {string} returns.reason - Human-readable explanation
 * 
 * @example
 * const result = await isRebalanceProfitable(position, rangeData);
 * if (result.profitable) {
 *   console.log(result.reason); // "Profitable (2.5x ratio, +$10.50)"
 * } else {
 *   console.log(result.reason); // "Unprofitable (0.8x ratio, IL: $5, costs: $2, fees: $5)"
 * }
 */
export async function isRebalanceProfitable(position, rangeData) {
  const config = AUTO_REBALANCE_CONFIG.SAFETY.IL_BREAKEVEN;
  
  if (!config.enabled) {
    return { profitable: true, reason: 'IL check disabled' };
  }
  
  // Calculate IL from current token imbalance
  const il = estimateImpermanentLoss(
    rangeData.amount0Usd,
    rangeData.amount1Usd,
    rangeData.optimalToken0Percent
  );
  
  // Calculate transaction costs
  const costs = estimateRebalanceCosts(position.liquidity_usd);
  const totalCost = il + costs;
  
  // Estimate fee income (fetch pool APR)
  const aprData = await calculateCompleteApr({
    poolId: position.pool_address,
    inRange: true, // Assume we'll be in range after rebalance
    positionLiquidity: position.liquidity,
    poolLiquidity: position.pool_liquidity,
    positionValueUsd: position.liquidity_usd
  });
  
  const poolFeeApr = aprData?.feeApr || 0;
  const expectedFees = estimateFeeIncome(
    position.liquidity_usd,
    poolFeeApr,
    config.expectedHoursInRange
  );
  
  // Check profitability: fees must exceed costs by required margin
  const breakEvenRatio = totalCost > 0 ? expectedFees / totalCost : Infinity;
  const profitable = breakEvenRatio >= config.minBreakEvenRatio;
  
  return {
    profitable,
    breakEvenRatio,
    estimatedIL: il,
    estimatedCosts: costs,
    totalCost,
    expectedFees,
    netProfit: expectedFees - totalCost,
    reason: profitable 
      ? `Profitable (${breakEvenRatio.toFixed(2)}x ratio, +$${(expectedFees - totalCost).toFixed(2)})`
      : `Unprofitable (${breakEvenRatio.toFixed(2)}x ratio, IL: $${il.toFixed(2)}, costs: $${costs.toFixed(2)}, fees: $${expectedFees.toFixed(2)})`
  };
}

