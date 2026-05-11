/**
 * Compound Rewards Utility
 *
 * Automatically compounds position rewards by:
 * 1. Claiming all rewards and fees from the position
 * 2. Swapping non-pool tokens to pool tokens using Jupiter
 * 3. Balancing token amounts to match pool's current price ratio
 * 4. Adding balanced liquidity back to the position
 *
 * Features:
 * - Handles up to 3 different token types (2 fee tokens + 1-3 reward tokens)
 * - Automatically swaps non-pool tokens using Jupiter's best routes
 * - Ensures no additional funds are used beyond what was claimed
 * - Optimizes token ratio based on pool's current price
 * - Comprehensive error handling and transaction tracking
 *
 * @module compound.util
 */

import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { claimRewards, transferToClaimAddress } from './claim.util.js';
import { swapTokensUltra } from './jupiter-ultra.util.js';
import { addLiquidity } from './add-liquidity.util.js';
import {
  PROGRAM_ID,
  PANCAKESWAP_IDL,
  MIN_UTILIZATION_PERCENT,
  FINALIZATION_DELAY_MS,
  MIN_USD_TO_COMPOUND,
  MIN_USD_FOR_AUTO_BALANCE,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS
} from '../config/constants.js';
import { getMintDecimals } from './token.util.js';
import { derivePersonalPosition } from './accounts.util.js';
import { formatCurrency } from './format.util.js';

/**
 * Convert human-readable amount to raw token amount
 * 
 * @param {number} amount - Human-readable amount
 * @param {number} decimals - Token decimals
 * @returns {bigint} Raw token amount
 */
function toRawAmount(amount, decimals) {
  try {
    const multiplier = 10 ** decimals;
    return BigInt(Math.floor(amount * multiplier));
  } catch {
    return 0n;
  }
}

/**
 * Wait for blockchain finalization after claim
 * Ensures tokens are fully settled before proceeding to swaps
 *
 * @param {number} delay - Delay in milliseconds (defaults to FINALIZATION_DELAY_MS)
 * @returns {Promise<void>}
 */
async function waitForFinalization(delay = FINALIZATION_DELAY_MS) {
  console.log(`\n⏳ Waiting ${delay/1000}s for blockchain finalization...`);
  await new Promise(resolve => setTimeout(resolve, delay));
  console.log('✅ Ready to proceed');
}

/**
 * Calculate optimal token amounts based on pool's current price and position range
 * 
 * This uses CLMM math to determine the ideal ratio of token0 to token1
 * based on the pool's current price and the position's tick range.
 * 
 * @param {bigint} sqrtPriceX64 - Current pool sqrt price
 * @param {number} tickLower - Position lower tick
 * @param {number} tickUpper - Position upper tick
 * @param {number} tickCurrent - Current pool tick
 * @returns {Object} Token ratio information
 */
function calculateTokenRatio(sqrtPriceX64, tickLower, tickUpper, tickCurrent) {
  // Convert sqrt price to actual price
  const sqrtPriceNum = Number(sqrtPriceX64) / (2 ** 64);
  const price = sqrtPriceNum * sqrtPriceNum;
  
  // Calculate sqrt prices at bounds
  const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);
  const sqrtPriceCurrent = Math.sqrt(1.0001 ** tickCurrent);
  
  // Check if position is in range
  const inRange = tickCurrent >= tickLower && tickCurrent <= tickUpper;
  
  if (!inRange) {
    // If out of range, return extreme ratios
    if (tickCurrent < tickLower) {
      // All token0, no token1
      return { token0Percent: 1.0, token1Percent: 0.0, inRange: false };
    } else {
      // All token1, no token0
      return { token0Percent: 0.0, token1Percent: 1.0, inRange: false };
    }
  }
  
  // Calculate liquidity distribution
  // For a position in range:
  // token0_value = L × (sqrt(P_upper) - sqrt(P_current)) / (sqrt(P_upper) × sqrt(P_current))
  // token1_value = L × (sqrt(P_current) - sqrt(P_lower))
  
  const token0Factor = (sqrtPriceUpper - sqrtPriceCurrent) / (sqrtPriceUpper * sqrtPriceCurrent);
  const token1Factor = sqrtPriceCurrent - sqrtPriceLower;
  
  // Convert to same units (multiply token0Factor by current price)
  const token0Value = token0Factor * price;
  const token1Value = token1Factor;
  
  const totalValue = token0Value + token1Value;
  
  return {
    token0Percent: token0Value / totalValue,
    token1Percent: token1Value / totalValue,
    inRange: true
  };
}

/**
 * Calculate how much of each token can be deposited given the optimal ratio
 * 
 * This determines the maximum amounts that can be deposited while maintaining
 * the correct ratio. If one token is limiting, the other is scaled down.
 * 
 * @param {number} amount0Available - Available token0 amount
 * @param {number} amount1Available - Available token1 amount
 * @param {number} token0Percent - Optimal token0 percentage (0-1)
 * @param {number} token1Percent - Optimal token1 percentage (0-1)
 * @param {number} price0Usd - Token0 USD price
 * @param {number} price1Usd - Token1 USD price
 * @returns {Object} Amounts that can be deposited
 */
function calculateDepositableAmounts(
  amount0Available,
  amount1Available,
  token0Percent,
  token1Percent,
  price0Usd,
  price1Usd
) {
  // If out of range, handle edge cases
  if (token0Percent === 1.0) {
    return { amount0: amount0Available, amount1: 0 };
  }
  if (token1Percent === 1.0) {
    return { amount0: 0, amount1: amount1Available };
  }
  
  // Calculate total USD value available
  const usd0Available = amount0Available * price0Usd;
  const usd1Available = amount1Available * price1Usd;
  const totalUsdAvailable = usd0Available + usd1Available;
  
  // Calculate optimal USD allocation
  const usd0Optimal = totalUsdAvailable * token0Percent;
  const usd1Optimal = totalUsdAvailable * token1Percent;
  
  // Check which token is limiting
  // We can use at most what we have available
  let usd0ToUse, usd1ToUse;
  
  if (usd0Optimal > usd0Available) {
    // Token0 is limiting - use all token0 and scale down token1
    usd0ToUse = usd0Available;
    usd1ToUse = usd0Available * (token1Percent / token0Percent);
    
    // Ensure we don't exceed available token1
    if (usd1ToUse > usd1Available) {
      usd1ToUse = usd1Available;
      usd0ToUse = usd1Available * (token0Percent / token1Percent);
    }
  } else if (usd1Optimal > usd1Available) {
    // Token1 is limiting - use all token1 and scale down token0
    usd1ToUse = usd1Available;
    usd0ToUse = usd1Available * (token0Percent / token1Percent);
    
    // Ensure we don't exceed available token0
    if (usd0ToUse > usd0Available) {
      usd0ToUse = usd0Available;
      usd1ToUse = usd0Available * (token1Percent / token0Percent);
    }
  } else {
    // Both tokens are sufficient - use optimal amounts
    usd0ToUse = usd0Optimal;
    usd1ToUse = usd1Optimal;
  }
  
  // Convert back to token amounts
  const amount0 = usd0ToUse / price0Usd;
  const amount1 = usd1ToUse / price1Usd;
  
  return {
    amount0: Math.min(amount0, amount0Available),
    amount1: Math.min(amount1, amount1Available)
  };
}

/**
 * Compound position rewards automatically
 * 
 * This is the main compounding function that orchestrates:
 * 1. Claiming all rewards and fees
 * 2. Analyzing and categorizing claimed tokens
 * 3. Swapping non-pool tokens to pool tokens
 * 4. Balancing token amounts for optimal liquidity addition
 * 5. Adding liquidity back to the position
 * 
 * **Process Flow:**
 * 
 * 1. **Claim Step**: 
 *    - Calls `claimRewards()` to collect all fees and reward tokens
 *    - If claimAddress is set, splits non-SOL tokens 50/50 (SOL kept 100% for fees/reserves)
 *    - Returns if nothing was claimed
 * 
 * 2. **Analysis Step**:
 *    - Fetches pool information (token0, token1, current price)
 *    - Categorizes claimed tokens as pool tokens vs. extra tokens
 *    - Determines which tokens need to be swapped
 * 
 * 3. **Swap Step**:
 *    - Identifies extra tokens (not in pool pair)
 *    - Swaps extra tokens to the pool token with lower balance
 *    - Uses Jupiter for best routing and pricing
 *    - Applies slippage protection
 * 
 * 4. **Balance Step**:
 *    - Calculates optimal token ratio based on CLMM math
 *    - Only performs balance swaps if claimed value > $5
 *    - If under $5, skips balance swaps to save on fees
 * 
 * 5. **Add Liquidity Step**:
 *    - Calculates depositable amounts based on optimal ratio
 *    - Only deposits what fits the position's ratio requirements
 *    - Returns comprehensive result with all transaction details
 * 
 * 6. **Transfer Step** (if claimAddress is set):
 *    - Transfers 50% of non-SOL tokens to claim address
 *    - SOL is kept 100% for transaction fees and reserves
 *    - Skips dust transfers (< $0.10)
 * 
 * @param {Connection} connection - Solana connection
 * @param {Keypair} wallet - Wallet keypair (owner of position)
 * @param {PublicKey} positionMintPk - Position NFT mint address
 * @param {Object} options - Configuration options
 * @param {number} [options.slippageBps=100] - Slippage tolerance in basis points (default: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS = 100 = 1%)
 * @param {number} [options.swapSlippageBps=100] - Slippage for Jupiter swaps in bps (default: DEFAULT_SWAP_SLIPPAGE_BPS = 100 = 1%)
 * @param {boolean} [options.autoBalance=true] - Auto-balance only if claimed > MIN_USD_FOR_AUTO_BALANCE (saves fees on small amounts)
 * @param {number} [options.minUsdToCompound=MIN_USD_TO_COMPOUND] - Minimum USD value to compound (skip entirely if less)
 * @param {string|null} [options.claimAddress=null] - If set, compounds all SOL + 50% of other tokens, transfers rest
 * @param {Function} [options.onProgress] - Progress callback function(phase, data)
 * 
 * @returns {Promise<Object>} Result with all transaction details
 * @returns {boolean} return.success - Whether compounding was successful
 * @returns {Object} [return.claimResult] - Result from claim phase
 * @returns {Array<Object>} [return.swaps] - All swap transactions performed
 * @returns {Object} [return.addLiquidityResult] - Result from add liquidity phase
 * @returns {Object} [return.transfer] - Transfer result if claimAddress was used
 * @returns {Object} [return.fees] - Transaction fees breakdown (claimFee, swapFees[], addLiquidityFee, transferFee, totalSol)
 * @returns {Object} [return.summary] - Summary statistics including totalFeesSol and totalTransactions
 * @returns {string} [return.error] - Error message if failed
 * 
 * @example
 * // Basic compound with default settings
 * const result = await compoundRewards(connection, wallet, positionMint);
 * 
 * @example
 * // Compound with split mode (all SOL + 50% other tokens compound, 50% other tokens to claim address)
 * const result = await compoundRewards(connection, wallet, positionMint, {
 *   claimAddress: 'YourSolanaAddress...',
 *   slippageBps: 300,
 *   swapSlippageBps: 150,
 *   minUsdToCompound: 5
 * });
 * 
 * if (result.success) {
 *   console.log(`Compounded $${result.summary.totalUsdCompounded}`);
 *   if (result.transfer?.transferred) {
 *     console.log(`Transferred $${result.transfer.totalUsd} (non-SOL) to claim address`);
 *   }
 * }
 */
export async function compoundRewards(connection, wallet, positionMintPk, options = {}) {
  const {
    slippageBps = DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS,
    swapSlippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
    autoBalance = true,
    minUsdToCompound = MIN_USD_TO_COMPOUND,
    claimAddress = null,
    onProgress = null
  } = options;

  const coder = new BorshCoder(PANCAKESWAP_IDL);

  try {
    console.log('\n🔄 Starting Compound Process...\n');

    // ============================================================
    // STEP 1: CLAIM REWARDS
    // ============================================================
    console.log('📥 Step 1: Claiming rewards and fees...');
    if (onProgress) await onProgress('claim_start', { phase: 1, total: 5 });
    
    const claimResult = await claimRewards(connection, wallet, positionMintPk);

    if (!claimResult.success) {
      return {
        success: false,
        error: `Failed to claim rewards: ${claimResult.error}`,
        phase: 'claim'
      };
    }

    if (!claimResult.claimed || claimResult.claimed.length === 0) {
      return {
        success: true,
        message: 'No rewards to compound',
        claimResult,
        summary: {
          totalUsdClaimed: 0,
          totalUsdCompounded: 0,
          swapCount: 0
        }
      };
    }

    // Check if claimed value meets minimum threshold
    if (claimResult.totalUsd < minUsdToCompound) {
      return {
        success: true,
        message: `Claimed amount (${formatCurrency(claimResult.totalUsd)}) below minimum threshold (${formatCurrency(minUsdToCompound)})`,
        claimResult,
        summary: {
          totalUsdClaimed: claimResult.totalUsd,
          totalUsdCompounded: 0,
          swapCount: 0
        }
      };
    }

    console.log(`✅ Claimed ${claimResult.claimed.length} token(s) worth $${claimResult.totalUsd.toFixed(2)}`);
    claimResult.claimed.forEach(token => {
      console.log(`   - ${token.uiAmount} ${token.symbol} ($${token.usdValue?.toFixed(2) || 'N/A'})`);
    });

    if (onProgress) await onProgress('claim_complete', { phase: 1, total: 5, claimResult });

    // ============================================================
    // SPLIT TOKENS 50/50 IF CLAIM ADDRESS IS SET
    // ============================================================
    let tokensForCompound = claimResult.claimed;
    let tokensForTransfer = null;
    const usingSplitMode = claimAddress !== null;

    if (usingSplitMode) {
      console.log(`\n🔀 Claim Address Detected: Splitting Rewards (SOL kept for fees)`);
      console.log(`   Transfer to: ${claimAddress.slice(0, 8)}...${claimAddress.slice(-8)}`);
      
      // Identify SOL/WSOL token (needed for fees and reserves)
      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      const isSolToken = (token) => token.mint === WSOL_MINT || token.symbol === 'SOL' || token.symbol === 'WSOL';
      
      // Split tokens: Keep 100% SOL/WSOL for compound, split others 50/50
      tokensForCompound = claimResult.claimed.map(token => {
        if (isSolToken(token)) {
          // Keep 100% of SOL for fees, reserves, and wrapping
          console.log(`   ℹ️  Keeping 100% ${token.symbol} for transaction fees & reserves`);
          return { ...token };
        } else {
          // Split other tokens 50/50
          return {
            ...token,
            amount: (BigInt(token.amount) / 2n).toString(),
            uiAmount: token.uiAmount / 2,
            usdValue: (token.usdValue || 0) / 2
          };
        }
      });
      
      tokensForTransfer = claimResult.claimed
        .map(token => {
          if (isSolToken(token)) {
            // Don't transfer SOL - it's needed for compound
            return null;
          } else {
            // Transfer 50% of other tokens
            return {
              ...token,
              amount: (BigInt(token.amount) / 2n).toString(),
              uiAmount: token.uiAmount / 2,
              usdValue: (token.usdValue || 0) / 2
            };
          }
        })
        .filter(token => token !== null); // Remove nulls (SOL)
      
      const compoundUsd = tokensForCompound.reduce((sum, t) => sum + (t.usdValue || 0), 0);
      const transferUsd = tokensForTransfer.reduce((sum, t) => sum + (t.usdValue || 0), 0);
      
      console.log(`   Compound portion: ${formatCurrency(compoundUsd)} (includes all SOL)`);
      console.log(`   Transfer portion: ${formatCurrency(transferUsd)} (non-SOL tokens)`);
    }

    // Wait for blockchain finalization after claim
    await waitForFinalization();

    // ============================================================
    // STEP 2: ANALYZE POOL AND CATEGORIZE TOKENS
    // ============================================================
    console.log('\n🔍 Step 2: Analyzing pool and tokens...');
    if (onProgress) await onProgress('analyze_start', { phase: 2, total: 5 });

    // Derive position PDA
    const personalPositionPk = await derivePersonalPosition(positionMintPk);

    // Fetch position to get pool ID
    const positionAi = await connection.getAccountInfo(personalPositionPk);
    if (!positionAi) throw new Error("Position account not found");
    const position = coder.accounts.decode("PersonalPositionState", positionAi.data);

    // Fetch pool information
    const poolPk = new PublicKey(position.pool_id);
    const poolAi = await connection.getAccountInfo(poolPk);
    if (!poolAi) throw new Error("Pool account not found");
    const pool = coder.accounts.decode("PoolState", poolAi.data);

    const mint0 = new PublicKey(pool.token_mint_0);
    const mint1 = new PublicKey(pool.token_mint_1);
    const mint0Str = mint0.toBase58();
    const mint1Str = mint1.toBase58();

    console.log(`✅ Pool tokens: ${mint0Str.slice(0, 8)}... / ${mint1Str.slice(0, 8)}...`);

    // Categorize claimed tokens (using compound portion if split mode is active)
    const token0Claimed = tokensForCompound.find(t => t.mint === mint0Str);
    const token1Claimed = tokensForCompound.find(t => t.mint === mint1Str);
    const extraTokens = tokensForCompound.filter(t => t.mint !== mint0Str && t.mint !== mint1Str);

    console.log(`   Pool Token 0: ${token0Claimed ? token0Claimed.uiAmount : 0} (${token0Claimed?.symbol || 'none'})`);
    console.log(`   Pool Token 1: ${token1Claimed ? token1Claimed.uiAmount : 0} (${token1Claimed?.symbol || 'none'})`);
    console.log(`   Extra Tokens: ${extraTokens.length}`);

    if (onProgress) await onProgress('analyze_complete', { phase: 2, total: 5, extraTokens: extraTokens.length });

    // ============================================================
    // STEP 3: SWAP EXTRA TOKENS TO POOL TOKENS
    // ============================================================
    if (onProgress) await onProgress('swap_start', { phase: 3, total: 5, extraTokenCount: extraTokens.length });
    
    const swaps = [];
    let currentToken0Amount = token0Claimed?.uiAmount || 0;
    let currentToken1Amount = token1Claimed?.uiAmount || 0;
    let currentToken0Decimals = token0Claimed?.decimals || await getMintDecimals(connection, mint0);
    let currentToken1Decimals = token1Claimed?.decimals || await getMintDecimals(connection, mint1);
    
    // Track transaction fees
    const fees = {
      claimFee: claimResult.transactionFee || 0, // SOL
      swapFees: [], // Array of SOL fees
      addLiquidityFee: 0, // SOL
      totalSol: claimResult.transactionFee || 0 // Running total in SOL
    };

    if (extraTokens.length > 0) {
      console.log('\n💱 Step 3: Swapping extra tokens to pool tokens...');

      for (const extraToken of extraTokens) {
        console.log(`\n   Swapping ${extraToken.uiAmount} ${extraToken.symbol}...`);

        // Determine target token (swap to whichever pool token has lower USD value)
        const token0UsdValue = currentToken0Amount * (token0Claimed?.usdValue || 0) / (token0Claimed?.uiAmount || 1);
        const token1UsdValue = currentToken1Amount * (token1Claimed?.usdValue || 0) / (token1Claimed?.uiAmount || 1);
        
        const swapToToken0 = token0UsdValue < token1UsdValue;
        const targetMint = swapToToken0 ? mint0Str : mint1Str;
        const targetSymbol = swapToToken0 ? (token0Claimed?.symbol || 'token0') : (token1Claimed?.symbol || 'token1');

        console.log(`   → Target: ${targetSymbol} (lower balance)`);

        // Swap using Jupiter
        const swapAmount = toRawAmount(extraToken.uiAmount, extraToken.decimals);
        
        const swapResult = await swapTokensUltra({
          connection,
          wallet,
          inputMint: extraToken.mint,
          outputMint: targetMint,
          amount: swapAmount,
          slippageBps: swapSlippageBps,
          waitForConfirmation: true
        });

        if (!swapResult.success) {
          console.log(`   ⚠️  Swap failed: ${swapResult.error}`);
          console.log(`   Continuing with remaining tokens...`);
          continue;
        }

        // Calculate output amount from quote
        const outputDecimals = swapToToken0 ? currentToken0Decimals : currentToken1Decimals;
        const outputAmount = Number(swapResult.quote.outputAmount) / (10 ** outputDecimals);

        console.log(`   ✅ Swapped successfully`);
        console.log(`   Received: ${outputAmount.toFixed(6)} ${targetSymbol}`);

        // Update token balances
        if (swapToToken0) {
          currentToken0Amount += outputAmount;
        } else {
          currentToken1Amount += outputAmount;
        }

        // Track swap fee
        const swapFee = swapResult.transactionFee || 0;
        fees.swapFees.push(swapFee);
        fees.totalSol += swapFee;

        swaps.push({
          inputToken: extraToken.symbol,
          inputAmount: extraToken.uiAmount,
          outputToken: targetSymbol,
          outputAmount,
          signature: swapResult.signature,
          explorer: `https://solscan.io/tx/${swapResult.signature}`,
          transactionFee: swapFee
        });
      }

      console.log(`\n✅ Completed ${swaps.length} swap(s)`);
    } else {
      console.log('\n✅ Step 3: No extra tokens to swap (all tokens match pool pair)');
    }

    if (onProgress) await onProgress('swap_complete', { phase: 3, total: 5, swapCount: swaps.length });

    // No finalization delay here - we'll fetch fresh pool state before Step 5
    // to ensure we have the latest price for liquidity calculations

    // ============================================================
    // STEP 4: BALANCE TOKEN AMOUNTS (OPTIONAL)
    // ============================================================
    if (onProgress) await onProgress('balance_start', { phase: 4, total: 5, autoBalance });

    // Calculate optimal ratio based on position range and current price
    const ratio = calculateTokenRatio(
      pool.sqrt_price_x64,
      position.tick_lower_index,
      position.tick_upper_index,
      pool.tick_current
    );

    // Get token USD prices
    const token0UsdPrice = (token0Claimed?.usdValue || 0) / (token0Claimed?.uiAmount || 1);
    const token1UsdPrice = (token1Claimed?.usdValue || 0) / (token1Claimed?.uiAmount || 1);

    // Check if we should perform balance swaps (only if claimed > MIN_USD_FOR_AUTO_BALANCE)
    const shouldBalance = autoBalance &&
                          claimResult.totalUsd > MIN_USD_FOR_AUTO_BALANCE &&
                          currentToken0Amount > 0 &&
                          currentToken1Amount > 0 &&
                          ratio.inRange;
    
    if (shouldBalance) {
      console.log('\n⚖️  Step 4: Balancing token amounts...');

      console.log(`   Position in range: ${ratio.inRange}`);
      console.log(`   Optimal ratio: ${(ratio.token0Percent * 100).toFixed(1)}% token0, ${(ratio.token1Percent * 100).toFixed(1)}% token1`);

      // Calculate current ratio by USD value
      const token0UsdTotal = currentToken0Amount * token0UsdPrice;
      const token1UsdTotal = currentToken1Amount * token1UsdPrice;
      const totalUsd = token0UsdTotal + token1UsdTotal;

      const currentToken0Percent = token0UsdTotal / totalUsd;
      const currentToken1Percent = token1UsdTotal / totalUsd;

      console.log(`   Current ratio: ${(currentToken0Percent * 100).toFixed(1)}% token0, ${(currentToken1Percent * 100).toFixed(1)}% token1`);

      // Check if rebalancing is needed (threshold: 5% difference)
      const ratioImbalance = Math.abs(currentToken0Percent - ratio.token0Percent);
      
      if (ratioImbalance > 0.05) {
        console.log(`   ⚠️  Ratio imbalance detected: ${(ratioImbalance * 100).toFixed(1)}%`);
        console.log(`   Performing balance swap...`);

        // Determine which token to swap
        const needMoreToken0 = currentToken0Percent < ratio.token0Percent;
        
        if (needMoreToken0) {
          // Swap some token1 to token0
          const token1UsdToSwap = (ratio.token0Percent - currentToken0Percent) * totalUsd;
          const token1AmountToSwap = token1UsdToSwap / token1UsdPrice;
          
          // Don't swap more than 50% of balance
          const maxSwap = currentToken1Amount * 0.5;
          const swapAmount = Math.min(token1AmountToSwap, maxSwap);

          console.log(`   Swapping ${swapAmount.toFixed(6)} token1 → token0`);

          const swapResult = await swapTokensUltra({
            connection,
            wallet,
            inputMint: mint1Str,
            outputMint: mint0Str,
            amount: toRawAmount(swapAmount, currentToken1Decimals),
            slippageBps: swapSlippageBps,
            waitForConfirmation: true
          });

          if (swapResult.success) {
            const outputAmount = Number(swapResult.quote.outputAmount) / (10 ** currentToken0Decimals);
            currentToken0Amount += outputAmount;
            currentToken1Amount -= swapAmount;
            
            // Track balance swap fee
            const balanceSwapFee = swapResult.transactionFee || 0;
            fees.swapFees.push(balanceSwapFee);
            fees.totalSol += balanceSwapFee;
            
            swaps.push({
              inputToken: token1Claimed?.symbol || 'token1',
              inputAmount: swapAmount,
              outputToken: token0Claimed?.symbol || 'token0',
              outputAmount,
              signature: swapResult.signature,
              explorer: `https://solscan.io/tx/${swapResult.signature}`,
              purpose: 'balance',
              transactionFee: balanceSwapFee
            });

            console.log(`   ✅ Balance swap completed`);
          } else {
            console.log(`   ⚠️  Balance swap failed, continuing with current amounts`);
          }
        } else {
          // Swap some token0 to token1
          const token0UsdToSwap = (currentToken0Percent - ratio.token0Percent) * totalUsd;
          const token0AmountToSwap = token0UsdToSwap / token0UsdPrice;
          
          const maxSwap = currentToken0Amount * 0.5;
          const swapAmount = Math.min(token0AmountToSwap, maxSwap);

          console.log(`   Swapping ${swapAmount.toFixed(6)} token0 → token1`);

          const swapResult = await swapTokensUltra({
            connection,
            wallet,
            inputMint: mint0Str,
            outputMint: mint1Str,
            amount: toRawAmount(swapAmount, currentToken0Decimals),
            slippageBps: swapSlippageBps,
            waitForConfirmation: true
          });

          if (swapResult.success) {
            const outputAmount = Number(swapResult.quote.outputAmount) / (10 ** currentToken1Decimals);
            currentToken1Amount += outputAmount;
            currentToken0Amount -= swapAmount;
            
            // Track balance swap fee
            const balanceSwapFee = swapResult.transactionFee || 0;
            fees.swapFees.push(balanceSwapFee);
            fees.totalSol += balanceSwapFee;
            
            swaps.push({
              inputToken: token0Claimed?.symbol || 'token0',
              inputAmount: swapAmount,
              outputToken: token1Claimed?.symbol || 'token1',
              outputAmount,
              signature: swapResult.signature,
              explorer: `https://solscan.io/tx/${swapResult.signature}`,
              purpose: 'balance',
              transactionFee: balanceSwapFee
            });

            console.log(`   ✅ Balance swap completed`);
          } else {
            console.log(`   ⚠️  Balance swap failed, continuing with current amounts`);
          }
        }
      } else {
        console.log(`   ✅ Tokens already well-balanced (${(ratioImbalance * 100).toFixed(1)}% difference)`);
      }
    } else if (claimResult.totalUsd <= MIN_USD_FOR_AUTO_BALANCE) {
      console.log(`\n⊘ Step 4: Balance skipped (claimed < $${MIN_USD_FOR_AUTO_BALANCE}, will deposit what fits)`);
    } else {
      console.log('\n⊘ Step 4: Balance skipped (disabled or insufficient tokens)');
    }

    if (onProgress) await onProgress('balance_complete', { phase: 4, total: 5 });

    // ============================================================
    // STEP 5: ADD LIQUIDITY BACK TO POSITION
    // ============================================================
    console.log('\n➕ Step 5: Adding liquidity back to position...');
    if (onProgress) await onProgress('addliquidity_start', { phase: 5, total: 5 });

    console.log(`   Available Token 0: ${currentToken0Amount.toFixed(6)}`);
    console.log(`   Available Token 1: ${currentToken1Amount.toFixed(6)}`);

    if (currentToken0Amount === 0 && currentToken1Amount === 0) {
      return {
        success: false,
        error: 'No tokens available to add liquidity after swaps',
        claimResult,
        swaps,
        phase: 'add_liquidity'
      };
    }

    // Fetch FRESH pool state immediately before calculating liquidity
    // This ensures we use the latest pool price to minimize slippage errors
    console.log(`   🔄 Fetching fresh pool state for latest price...`);
    const freshPoolAi = await connection.getAccountInfo(poolPk);
    if (!freshPoolAi) throw new Error("Pool account not found on refresh");
    const freshPool = coder.accounts.decode("PoolState", freshPoolAi.data);

    // Recalculate optimal ratio with FRESH pool price
    const freshRatio = calculateTokenRatio(
      freshPool.sqrt_price_x64,
      position.tick_lower_index,
      position.tick_upper_index,
      freshPool.tick_current
    );

    // Calculate optimal ratio to determine which token should be the basis
    // The token we have MORE of (relative to optimal ratio) should be the basis
    // This ensures the protocol can maximize usage of the limiting token

    const token0UsdValue = currentToken0Amount * token0UsdPrice;
    const token1UsdValue = currentToken1Amount * token1UsdPrice;
    const totalUsdValue = token0UsdValue + token1UsdValue;

    const currentToken0Percent = token0UsdValue / totalUsdValue;
    const currentToken1Percent = token1UsdValue / totalUsdValue;

    console.log(`   Optimal ratio: ${(freshRatio.token0Percent * 100).toFixed(1)}% token0, ${(freshRatio.token1Percent * 100).toFixed(1)}% token1`);
    console.log(`   Current ratio: ${(currentToken0Percent * 100).toFixed(1)}% token0, ${(currentToken1Percent * 100).toFixed(1)}% token1`);
    
    // Choose the LIMITING token as basis to maximize deposit utilization
    // If we have less token0 than optimal, baseFlag = true (calculate from token0)
    // If we have less token1 than optimal, baseFlag = false (calculate from token1)
    const token0Limiting = currentToken0Percent < freshRatio.token0Percent;
    const baseFlag = token0Limiting;
    
    console.log(`   Strategy: Using ${token0Limiting ? 'Token 0' : 'Token 1'} as basis (limiting token)`);

    // Build options: pass ONLY the base token amount to avoid capping the other side
    const addOptions = baseFlag
      ? { amount0: currentToken0Amount, slippageBps, baseFlag }
      : { amount1: currentToken1Amount, slippageBps, baseFlag };

    let addLiqResult = await addLiquidity(
      connection,
      wallet,
      positionMintPk,
      addOptions
    );

    // Retry logic for slippage errors - price may have moved since we fetched pool state
    if (!addLiqResult.success && addLiqResult.error?.includes('PriceSlippageCheck')) {
      console.log('   ⚠️  Price slippage detected. Retrying with fresh calculation and increased slippage...');

      // Re-fetch FRESH pool state again
      const retryPoolAi = await connection.getAccountInfo(poolPk);
      if (!retryPoolAi) throw new Error("Pool account not found on retry");
      const retryPool = coder.accounts.decode("PoolState", retryPoolAi.data);

      // Recalculate with fresh price
      const retryRatio = calculateTokenRatio(
        retryPool.sqrt_price_x64,
        position.tick_lower_index,
        position.tick_upper_index,
        retryPool.tick_current
      );

      // Recalculate limiting token with fresh ratio
      const retryToken0Limiting = currentToken0Percent < retryRatio.token0Percent;
      const retryBaseFlag = retryToken0Limiting;

      const retryOptions = retryBaseFlag
        ? { amount0: currentToken0Amount, slippageBps: slippageBps + 100, baseFlag: retryBaseFlag } // +1% slippage
        : { amount1: currentToken1Amount, slippageBps: slippageBps + 100, baseFlag: retryBaseFlag };

      console.log(`   Fresh optimal ratio: ${(retryRatio.token0Percent * 100).toFixed(1)}% token0, ${(retryRatio.token1Percent * 100).toFixed(1)}% token1`);
      console.log(`   Wallet ratio (unchanged): ${(currentToken0Percent * 100).toFixed(1)}% token0, ${(currentToken1Percent * 100).toFixed(1)}% token1`);
      console.log(`   🔄 Retry with ${retryToken0Limiting ? 'Token 0' : 'Token 1'} as basis, slippage=${slippageBps + 100}bps`);

      addLiqResult = await addLiquidity(
        connection,
        wallet,
        positionMintPk,
        retryOptions
      );

      if (!addLiqResult.success) {
        console.log('   ❌ Retry also failed');
      } else {
        console.log('   ✅ Retry succeeded!');
      }
    }

    if (!addLiqResult.success) {
      return {
        success: false,
        error: `Failed to add liquidity: ${addLiqResult.error}`,
        claimResult,
        swaps,
        addLiquidityResult: addLiqResult,
        phase: 'add_liquidity'
      };
    }

    // If utilization is too low (< 20% of available USD), retry once with flipped baseFlag
    const minUtilizationUsd = totalUsdValue * MIN_UTILIZATION_PERCENT;
    if (addLiqResult.totalUsd < minUtilizationUsd && currentToken0Amount > 0 && currentToken1Amount > 0) {
      console.log(`   ⚠️  Low utilization detected ($${addLiqResult.totalUsd.toFixed(4)} < $${minUtilizationUsd.toFixed(4)}). Retrying with flipped base...`);
      const flippedBaseFlag = !baseFlag;
      const retryOptions = flippedBaseFlag
        ? { amount0: currentToken0Amount, slippageBps, baseFlag: flippedBaseFlag }
        : { amount1: currentToken1Amount, slippageBps, baseFlag: flippedBaseFlag };

      const retryResult = await addLiquidity(
        connection,
        wallet,
        positionMintPk,
        retryOptions
      );
      if (retryResult.success && retryResult.totalUsd > addLiqResult.totalUsd) {
        console.log('   ✅ Retry improved utilization, adopting retry result');
        addLiqResult = retryResult;
      } else {
        console.log('   ⊘ Retry did not improve utilization, keeping original result');
      }
    }

    console.log(`✅ Liquidity added successfully!`);
    console.log(`   Liquidity increase: ${addLiqResult.liquidityAdded}`);
    console.log(`   Total value: $${addLiqResult.totalUsd.toFixed(2)}`);
    
    // Track add liquidity fee
    fees.addLiquidityFee = addLiqResult.transactionFee || 0;
    fees.totalSol += fees.addLiquidityFee;
    
    console.log(`\n💎 Total transaction fees: ${fees.totalSol.toFixed(6)} SOL`);
    console.log(`   Claim: ${fees.claimFee.toFixed(6)} SOL`);
    console.log(`   Swaps (${fees.swapFees.length}): ${fees.swapFees.reduce((sum, f) => sum + f, 0).toFixed(6)} SOL`);
    console.log(`   Add Liquidity: ${fees.addLiquidityFee.toFixed(6)} SOL`);

    if (onProgress) await onProgress('addliquidity_complete', { phase: 5, total: 5, addLiqResult });

    // ============================================================
    // STEP 6: TRANSFER TO CLAIM ADDRESS (IF SPLIT MODE ACTIVE)
    // ============================================================
    let transferResult = null;
    
    if (usingSplitMode && tokensForTransfer && tokensForTransfer.length > 0) {
      console.log('\n📤 Step 6: Transferring 50% to claim address...');
      if (onProgress) await onProgress('transfer_start', { phase: 6, total: 6 });
      
      // Check if WSOL was unwrapped during claim
      const unwrappedSol = claimResult.unwrappedSol || false;
      
      transferResult = await transferToClaimAddress(
        connection,
        wallet,
        claimAddress,
        tokensForTransfer,
        unwrappedSol
      );
      
      if (transferResult.transferred) {
        console.log(`✅ Transferred ${transferResult.tokenCount} token(s) worth $${transferResult.totalUsd.toFixed(2)}`);
        if (transferResult.solFeeReserved > 0) {
          console.log(`💰 Kept ${transferResult.solFeeReserved} SOL in wallet for transaction fees`);
        }
        if (transferResult.skipped?.length > 0) {
          console.log(`⏭️  Skipped ${transferResult.skipped.length} dust token(s) (< $0.10)`);
        }
        
        // Track transfer fee
        const transferFee = 0.000005; // Estimated transfer fee (5000 lamports)
        fees.totalSol += transferFee;
        
      } else if (transferResult.error) {
        console.warn(`⚠️  Transfer to claim address failed: ${transferResult.error}`);
        console.log(`Tokens remain in wallet, you can transfer manually`);
      } else if (transferResult.reason === 'all_dust') {
        console.log(`⏭️  All transfer tokens are dust (< $0.10), kept in wallet`);
      }
      
      if (onProgress) await onProgress('transfer_complete', { phase: 6, total: 6, transferResult });
    }

    // ============================================================
    // SUMMARY
    // ============================================================
    console.log('\n✨ Compound Complete!\n');

    const totalTransactions = usingSplitMode && transferResult?.transferred
      ? 1 + swaps.length + 1 + 1 // claim + swaps + addLiquidity + transfer
      : 1 + swaps.length + 1; // claim + swaps + addLiquidity

    return {
      success: true,
      claimResult,
      swaps,
      addLiquidityResult: addLiqResult,
      transfer: transferResult,
      splitMode: usingSplitMode,
      fees, // Transaction fees breakdown
      summary: {
        totalUsdClaimed: claimResult.totalUsd,
        totalUsdCompounded: addLiqResult.totalUsd,
        totalUsdTransferred: transferResult?.totalUsd || 0,
        swapCount: swaps.length,
        tokensClaimed: claimResult.claimed.length,
        liquidityAdded: addLiqResult.liquidityAdded,
        totalFeesSol: fees.totalSol, // Total fees in SOL
        totalTransactions
      },
      transactions: {
        claim: claimResult.explorer,
        swaps: swaps.map(s => s.explorer),
        addLiquidity: addLiqResult.explorer,
        transfer: transferResult?.explorer || null
      }
    };

  } catch (error) {
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
}

export default {
  compoundRewards
};

