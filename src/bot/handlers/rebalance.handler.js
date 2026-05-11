/**
 * Rebalance Handler
 * 
 * Handles the /rebalance command to rebalance positions that have a range_percent set.
 * This command closes the current position and reopens it with the same range settings.
 * 
 * Flow:
 * 1. Check if position exists in DB and has range_percent set
 * 2. Close the current position (remove liquidity)
 * 3. Open a new position with the same range_percent
 * 
 * @module rebalance.handler
 */

import { PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { createSolanaConnection } from '../../utils/rpc.util.js';
import { getActiveWalletWithEncryption, getWalletClaimAddress } from '../../services/wallet.service.js';
import { getPositionByNft, updatePositionStatus, upsertPosition } from '../../services/position.service.js';
import { removeLiquidity } from '../../utils/remove-liquidity.util.js';
import { openPosition } from '../../utils/open-position.util.js';
import { addLiquidity } from '../../utils/add-liquidity.util.js';
import { swapTokensUltra, swapWithFreshnessCheck } from '../../utils/jupiter-ultra.util.js';
import { lockRebalance, unlockRebalance, isRebalanceActive } from '../../services/rebalance-lock.service.js';
import { decryptPrivateKey } from '../../utils/encryption.util.js';
import { formatCurrency, formatShortAddress } from '../../utils/format.util.js';
import { PANCAKESWAP_IDL, DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS, DEFAULT_OPEN_POSITION_SLIPPAGE_BPS, DEFAULT_SWAP_SLIPPAGE_BPS, KNOWN_TOKENS, COMMITMENT_LEVEL, RECOMMENDED_SOL_BUFFER, LAMPORTS_PER_SOL, AUTO_REBALANCE_CONFIG, PROGRAM_ID } from '../../config/constants.js';
import { BorshCoder } from '@coral-xyz/anchor';
import { getTokenInfo, toRawAmount, getMintTokenProgram, unwrapWSol } from '../../utils/token.util.js';
import { updatePoolsReplyKeyboard, buildWalletKeyboard } from '../keyboard.util.js';
import { getOutOfRangeConfig, upsertProximityAlert, ensureProximityRow, setProximityEnabled, toggleOutOfRangeEnabled } from '../../services/alert.service.js';
import { recordRebalance, carryOverStatistics, recordClaim, recordClaimFee, recordRebalancePL } from '../../services/position-statistics.service.js';
import { recordRebalanceTransaction, recordClaimTransaction } from '../../services/transaction.service.js';
import { transferToClaimAddress, claimRewards } from '../../utils/claim.util.js';
import { executeTopUp } from './topup.handler.js';
import { captureRebalanceSnapshot, calculateWorthLoss, logWorthLossAnalysis } from '../../utils/rebalance-tracking.util.js';

// In-memory store for pending rebalance range input
// Key: telegram user ID, Value: { chatId, nftMintAddress, messageId }
const pendingRebalanceRange = new Map();

/**
 * Claim rewards before rebalancing (if enabled for position)
 * 
 * @param {Object} bot - Telegram bot instance
 * @param {Object} position - Position database row
 * @param {Object} wallet - Wallet database row
 * @param {string} nftMint - Position NFT mint address
 * @param {boolean} isAuto - Whether this is auto-rebalance or manual
 * @param {boolean} silent - Whether to suppress user notifications (for automated claims)
 * @returns {Promise<{ success: boolean, claimed: boolean, shouldContinue: boolean, reason?: string }>}
 */
async function claimBeforeRebalance(bot, position, wallet, nftMint, isAuto = false, silent = false) {
    const telegramId = wallet.user_telegram_id;
    
    // Check if claim-before-rebalance is enabled for this position
    if (!position.claim_before_rebalance) {
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`⏭️  Claim-before-rebalance disabled for position ${position.id}, skipping...`);
        }
        return { success: true, claimed: false, shouldContinue: true };
    }
    
    try {
        // Send notification (unless silent mode is enabled)
        if (!silent) {
            const stepLabel = isAuto ? 'Auto-Rebalance: Step 1/2' : 'Rebalance: Step 1/2';
            await bot.sendMessage(
                telegramId,
                `🤖 *${stepLabel}*\n\n` +
                `💰 Claiming accumulated rewards...\n` +
                `*Position:* \`${formatShortAddress(nftMint)}\`\n\n` +
                `⏳ Processing...`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (notifyError) {
        console.warn('Failed to send claim notification:', notifyError.message);
    }
    
    // Get claim address
    const claimAddress = await getWalletClaimAddress(wallet.id);
    
    // Decrypt wallet private key
    const connection = createSolanaConnection();
    const decryptedKey = decryptPrivateKey(
        wallet.encrypted_private_key,
        wallet.nonce,
        wallet.salt,
        process.env.MASTER_PASSWORD
    );
    const walletKeypair = Keypair.fromSecretKey(bs58.decode(decryptedKey));
    
    // Claim rewards
    // console.log(`💰 Claiming rewards for position ${nftMint} before rebalancing...`);
    const claimResult = await claimRewards(
        connection,
        walletKeypair,
        new PublicKey(nftMint),
        claimAddress
    );
    
    if (!claimResult.success) {
        console.warn(`⚠️  Failed to claim rewards: ${claimResult.error}`);
        console.warn(`   Proceeding with rebalance anyway...`);
        
        // Notify user about claim failure (non-blocking, unless silent mode)
        if (!silent) {
            try {
                await bot.sendMessage(
                    telegramId,
                    `⚠️ *Claim Failed*\n\n` +
                    `Could not claim rewards: ${claimResult.error}\n\n` +
                    `Proceeding with rebalance...`,
                    { parse_mode: 'Markdown' }
                );
            } catch (notifyError) {
                console.warn('Failed to send claim error notification:', notifyError.message);
            }
        }
        
        return { success: false, claimed: false, shouldContinue: true };
    }
    
    // Claim succeeded
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`✅ Claimed rewards successfully (${claimResult.claimed?.length || 0} tokens, $${claimResult.totalUsd?.toFixed(2) || '0.00'})`);
    }
    
    // Record claim in database (non-blocking)
    if (claimResult.totalUsd > 0) {
        void (async () => {
            try {
                // 1. Record individual transaction for history/audit
                await recordClaimTransaction(wallet.id, position.id, claimResult);
                if (process.env.LOG_LEVEL === 'debug') {
                    console.log(`✅ Claim transaction recorded in history (auto-rebalance)`);
                }
                
                // 2. Update position statistics aggregates
                await recordClaim(position.id, claimResult.totalUsd);
                
                // 3. Record transaction fee
                if (claimResult.transactionFee > 0) {
                    await recordClaimFee(position.id, claimResult.transactionFee);
                }
            } catch (recordError) {
                console.error(`❌ Failed to record claim:`, recordError?.message || recordError);
            }
        })();
    }
    
    // Notify user about successful claim (unless silent mode)
    if (!silent) {
        try {
            let claimMsg = `✅ *Rewards Claimed*\n\n`;
            
            if (claimResult.claimed && claimResult.claimed.length > 0) {
                claimMsg += `*Total Value:* $${claimResult.totalUsd?.toFixed(2) || '0.00'}\n`;
                claimMsg += `*Tokens:* ${claimResult.claimed.length}\n\n`;
                
                // Show top 3 tokens
                const topTokens = claimResult.claimed
                    .sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0))
                    .slice(0, 3);
                
                for (const token of topTokens) {
                    claimMsg += `• ${token.uiAmount.toFixed(6)} ${token.symbol} ($${token.usdValue?.toFixed(2) || '0.00'})\n`;
                }
                
                if (claimResult.claimed.length > 3) {
                    claimMsg += `\n...and ${claimResult.claimed.length - 3} more\n`;
                }
                
                if (claimAddress) {
                    claimMsg += `\n📦 Transferred to claim address\n`;
                }
            } else {
                claimMsg += `No rewards to claim (all already claimed)\n`;
            }
            
            claimMsg += `\n⏳ Proceeding to rebalance...`;
            
            await bot.sendMessage(
                telegramId,
                claimMsg,
                { parse_mode: 'Markdown' }
            );
        } catch (notifyError) {
            console.warn('Failed to send claim success notification:', notifyError.message);
        }
    }
    
    return { success: true, claimed: true, shouldContinue: true };
}

/**
 * Calculate optimal token ratio for a CLMM position
 *
 * @param {bigint} sqrtPriceX64 - Current pool sqrt price
 * @param {number} tickLower - Position lower tick
 * @param {number} tickUpper - Position upper tick
 * @param {number} tickCurrent - Current pool tick
 * @returns {Object} Token ratio information
 */
function calculateTokenRatio(sqrtPriceX64, tickLower, tickUpper, tickCurrent) {
  const sqrtPriceNum = Number(sqrtPriceX64) / (2 ** 64);
  const price = sqrtPriceNum * sqrtPriceNum;

  const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);
  const sqrtPriceCurrent = Math.sqrt(1.0001 ** tickCurrent);

  const inRange = tickCurrent >= tickLower && tickCurrent <= tickUpper;

  if (!inRange) {
    if (tickCurrent < tickLower) {
      return { token0Percent: 1.0, token1Percent: 0.0, inRange: false };
    } else {
      return { token0Percent: 0.0, token1Percent: 1.0, inRange: false };
    }
  }

  const token0Factor = (sqrtPriceUpper - sqrtPriceCurrent) / (sqrtPriceUpper * sqrtPriceCurrent);
  const token1Factor = sqrtPriceCurrent - sqrtPriceLower;

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
 * Execute auto-rebalance for a position (called by scheduler)
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {number} positionId - Position database ID
 * @param {string} nftMint - Position NFT mint address
 * @param {Object} rebalanceData - Auto-rebalance decision data
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function executeAutoRebalance(bot, positionId, nftMint, rebalanceData, isRetry = false) {
    try {
        // Get position from database
        const dbPosition = await getPositionByNft(nftMint);
        const autoRebalanceModule = await import('../../services/auto-rebalance.service.js');
        const { logAutoRebalanceOutcome } = autoRebalanceModule;
        
        if (!dbPosition) {
            try {
                logAutoRebalanceOutcome?.({
                    positionId,
                    nftMint,
                    status: 'failed',
                    reason: 'Position not found'
                });
            } catch (logError) {
                console.warn('⚠️  Failed to log auto-rebalance outcome (missing position):', logError.message);
            }
            return { success: false, error: 'Position not found' };
        }
        
        // Get wallet for this position
        const { wallets, positions } = await import('../../db/schema.js');
        const { db } = await import('../../db/index.js');
        const { eq } = await import('drizzle-orm');
        
        const walletRows = await db.select().from(wallets).where(eq(wallets.id, dbPosition.wallet_id)).limit(1);
        const wallet = walletRows?.[0];
        
        if (!wallet) {
            try {
                logAutoRebalanceOutcome?.({
                    positionId,
                    nftMint,
                    poolAddress: dbPosition.pool_address,
                    status: 'failed',
                    reason: 'Wallet not found'
                });
            } catch (logError) {
                console.warn('⚠️  Failed to log auto-rebalance outcome (missing wallet):', logError.message);
            }
            return { success: false, error: 'Wallet not found' };
        }
        
        // Get user telegram ID for notifications
        const telegramId = wallet.user_telegram_id;
        
        // 📸 TRACKING: Capture BEFORE snapshot for auto-rebalance (before claim)
        // Only need public key to read balances - no decryption needed!
        let snapshotBefore = null;
        try {
            const { createSolanaConnection } = await import('../../utils/rpc.util.js');
            const { captureRebalanceSnapshot } = await import('../../utils/rebalance-tracking.util.js');
            const connection = createSolanaConnection();
            const walletPubkey = new PublicKey(wallet.wallet_address);
            const positionMintPk = new PublicKey(nftMint);
            const personalPositionPk = PublicKey.findProgramAddressSync(
                [Buffer.from("position"), positionMintPk.toBuffer()],
                PROGRAM_ID
            )[0];
            snapshotBefore = await captureRebalanceSnapshot(connection, walletPubkey, dbPosition, personalPositionPk.toString());
        } catch (trackError) {
            console.warn(`⚠️  Failed to capture before snapshot (auto-rebalance): ${trackError.message}`);
        }
        
        // Step 1: Claim rewards before rebalancing (if enabled) - skip on retry
        if (!isRetry) {
            const claimResult = await claimBeforeRebalance(bot, dbPosition, wallet, nftMint, true, true);
            
            // If claim was attempted and failed, but we should still continue
            if (!claimResult.shouldContinue) {
                try {
                    logAutoRebalanceOutcome?.({
                        positionId,
                        nftMint,
                        poolAddress: dbPosition.pool_address,
                        status: 'failed',
                        reason: claimResult.reason || 'Claim failed',
                        phase: 'claim'
                    });
                } catch (logError) {
                    console.warn('⚠️  Failed to log auto-rebalance claim failure:', logError.message);
                }
                return { success: false, error: claimResult.reason || 'Claim failed' };
            }
        }
        
        // Step 2: Re-check if rebalance is still needed (only for auto-rebalances, skip on retry)
        if (!isRetry) {
            if (process.env.LOG_LEVEL === 'debug') {
                console.log(`🔍 Re-checking if rebalance is still needed for position ${positionId}...`);
            }
            const { shouldRebalance } = autoRebalanceModule;
            const recheckDecision = await shouldRebalance(positionId, false);
            
            if (!recheckDecision.allow) {
                if (process.env.LOG_LEVEL === 'debug') {
                    console.log(`⏭️  Rebalance no longer needed: ${recheckDecision.reason}`);
                }
                
                // Notify user that rebalance was cancelled
                try {
                    await bot.sendMessage(
                        telegramId,
                        `ℹ️ *Auto-Rebalance Cancelled*\n\n` +
                        `Position no longer needs rebalancing:\n` +
                        `${recheckDecision.reason}\n\n` +
                        `Position remains open.`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (notifyError) {
                    console.warn('Failed to send cancellation notification:', notifyError.message);
                }

            try {
                logAutoRebalanceOutcome?.({
                    positionId,
                    nftMint,
                    poolAddress: dbPosition.pool_address,
                    status: 'cancelled',
                    reason: recheckDecision.reason,
                    phase: 'preflight'
                });
            } catch (logError) {
                console.warn('⚠️  Failed to log auto-rebalance cancellation outcome:', logError.message);
            }
                
                return { success: true, cancelled: true, reason: recheckDecision.reason };
            }
            
            if (process.env.LOG_LEVEL === 'debug') {
                console.log(`✅ Rebalance still needed, proceeding...`);
            }
        } else {
            if (process.env.LOG_LEVEL === 'debug') {
                console.log(`🔄 Retrying auto-rebalance for position ${positionId}...`);
            }
        }
        
        // Update position range_percent with the auto-calculated width
        await db.update(positions)
            .set({
                range_percent: rebalanceData.rangeWidth,
                updated_at: new Date()
            })
            .where(eq(positions.nft_mint, nftMint));
        
        // Update local object to keep in sync (critical for retry path)
        dbPosition.range_percent = rebalanceData.rangeWidth;
        
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`🤖 Auto-rebalance: Updated range to ${rebalanceData.rangeWidth}% for position ${nftMint}`);
        }
        
        // Send notification to user (skip on retry, already notified)
        let autoRebalanceMsg = null;
        if (!isRetry) {
            try {
                // Get position statistics to show last rebalance time
                const { getPositionStatistics } = await import('../../services/position-statistics.service.js');
                const posStats = await getPositionStatistics(positionId);
                
                let lastRebalanceInfo = '';
                if (posStats && posStats.last_rebalance_at) {
                    const minutesAgo = Math.floor((Date.now() - new Date(posStats.last_rebalance_at).getTime()) / (60 * 1000));
                    const rebalancesToday = posStats.rebalances_today || 0;
                    if (minutesAgo < 60) {
                        lastRebalanceInfo = `*Rebalances:* ${rebalancesToday} today (last ${minutesAgo}min ago)\n`;
                    } else {
                        const hoursAgo = Math.floor(minutesAgo / 60);
                        lastRebalanceInfo = `*Rebalances:* ${rebalancesToday} today (last ${hoursAgo}h ago)\n`;
                    }
                }
                
                // Build optimization message
                let optimizationMsg = '';
                if (rebalanceData.optimizationReason) {
                    // Get actual base widths from config (use midpoint of min/max for comparison)
                    const modeConfig = AUTO_REBALANCE_CONFIG.RANGE_MODES[rebalanceData.mode];
                    const baseWidth = modeConfig 
                        ? (modeConfig.minWidth + modeConfig.maxWidth) / 2 
                        : null;
                    const wasOptimized = baseWidth && Math.abs(rebalanceData.rangeWidth - baseWidth) > 0.1;
                    
                    if (wasOptimized) {
                        // Determine if tightened or widened relative to mode's midpoint
                        const action = rebalanceData.rangeWidth < baseWidth ? '📉 *Tightened*' : '📈 *Widened*';
                        optimizationMsg = `${action}: ${baseWidth.toFixed(1)}% → ${rebalanceData.rangeWidth}%\n`;
                        
                        // Add reason (truncate if too long)
                        const reason = rebalanceData.optimizationReason;
                        if (reason.includes('Volatility spike')) {
                            optimizationMsg += `⚡ Volatility spike detected\n`;
                        } else if (reason.includes('confidence gates')) {
                            optimizationMsg += `✅ High stability confidence\n`;
                        } else if (reason.includes('benefit')) {
                            // Extract benefit ratio if available
                            const benefitMatch = reason.match(/(\d+\.?\d*)x benefit/);
                            if (benefitMatch) {
                                optimizationMsg += `💰 Expected ${benefitMatch[1]}x fee gain\n`;
                            }
                        }
                        optimizationMsg += '\n';
                    }
                }
                
                // Build wallet info
                const walletInfo = wallet.label ? `*Wallet:* ${wallet.label}\n` : '';
                
                const retryNote = isRetry ? `\n🔄 *Retrying...*\n` : '';
                
                autoRebalanceMsg = await bot.sendMessage(
                    telegramId,
                    `🤖 *Auto-Rebalance: Step 2/2*\n\n` +
                    walletInfo +
                    `*Position:* \`${formatShortAddress(nftMint)}\`\n` +
                    lastRebalanceInfo +
                    `*Mode:* ${rebalanceData.mode}\n` +
                    `*New Range:* ±${rebalanceData.rangeWidth}%\n` +
                    (optimizationMsg ? `\n${optimizationMsg}` : '') +
                    `*Trigger:* Out of range for ${rebalanceData.oorDurationMinutes} minutes\n\n` +
                    retryNote +
                    `⏳ Processing...`,
                    { parse_mode: 'Markdown' }
                );
            } catch (notifyError) {
                console.error('Failed to send auto-rebalance notification:', notifyError.message);
            }
        }
        
        // Create simulated message object for handleRebalance
        // Pass the correct wallet and message ID in special properties for auto-rebalance context
        const simulatedMsg = {
            chat: { id: telegramId },
            from: { id: telegramId },
            _autoRebalanceWallet: wallet,  // Special property for auto-rebalance context
            _autoRebalanceMessageId: autoRebalanceMsg?.message_id || null,  // Message ID to update on completion
            _snapshotBefore: snapshotBefore  // Pass snapshot for tracking
        };
        
        // Store the old NFT mint to detect if position changed
        const oldNftMint = dbPosition.nft_mint;
        
        // Call the existing rebalance handler
        // This will handle all the transaction logic
        await handleRebalance(bot, simulatedMsg, [nftMint]);
        
        // Check if rebalance succeeded by seeing if a new position was created
        const { desc, and } = await import('drizzle-orm');
        const newDbPosition = await db.select().from(positions)
            .where(and(
                eq(positions.wallet_id, dbPosition.wallet_id),
                eq(positions.status, 'active'),
                eq(positions.pool_address, dbPosition.pool_address)
            ))
            .orderBy(desc(positions.created_at))
            .limit(1);
        
        const rebalanceSucceeded = newDbPosition.length > 0 && newDbPosition[0].nft_mint !== oldNftMint;
        
        // If rebalance failed and this is first attempt, retry once
        if (!rebalanceSucceeded && !isRetry) {
            if (process.env.LOG_LEVEL === 'debug') {
                console.log(`⚠️ Auto-rebalance failed (position partially closed), retrying once in 3 seconds...`);
            }
            
            // Wait 3 seconds before retry
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Retry using continueRebalanceFromWalletBalances (position is already closed)
            try {
                await continueRebalanceFromWalletBalances(bot, telegramId, telegramId, dbPosition, wallet);
                
                try {
                    logAutoRebalanceOutcome?.({
                        positionId,
                        nftMint,
                        poolAddress: dbPosition.pool_address,
                        status: 'retry_success',
                        reason: 'Retry after partial failure succeeded'
                    });
                } catch (logError) {
                    console.warn('⚠️  Failed to log auto-rebalance retry outcome:', logError.message);
                }
                return { success: true, retried: true };
            } catch (retryError) {
                console.error(`❌ Auto-rebalance retry failed:`, retryError.message);
                try {
                    logAutoRebalanceOutcome?.({
                        positionId,
                        nftMint,
                        poolAddress: dbPosition.pool_address,
                        status: 'retry_failed',
                        reason: retryError.message
                    });
                } catch (logError) {
                    console.warn('⚠️  Failed to log auto-rebalance retry failure:', logError.message);
                }
                return { success: false, error: `Retry failed: ${retryError.message}` };
            }
        }
        
        // If this WAS a retry and still failed, just report failure
        if (!rebalanceSucceeded && isRetry) {
            console.error(`❌ Auto-rebalance failed for position ${positionId}`);
            try {
                logAutoRebalanceOutcome?.({
                    positionId,
                    nftMint,
                    poolAddress: dbPosition.pool_address,
                    status: 'failed',
                    reason: 'Retry failed'
                });
            } catch (logError) {
                console.warn('⚠️  Failed to log auto-rebalance failure:', logError.message);
            }
            return { success: false, error: 'Rebalance failed' };
        }
        
        // Register successful execution for churn tracking
        try {
            const { registerAutoRebalanceExecution } = autoRebalanceModule;
            registerAutoRebalanceExecution?.(positionId);
        } catch (registryError) {
            console.warn('⚠️  Failed to register auto-rebalance execution:', registryError.message);
        }

        try {
            logAutoRebalanceOutcome?.({
                positionId,
                nftMint,
                poolAddress: dbPosition.pool_address,
                status: 'success',
                reason: 'Auto-rebalance completed',
                decision: rebalanceData
            });
        } catch (logError) {
            console.warn('⚠️  Failed to log auto-rebalance success outcome:', logError.message);
        }
        
        // Log auto-rebalance alert in alert_history (skip on retry to avoid duplicate logs)
        if (!isRetry) {
            try {
                const { logAlertTrigger } = await import('../../services/alert.service.js');
                await logAlertTrigger(
                    positionId,
                    'auto_rebalance',
                    rebalanceData.currentPrice,
                    true // message was sent
                );
            } catch (alertError) {
                console.warn('Failed to log auto-rebalance alert:', alertError.message);
            }
        }
        
        return { success: true };
        
    } catch (error) {
        console.error(`❌ Auto-rebalance execution failed:`, error.message);
        try {
            const autoRebalanceModule = await import('../../services/auto-rebalance.service.js');
            autoRebalanceModule.logAutoRebalanceOutcome?.({
                positionId,
                nftMint,
                status: 'failed',
                reason: error.message || 'Unknown error',
                phase: 'execution'
            });
        } catch (logError) {
            console.warn('⚠️  Failed to log auto-rebalance execution error:', logError.message);
        }
        return { success: false, error: error.message };
    }
}

/**
 * Handles the /rebalance command
 * 
 * Rebalances a position by closing it and reopening with the same range settings.
 * Only works for positions that have a range_percent stored in the database.
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} msg - Telegram message object
 * @param {Array<string>} args - Command arguments [position_nft_mint]
 * 
 * @example
 * User: /rebalance <nft_mint_address>
 * OR click "Rebalance" button from /positions
 */
export async function handleRebalance(bot, msg, args) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  let wallet; // Declare outside try block so it's accessible in catch block
  let isAutoRebalance; // Track manual vs auto rebalance (declared once)

  try {
    // 1. Validate position NFT mint argument
    if (args.length === 0) {
      await bot.sendMessage(chatId,
        `❌ *Missing Position Address*\n\n` +
        `Please provide your position NFT mint address.\n\n` +
        `*Usage:*\n` +
        `\`/rebalance <nft_mint_address>\`\n\n` +
        `*Find your position:*`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 View Positions', callback_data: 'positions' }]
            ]
          }
        }
      );
      return;
    }

    const nftMintAddress = args[0];

    // 2. Validate NFT mint address format
    let positionMintPk;
    try {
      positionMintPk = new PublicKey(nftMintAddress);
    } catch (err) {
      await bot.sendMessage(chatId,
        `❌ *Invalid Position Address*\n\n` +
        `The provided address is not a valid Solana public key.\n\n` +
        `*Provided:* \`${nftMintAddress}\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 3. Get wallet (either from auto-rebalance context or active wallet)
    // For auto-rebalance, use the position's wallet (passed in msg._autoRebalanceWallet)
    // For manual rebalance, get the user's active wallet
    wallet = msg._autoRebalanceWallet;  // Check if auto-rebalance passed the wallet
    isAutoRebalance = !!wallet; // Set early to control message suppression
    
    if (!wallet) {
      // Manual rebalance - get active wallet
      wallet = await getActiveWalletWithEncryption(telegramId);
      if (!wallet) {
        await bot.sendMessage(chatId,
          '❌ No wallet configured. Use /newwallet or /importwallet',
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    // 4. Check if position exists in DB and has range_percent
    const dbPosition = await getPositionByNft(nftMintAddress);
    if (!dbPosition) {
      await bot.sendMessage(chatId,
        `❌ *Position Not Found*\n\n` +
        `This position is not tracked in the database.\n\n` +
        `*Note:* Only positions created with /addposition can be rebalanced.\n\n` +
        `Position: \`${formatShortAddress(nftMintAddress)}\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (!dbPosition.range_percent) {
      await bot.sendMessage(chatId,
        `❌ *Cannot Rebalance*\n\n` +
        `This position does not have range settings stored.\n\n` +
        `*Note:* Only positions created with /addposition can be rebalanced.\n\n` +
        `Position: \`${formatShortAddress(nftMintAddress)}\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 5. Verify wallet ownership
    if (dbPosition.wallet_id !== wallet.id) {
      await bot.sendMessage(chatId,
        `❌ *Access Denied*\n\n` +
        `This position belongs to a different wallet.\n\n` +
        `Position: \`${formatShortAddress(nftMintAddress)}\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 6. Validate wallet has encryption data
    if (!wallet.encrypted_private_key || !wallet.nonce || !wallet.salt) {
      await bot.sendMessage(chatId,
        `❌ *Wallet Data Incomplete*\n\n` +
        `The wallet encryption data is missing or incomplete.\n\n` +
        `This wallet may have been created with an older version.\n` +
        `Please re-import the wallet using \`/importwallet\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 7. Check MASTER_PASSWORD is set
    if (!process.env.MASTER_PASSWORD) {
      await bot.sendMessage(chatId,
        `❌ *Configuration Error*\n\n` +
        `MASTER_PASSWORD is not configured.\n\n` +
        `Please contact the bot administrator.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 7.6. Decrypt private key and create keypair (moved up for snapshot)
    let privateKey;
    try {
      privateKey = decryptPrivateKey(
        wallet.encrypted_private_key,
        wallet.nonce,
        wallet.salt,
        process.env.MASTER_PASSWORD
      );
    } catch (decryptError) {
      await bot.sendMessage(chatId,
        `❌ *Decryption Failed*\n\n` +
        `Could not decrypt wallet private key.\n\n` +
        `*Error:* ${decryptError.message}\n\n` +
        `This may indicate:\n` +
        `• Incorrect MASTER_PASSWORD\n` +
        `• Corrupted wallet data\n\n` +
        `Please contact support.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = createSolanaConnection();

    // 7.7. 📸 TRACKING: Capture wallet + LP value BEFORE any operations (claim or close)
    // For auto-rebalances, use the snapshot passed from executeAutoRebalance (captured before claim)
    let snapshotBefore = msg._snapshotBefore || null;
    
    // For manual rebalances, capture now (before claim below)
    if (!snapshotBefore) {
      try {
        const personalPositionPk = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), positionMintPk.toBuffer()],
          PROGRAM_ID
        )[0];
        snapshotBefore = await captureRebalanceSnapshot(connection, keypair.publicKey, dbPosition, personalPositionPk.toString());
      } catch (trackError) {
        console.warn(`⚠️  Failed to capture before snapshot: ${trackError.message}`);
      }
    }

    // 7.8. Claim rewards before rebalancing (if enabled)
    // Only for manual rebalances (auto-rebalances already handled)
    if (!msg._autoRebalanceWallet) {
      const claimResult = await claimBeforeRebalance(bot, dbPosition, wallet, nftMintAddress, false);
      
      // If claim failed critically (shouldContinue = false), abort rebalance
      if (!claimResult.shouldContinue) {
        await bot.sendMessage(chatId,
          `❌ *Rebalance Aborted*\n\n` +
          `Could not proceed with rebalance: ${claimResult.reason || 'Claim failed'}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    // 8. (keypair and connection created above before snapshot)

    // 9.5. Acquire rebalance lock to prevent race conditions with recovery job
    lockRebalance(wallet.wallet_address);

    // 10. Send initial processing message (only for manual rebalance)
    // For auto-rebalance, use the message ID passed from executeAutoRebalance
    let processingMsg = null;
    if (!isAutoRebalance) {
      processingMsg = await bot.sendMessage(chatId,
        `🔄 *Rebalancing Position...*\n\n` +
        `*Position:* \`${formatShortAddress(nftMintAddress)}\`\n` +
        `*Range:* ±${dbPosition.range_percent}%\n\n` +
        `*Step 1/4:* Closing current position...\n\n` +
        `⏳ *Preparing transaction...*`,
        { parse_mode: 'Markdown' }
      );
    } else if (msg._autoRebalanceMessageId) {
      // For auto-rebalance, wrap the passed message ID so we can update it on completion
      processingMsg = { message_id: msg._autoRebalanceMessageId };
    }

    const startTime = Date.now();
    
    // Collect transaction links for final message
    const txLinks = { remove: null, rewardSwaps: [], balanceSwap: null, open: null, topUp: null, autoAdd: null };

    // 11. Close the current position (remove all liquidity)
    if (!isAutoRebalance && processingMsg) {
      await bot.editMessageText(
        `🔄 *Rebalancing Position...*\n\n` +
        `*Position:* \`${formatShortAddress(nftMintAddress)}\`\n` +
        `*Range:* ±${dbPosition.range_percent}%\n\n` +
        `*Step 1/4:* Closing current position...\n\n` +
        `⏳ *Submitting to Solana...*`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
    }

    const removeResult = await removeLiquidity(connection, keypair, positionMintPk, {
      slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS
    });

    if (!removeResult.success) {
      // Check if this is auto-rebalance (suppress error messages for auto-rebalance)
      isAutoRebalance = !!msg._autoRebalanceWallet;
      
      if (!isAutoRebalance) {
        // Only send error message for manual rebalance
      await bot.editMessageText(
        `❌ *Rebalance Failed*\n\n` +
        `*Wallet:* ${wallet.label}\n\n` +
        `*Position:* \`${formatShortAddress(nftMintAddress)}\`\n\n` +
        `*Error during position closure:*\n` +
        `${removeResult?.error}\n\n` +
        `Your position was not modified.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      } else {
        // Auto-rebalance: Just log the error, don't notify user
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`⚠️  Auto-rebalance skipped for position ${nftMintAddress}: ${removeResult?.error}`);
        }
      }
      return;
    }
    
    // Capture remove-liquidity transaction link
    txLinks.remove = removeResult.explorer;

    // 12. Update position status to closed
    await updatePositionStatus(nftMintAddress, 'closed');

    // 12.5. Check if wallet has claim address configured
    const claimAddress = await getWalletClaimAddress(wallet.id);
    const shouldTransferRewards = !!claimAddress;
    
    if (shouldTransferRewards) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`🎯 Claim address configured: ${claimAddress}`);
        console.log(`📦 Rewards will be transferred to claim address after rebalancing`);
      }
    }

    // 13. Extract withdrawn token amounts (with WSOL/SOL equivalence)
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    const SOL_NATIVE_MINT = '11111111111111111111111111111111'; // Native SOL (not a real mint)
    
    // Helper to check if two mints are equivalent (handles WSOL/SOL)
    const mintsMatch = (mint1, mint2) => {
      if (mint1 === mint2) return true;
      // Treat WSOL and native SOL as equivalent
      const isWSolOrSol1 = mint1 === WSOL_MINT || mint1 === SOL_NATIVE_MINT || !mint1;
      const isWSolOrSol2 = mint2 === WSOL_MINT || mint2 === SOL_NATIVE_MINT || !mint2;
      return isWSolOrSol1 && isWSolOrSol2;
    };
    
    const token0Withdrawn = removeResult.tokensWithdrawn?.find(
      t => mintsMatch(t.mint, dbPosition.token0_mint)
    );
    const token1Withdrawn = removeResult.tokensWithdrawn?.find(
      t => mintsMatch(t.mint, dbPosition.token1_mint)
    );

    // Check if tokens are SOL/WSOL (needed throughout the function for balance checks)
    const isToken0Sol = dbPosition.token0_mint === KNOWN_TOKENS.SOL.mint;
    const isToken1Sol = dbPosition.token1_mint === KNOWN_TOKENS.SOL.mint;

    if (!token0Withdrawn || !token1Withdrawn) {
      console.error(`⚠️ Token withdrawal parsing failed:`, {
        tokensWithdrawn: removeResult.tokensWithdrawn,
        expectedToken0: dbPosition.token0_mint,
        expectedToken1: dbPosition.token1_mint,
        foundToken0: !!token0Withdrawn,
        foundToken1: !!token1Withdrawn
      });
      
      // Check if this is auto-rebalance (suppress error messages for auto-rebalance)
      isAutoRebalance = !!msg._autoRebalanceWallet;
      
      if (!isAutoRebalance) {
        // Only send error message for manual rebalance
      await bot.editMessageText(
        `⚠️ *Rebalance Partially Completed*\n\n` +
        `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n\n` +
        `✅ Position closed successfully\n` +
        `*Withdrawn:* ${formatCurrency(removeResult.totalUsd)}\n\n` +
        `❌ Could not find withdrawn token amounts.\n\n` +
        `Your tokens are now in your wallet. You can manually create a new position with /addposition.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '↻ Retry from last step', callback_data: `rebalance_retry_${nftMintAddress}` }],
              [{ text: '📊 View Positions', callback_data: 'positions' }]
            ]
          }
        }
      );
      } else {
        // Auto-rebalance: Just log the error, don't notify user (will retry automatically)
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`⚠️  Auto-rebalance skipped token parsing for position ${nftMintAddress} - will retry from wallet balances`);
        }
      }
      return;
    }

    // 14. Calculate required token ratio for new position and balance tokens
    // Prepare rewards info for next step
    const rewardsAll = Array.isArray(removeResult.rewardsCollected) ? removeResult.rewardsCollected : [];

    if (!isAutoRebalance && processingMsg) {
      await bot.editMessageText(
        `🔄 *Rebalancing Position...*\n\n` +
        `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n` +
        `*Range:* ±${dbPosition.range_percent}%\n\n` +
        `✅ *Step 1/4:* Position closed\n` +
        `*Withdrawn:* ${formatCurrency(removeResult.totalUsd)}\n` +
        `  • ${token0Withdrawn.uiAmount.toFixed(6)} ${dbPosition.token0_symbol}\n` +
        `  • ${token1Withdrawn.uiAmount.toFixed(6)} ${dbPosition.token1_symbol}\n\n` +
        `*Step 2/4:* Converting claimed rewards...\n\n` +
        `⏳ *Preparing tokens for balance...*`,
        {
          chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown'
      }
    );
    }
    // Get pool address and fetch pool state
    const poolPk = new PublicKey(dbPosition.pool_address);
    const coder = new BorshCoder(PANCAKESWAP_IDL);
    const poolAi = await connection.getAccountInfo(poolPk);
    if (!poolAi) {
      throw new Error('Pool account not found');
    }
    const poolState = coder.accounts.decode('PoolState', poolAi.data);

    // Calculate new tick range based on range_percent
    const currentPrice = Number(poolState.sqrt_price_x64) / (2 ** 64);
    const currentPriceActual = currentPrice * currentPrice;
    const lowerPrice = currentPriceActual * (1 - dbPosition.range_percent / 100);
    const upperPrice = currentPriceActual * (1 + dbPosition.range_percent / 100);
    const tickLower = Math.floor(Math.log(lowerPrice) / Math.log(1.0001));
    const tickUpper = Math.ceil(Math.log(upperPrice) / Math.log(1.0001));

    // Calculate optimal ratio for the new range
    const ratio = calculateTokenRatio(
      poolState.sqrt_price_x64,
      tickLower,
      tickUpper,
      poolState.tick_current
    );

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Optimal ratio: ${(ratio.token0Percent * 100).toFixed(1)}% ${dbPosition.token0_symbol}, ${(ratio.token1Percent * 100).toFixed(1)}% ${dbPosition.token1_symbol}`);
    }

    // Get token prices
    const token0Info = await getTokenInfo(dbPosition.token0_mint);
    const token1Info = await getTokenInfo(dbPosition.token1_mint);
    const token0Price = token0Info.price || currentPriceActual;
    const token1Price = token1Info.price || 1;

    // Calculate current token amounts (start with withdrawn pool tokens)
    let currentToken0Amount = token0Withdrawn.uiAmount;
    let currentToken1Amount = token1Withdrawn.uiAmount;

    // Step 2/4: Handle claimed rewards based on claim address configuration
    const poolMint0 = dbPosition.token0_mint;
    const poolMint1 = dbPosition.token1_mint;

    let rewardsConvertedUsd = 0;
    let rewardsAddedToPool = { token0: 0, token1: 0 };
    const nonPoolRewards = [];

    if (shouldTransferRewards) {
      // Claim address is set - exclude ALL rewards from position
      // They will be transferred to claim address after opening new position
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`🎯 Skipping reward incorporation - ${rewardsAll.length} reward tokens will be transferred to claim address`);
        const totalRewardsUsd = rewardsAll.reduce((sum, r) => sum + (r.usdValue || 0), 0);
        console.log(`💰 Total rewards to transfer: ${formatCurrency(totalRewardsUsd)}`);
      }
    } else {
      // No claim address - incorporate rewards into position (existing behavior)
      for (const r of rewardsAll) {
        if (!r || typeof r.uiAmount !== 'number' || r.uiAmount <= 0) continue;
        if (r.mint === poolMint0) {
          currentToken0Amount += r.uiAmount;
          rewardsAddedToPool.token0 += r.uiAmount;
          if (typeof r.usdValue === 'number') rewardsConvertedUsd += r.usdValue;
        } else if (r.mint === poolMint1) {
          currentToken1Amount += r.uiAmount;
          rewardsAddedToPool.token1 += r.uiAmount;
          if (typeof r.usdValue === 'number') rewardsConvertedUsd += r.usdValue;
        } else {
          nonPoolRewards.push(r);
        }
      }

      // Determine deficit token after adding pool-matching rewards
      let token0UsdTotal = currentToken0Amount * (token0Info.price || token0Price);
      let token1UsdTotal = currentToken1Amount * (token1Info.price || token1Price);
      let totalUsd = token0UsdTotal + token1UsdTotal;
      let currentToken0Percent = totalUsd > 0 ? (token0UsdTotal / totalUsd) : 0.5;
      let currentToken1Percent = 1 - currentToken0Percent;

      // Swap non-pool rewards into deficit token (skip tiny amounts to save fees)
      const DUST_USD_THRESHOLD = 0.5;
      if (nonPoolRewards.length > 0) {
        const needMoreToken0 = currentToken0Percent < ratio.token0Percent;
        const targetMint = needMoreToken0 ? poolMint0 : poolMint1;
        const targetDecimals = needMoreToken0 ? token0Withdrawn.decimals : token1Withdrawn.decimals;

        for (const r of nonPoolRewards) {
          const rewardUsd = typeof r.usdValue === 'number' ? r.usdValue : 0;
          if (rewardUsd < DUST_USD_THRESHOLD) continue;
          try {
            const swapAmountRaw = toRawAmount(r.uiAmount, r.decimals);
            if (!swapAmountRaw || swapAmountRaw === 0n) continue;
            const swapRes = await swapTokensUltra({
              connection,
              wallet: keypair,
              inputMint: r.mint,
              outputMint: targetMint,
              amount: swapAmountRaw,
              slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
              waitForConfirmation: true
            });
            if (swapRes.success) {
              const outAmount = Number(swapRes.quote.outputAmount) / (10 ** targetDecimals);
              if (needMoreToken0) {
                currentToken0Amount += outAmount;
              } else {
                currentToken1Amount += outAmount;
              }
              if (rewardUsd > 0) rewardsConvertedUsd += rewardUsd;
              if (process.env.LOG_LEVEL === 'debug') {
                console.log(`✅ Converted reward ${r.symbol || r.mint} → ${needMoreToken0 ? dbPosition.token0_symbol : dbPosition.token1_symbol}: +${outAmount.toFixed(6)}`);
              }
            // collect reward swap tx link
            if (swapRes.signature) {
              txLinks.rewardSwaps.push(`https://solscan.io/tx/${swapRes.signature}`);
            }
            } else {
              console.warn(`⚠️  Reward swap failed for ${r.symbol || r.mint}: ${swapRes.error}`);
            }
          } catch (e) {
            console.warn(`⚠️  Reward swap error for ${r.symbol || r.mint}: ${e?.message || e}`);
          }
        }

        // Recompute percents after reward conversions
        token0UsdTotal = currentToken0Amount * (token0Info.price || token0Price);
        token1UsdTotal = currentToken1Amount * (token1Info.price || token1Price);
        totalUsd = token0UsdTotal + token1UsdTotal;
        currentToken0Percent = totalUsd > 0 ? (token0UsdTotal / totalUsd) : 0.5;
        currentToken1Percent = 1 - currentToken0Percent;
      }

      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`After rewards: ${(currentToken0Percent * 100).toFixed(1)}% ${dbPosition.token0_symbol}, ${(currentToken1Percent * 100).toFixed(1)}% ${dbPosition.token1_symbol}`);
      }
    }

    // Calculate percents for balancing step
    let token0UsdTotal = currentToken0Amount * (token0Info.price || token0Price);
    let token1UsdTotal = currentToken1Amount * (token1Info.price || token1Price);
    let totalUsd = token0UsdTotal + token1UsdTotal;
    let currentToken0Percent = totalUsd > 0 ? (token0UsdTotal / totalUsd) : 0.5;
    let currentToken1Percent = 1 - currentToken0Percent;

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Current balance: ${(currentToken0Percent * 100).toFixed(1)}% ${dbPosition.token0_symbol}, ${(currentToken1Percent * 100).toFixed(1)}% ${dbPosition.token1_symbol}`);
    }

    // Check if we need to swap to balance (threshold: 5% difference)
    const ratioImbalance = Math.abs(currentToken0Percent - ratio.token0Percent);
    let swapPerformed = false;
    let swapDetails = null;

    if (ratio.inRange && ratioImbalance > 0.05) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`Ratio imbalance detected: ${(ratioImbalance * 100).toFixed(1)}%`);
      }

      if (!isAutoRebalance && processingMsg) {
        await bot.editMessageText(
          `🔄 *Rebalancing Position...*\n\n` +
          `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n` +
          `*Range:* ±${dbPosition.range_percent}%\n\n` +
          `✅ *Step 1/4:* Position closed\n` +
          `*Withdrawn:* ${formatCurrency(removeResult.totalUsd)}\n\n` +
          `✅ *Step 2/4:* Rewards converted${rewardsConvertedUsd ? ` (~${formatCurrency(rewardsConvertedUsd)})` : ''}\n` +
          `*Step 3/4:* Balancing tokens...\n` +
          `⚖️  Swapping to achieve optimal ratio...\n` +
          `Current: ${(currentToken0Percent * 100).toFixed(1)}% / ${(currentToken1Percent * 100).toFixed(1)}%\n` +
          `Target: ${(ratio.token0Percent * 100).toFixed(1)}% / ${(ratio.token1Percent * 100).toFixed(1)}%`,
          {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      }

      // Determine which token to swap
      const needMoreToken0 = currentToken0Percent < ratio.token0Percent;

      if (needMoreToken0) {
        // Swap token1 → token0
        const token1UsdToSwap = (ratio.token0Percent - currentToken0Percent) * totalUsd;
        const token1AmountToSwap = token1UsdToSwap / token1Price;
        const maxSwap = currentToken1Amount * 0.5;
        const swapAmount = Math.min(token1AmountToSwap, maxSwap);

        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Swapping ${swapAmount.toFixed(6)} ${dbPosition.token1_symbol} → ${dbPosition.token0_symbol}`);
        }

        // Expected price: token0 per token1 (output/input ratio)
        const expectedPrice = token1Price / token0Price;

        const swapResult = await swapWithFreshnessCheck({
          connection,
          wallet: keypair,
          inputMint: dbPosition.token1_mint,
          outputMint: dbPosition.token0_mint,
          amount: toRawAmount(swapAmount, token1Withdrawn.decimals),
          slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
          expectedPrice,
          inputDecimals: token1Withdrawn.decimals,
          outputDecimals: token0Withdrawn.decimals,
          waitForConfirmation: true
        });

        if (swapResult.success) {
          const outputAmount = Number(swapResult.quote.outputAmount) / (10 ** token0Withdrawn.decimals);
          currentToken0Amount += outputAmount;
          currentToken1Amount -= swapAmount;
          swapPerformed = true;
          swapDetails = {
            from: dbPosition.token1_symbol,
            to: dbPosition.token0_symbol,
            amountIn: swapAmount,
            amountOut: outputAmount
          };
          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`✅ Swap completed: +${outputAmount.toFixed(6)} ${dbPosition.token0_symbol}`);
          }
          if (swapResult.signature) {
            txLinks.balanceSwap = `https://solscan.io/tx/${swapResult.signature}`;
          }
        } else {
          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`⚠️  Swap failed: ${swapResult.error}`);
          }
        }
      } else {
        // Swap token0 → token1
        const token0UsdToSwap = (currentToken0Percent - ratio.token0Percent) * totalUsd;
        const token0AmountToSwap = token0UsdToSwap / token0Price;
        const maxSwap = currentToken0Amount * 0.5;
        const swapAmount = Math.min(token0AmountToSwap, maxSwap);

        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Swapping ${swapAmount.toFixed(6)} ${dbPosition.token0_symbol} → ${dbPosition.token1_symbol}`);
        }

        // Expected price: token1 per token0 (output/input ratio)
        const expectedPrice = token0Price / token1Price;

        const swapResult = await swapWithFreshnessCheck({
          connection,
          wallet: keypair,
          inputMint: dbPosition.token0_mint,
          outputMint: dbPosition.token1_mint,
          amount: toRawAmount(swapAmount, token0Withdrawn.decimals),
          slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
          expectedPrice,
          inputDecimals: token0Withdrawn.decimals,
          outputDecimals: token1Withdrawn.decimals,
          waitForConfirmation: true
        });

        if (swapResult.success) {
          const outputAmount = Number(swapResult.quote.outputAmount) / (10 ** token1Withdrawn.decimals);
          currentToken1Amount += outputAmount;
          currentToken0Amount -= swapAmount;
          swapPerformed = true;
          swapDetails = {
            from: dbPosition.token0_symbol,
            to: dbPosition.token1_symbol,
            amountIn: swapAmount,
            amountOut: outputAmount
          };
          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`✅ Swap completed: +${outputAmount.toFixed(6)} ${dbPosition.token1_symbol}`);
          }
          if (swapResult.signature) {
            txLinks.balanceSwap = `https://solscan.io/tx/${swapResult.signature}`;
          }
        } else {
          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`⚠️  Swap failed: ${swapResult.error}`);
          }
        }
      }
    }

    // 14.5. Verify balances before opening position
    if (!isAutoRebalance && processingMsg) {
      await bot.editMessageText(
        `🔄 *Rebalancing Position...*\n\n` +
        `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n` +
        `*Range:* ±${dbPosition.range_percent}%\n\n` +
        `✅ *Step 1/4:* Position closed\n` +
        `✅ *Step 2/4:* Rewards converted${rewardsConvertedUsd ? ` (~${formatCurrency(rewardsConvertedUsd)})` : ''}\n` +
        `✅ *Step 3/4:* Tokens balanced${swapPerformed ? ` (swapped ${swapDetails.amountIn.toFixed(4)} ${swapDetails.from})` : ''}\n\n` +
        `*Step 4/4:* Verifying balances...\n\n` +
        `⏳ *Checking on-chain balances...*`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
    }

    // Re-query actual on-chain balances to catch any swap failures or timing issues
    const mint0PkForVerify = new PublicKey(dbPosition.token0_mint);
    const mint1PkForVerify = new PublicKey(dbPosition.token1_mint);
    const mint0ProgramForVerify = await getMintTokenProgram(connection, mint0PkForVerify);
    const mint1ProgramForVerify = await getMintTokenProgram(connection, mint1PkForVerify);
    const ata0ForVerify = await getAssociatedTokenAddress(mint0PkForVerify, keypair.publicKey, false, mint0ProgramForVerify);
    const ata1ForVerify = await getAssociatedTokenAddress(mint1PkForVerify, keypair.publicKey, false, mint1ProgramForVerify);

    const postSwapBal0Res = await connection.getTokenAccountBalance(ata0ForVerify).catch(() => null);
    const postSwapBal1Res = await connection.getTokenAccountBalance(ata1ForVerify).catch(() => null);
    let actualToken0 = parseFloat(postSwapBal0Res?.value?.uiAmount || '0');
    let actualToken1 = parseFloat(postSwapBal1Res?.value?.uiAmount || '0');

    // For WSOL tokens, also check native SOL balance
    // Using variables already defined earlier in function scope

    let effectiveToken0 = actualToken0;
    let effectiveToken1 = actualToken1;

    if (isToken0Sol) {
      const solBalance = await connection.getBalance(keypair.publicKey);
      const solUi = solBalance / LAMPORTS_PER_SOL;
      const availableSol = Math.max(0, solUi - 0.05); // Keep 0.05 SOL for fees
      effectiveToken0 = Math.max(actualToken0, availableSol);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`💰 Token0 (SOL) - WSOL: ${actualToken0.toFixed(6)}, Native: ${solUi.toFixed(6)}, Available: ${effectiveToken0.toFixed(6)}`);
      }
    }

    if (isToken1Sol) {
      const solBalance = await connection.getBalance(keypair.publicKey);
      const solUi = solBalance / LAMPORTS_PER_SOL;
      const availableSol = Math.max(0, solUi - 0.05); // Keep 0.05 SOL for fees
      effectiveToken1 = Math.max(actualToken1, availableSol);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`💰 Token1 (SOL) - WSOL: ${actualToken1.toFixed(6)}, Native: ${solUi.toFixed(6)}, Available: ${effectiveToken1.toFixed(6)}`);
      }
    }

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`💰 Verified balances: ${effectiveToken0.toFixed(6)} ${dbPosition.token0_symbol}, ${effectiveToken1.toFixed(6)} ${dbPosition.token1_symbol}`);
    }

    // Calculate USD value of available tokens
    const token0UsdCheck = effectiveToken0 * (token0Info.price || token0Price);
    const token1UsdCheck = effectiveToken1 * (token1Info.price || token1Price);
    const totalUsdAvailable = token0UsdCheck + token1UsdCheck;

    // Verify we have sufficient balance (at least $2 worth total)
    const minUsdThreshold = 2.0;

    if (totalUsdAvailable < minUsdThreshold) {
      console.error(`❌ Insufficient balance: ${formatCurrency(totalUsdAvailable)} (minimum: ${formatCurrency(minUsdThreshold)})`);
      
      await bot.editMessageText(
        `⚠️ *Rebalance Partially Completed*\n\n` +
        `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n\n` +
        `✅ Position closed successfully\n` +
        `*Withdrawn:* ${formatCurrency(removeResult.totalUsd)}\n\n` +
        `❌ *Insufficient Balance to Create New Position*\n\n` +
        `*Current verified balances:*\n` +
        `• ${effectiveToken0.toFixed(6)} ${dbPosition.token0_symbol} (${formatCurrency(token0UsdCheck)})\n` +
        `• ${effectiveToken1.toFixed(6)} ${dbPosition.token1_symbol} (${formatCurrency(token1UsdCheck)})\n` +
        `• *Total:* ${formatCurrency(totalUsdAvailable)}\n\n` +
        `*Minimum required:* ${formatCurrency(minUsdThreshold)}\n\n` +
        `*What likely happened:*\n` +
        `${swapPerformed ? '• Balance swap may have failed or timed out\n' : ''}` +
        `• Check recent transactions in your wallet\n` +
        `• Some swaps may still be processing\n\n` +
        `*What to do:*\n` +
        `• Wait a few minutes and check your wallet balance\n` +
        `• If balance is correct, retry rebalance\n` +
        `• Or manually create position with /addposition`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '↻ Retry from last step', callback_data: `rebalance_retry_${nftMintAddress}` }],
              [{ text: '📊 View Positions', callback_data: 'positions' }]
            ]
          }
        }
      );
      return;
    }

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`✅ Balance verification passed: ${formatCurrency(totalUsdAvailable)} available`);
    }

    // Update currentToken0Amount and currentToken1Amount with verified amounts
    currentToken0Amount = effectiveToken0;
    currentToken1Amount = effectiveToken1;

    // 15. Open new position with balanced and verified tokens
    if (!isAutoRebalance && processingMsg) {
      await bot.editMessageText(
        `🔄 *Rebalancing Position...*\n\n` +
        `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n` +
        `*Range:* ±${dbPosition.range_percent}%\n\n` +
        `✅ *Step 1/4:* Position closed\n` +
        `✅ *Step 2/4:* Rewards converted${rewardsConvertedUsd ? ` (~${formatCurrency(rewardsConvertedUsd)})` : ''}\n` +
        `✅ *Step 3/4:* Tokens balanced${swapPerformed ? ` (swapped ${swapDetails.amountIn.toFixed(4)} ${swapDetails.from})` : ''}\n` +
        `✅ *Balances verified:* ${formatCurrency(totalUsdAvailable)}\n\n` +
        `*Step 4/4:* Opening new position...\n\n` +
        `⏳ *Submitting transaction...*`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
    }

    // Prepare token info for openPosition
    const tokenInfo = {
      token0Symbol: dbPosition.token0_symbol,
      token1Symbol: dbPosition.token1_symbol
    };

    // Capture pre-open balances for leftover detection
    const mint0PkForAta = new PublicKey(dbPosition.token0_mint);
    const mint1PkForAta = new PublicKey(dbPosition.token1_mint);
    const mint0Program = await getMintTokenProgram(connection, mint0PkForAta);
    const mint1Program = await getMintTokenProgram(connection, mint1PkForAta);
    const ata0 = await getAssociatedTokenAddress(mint0PkForAta, keypair.publicKey, false, mint0Program);
    const ata1 = await getAssociatedTokenAddress(mint1PkForAta, keypair.publicKey, false, mint1Program);
    const preBal0Res = await connection.getTokenAccountBalance(ata0).catch(() => null);
    const preBal1Res = await connection.getTokenAccountBalance(ata1).catch(() => null);
    const preBal0Raw = BigInt(preBal0Res?.value?.amount || "0");
    const preBal1Raw = BigInt(preBal1Res?.value?.amount || "0");
    const dec0ForCalc = typeof preBal0Res?.value?.decimals === 'number' ? preBal0Res.value.decimals : token0Withdrawn.decimals;
    const dec1ForCalc = typeof preBal1Res?.value?.decimals === 'number' ? preBal1Res.value.decimals : token1Withdrawn.decimals;
    const prepared0Ui = currentToken0Amount;
    const prepared1Ui = currentToken1Amount;

    // Open position with only the tokens withdrawn from the closed position (now balanced)
    const openResult = await openPosition(connection, keypair, poolPk, PANCAKESWAP_IDL, {
      rangePercent: dbPosition.range_percent,
      slippageBps: DEFAULT_OPEN_POSITION_SLIPPAGE_BPS,
      maxToken0ToUse: currentToken0Amount,
      maxToken1ToUse: currentToken1Amount,
      tokenInfo
    });

    if (!openResult.success) {
      // Auto-unwrap WSOL to native SOL even on failure
      if (isToken0Sol || isToken1Sol) {
        await unwrapWSol(connection, keypair, { commitmentLevel: COMMITMENT_LEVEL });
      }

      const unwrapNote = '';

      // Special-case: insufficient SOL reserve for fees
      if ((openResult.error || '').includes('Insufficient SOL balance. Need at least')) {
        const required = (openResult.error || '').match(/at least ([0-9.]+) SOL/)?.[1] || '0.05';
        await bot.editMessageText(
          `⚠️ *Rebalance Partially Completed*\n\n` +
          `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n\n` +
          `✅ Position closed successfully\n` +
          `*Withdrawn:* ${formatCurrency(removeResult.totalUsd)}\n\n` +
          `❌ *Insufficient SOL for Fees*\n` +
          `Your SOL balance is below the required reserve to open a new position.\n\n` +
          `*Required:* ${required} SOL (fee reserve)\n` +
          `*What to do:*\n` +
          `• Top up wallet to ≥ ${required} SOL (recommend +${RECOMMENDED_SOL_BUFFER} SOL buffer)\n` +
          `• Or lower the fee reserve in advanced settings (minSolReserve)\n\n` +
          `After topping up, retry rebalance.${unwrapNote}`,
          {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '↻ Retry from last step', callback_data: `rebalance_retry_${nftMintAddress}` }],
                [{ text: '📊 View Positions', callback_data: 'positions' }]
              ]
            }
          }
        );
        return;
      }

      await bot.editMessageText(
        `⚠️ *Rebalance Partially Completed*\n\n` +
        `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n\n` +
        `✅ Position closed successfully\n` +
        `*Withdrawn:* ${formatCurrency(removeResult.totalUsd)}\n\n` +
        `❌ Failed to open new position:\n` +
        `${openResult.error}\n\n` +
        `Your tokens are now in your wallet. You can manually create a new position with /addposition.${unwrapNote}`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '↻ Retry from last step', callback_data: `rebalance_retry_${nftMintAddress}` }],
              [{ text: '📊 View Positions', callback_data: 'positions' }]
            ]
          }
        }
      );
      return;
    }
    
    // Capture open position transaction link
    txLinks.open = openResult.explorer;

    // Optional: Top-up leftover liquidity if utilization < threshold
    let topUpPerformed = false;
    let topUpDetails = null;
    let topUpUsd = 0;
    try {
      const topUpEnabled = String(process.env.REBALANCE_TOP_UP_ENABLED ?? 'true').toLowerCase() === 'true';
      const minUtilization = parseFloat(process.env.REBALANCE_TOP_UP_MIN_UTILIZATION ?? '0.5');
      const dustUsd = parseFloat(process.env.REBALANCE_TOP_UP_DUST_USD ?? '1');

      if (topUpEnabled) {
        const postBal0Res = await connection.getTokenAccountBalance(ata0).catch(() => null);
        const postBal1Res = await connection.getTokenAccountBalance(ata1).catch(() => null);
        const postBal0Raw = BigInt(postBal0Res?.value?.amount || "0");
        const postBal1Raw = BigInt(postBal1Res?.value?.amount || "0");

        const used0Ui = Number(preBal0Raw > postBal0Raw ? (preBal0Raw - postBal0Raw) : 0n) / (10 ** dec0ForCalc);
        const used1Ui = Number(preBal1Raw > postBal1Raw ? (preBal1Raw - postBal1Raw) : 0n) / (10 ** dec1ForCalc);

        const preparedUsd = (prepared0Ui * (token0Info.price || token0Price)) + (prepared1Ui * (token1Info.price || token1Price));
        const usedUsd = (used0Ui * (token0Info.price || token0Price)) + (used1Ui * (token1Info.price || token1Price));
        const utilization = preparedUsd > 0 ? (usedUsd / preparedUsd) : 1;

        const leftover0Ui = Math.max(0, prepared0Ui - used0Ui);
        const leftover1Ui = Math.max(0, prepared1Ui - used1Ui);
        const leftoverUsd = (leftover0Ui * (token0Info.price || token0Price)) + (leftover1Ui * (token1Info.price || token1Price));

        if (preparedUsd > 0 && utilization < minUtilization && leftoverUsd > dustUsd) {
          if (!isAutoRebalance && processingMsg) {
            await bot.editMessageText(
              `🔄 *Rebalancing Position...*\n\n` +
              `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n` +
              `*Range:* ±${dbPosition.range_percent}%\n\n` +
              `✅ *Step 1/4:* Position closed\n` +
              `✅ *Step 2/4:* Rewards converted${rewardsConvertedUsd ? ` (~${formatCurrency(rewardsConvertedUsd)})` : ''}\n` +
              `✅ *Step 3/4:* Tokens balanced${swapPerformed ? ` (swapped ${swapDetails.amountIn.toFixed(4)} ${swapDetails.from})` : ''}\n` +
              `✅ *Step 4/4:* New position opened\n\n` +
              `➕ Adding leftover liquidity...`,
              {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown'
              }
            );
          }

          const newPositionMintPk = new PublicKey(openResult.positionNftMint);
          const addOpts = {};
          if (leftover0Ui > 0 && leftover1Ui > 0) {
            addOpts.amount0 = leftover0Ui;
            addOpts.amount1 = leftover1Ui;
          } else if (leftover0Ui > 0) {
            addOpts.amount0 = leftover0Ui;
            addOpts.baseFlag = true; // calculate from token0 only
          } else if (leftover1Ui > 0) {
            addOpts.amount1 = leftover1Ui;
            addOpts.baseFlag = false; // calculate from token1 only
          }
          addOpts.slippageBps = DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS;

          if (addOpts.amount0 || addOpts.amount1) {
            const addRes = await addLiquidity(connection, keypair, newPositionMintPk, addOpts);
            if (addRes?.success) {
              topUpPerformed = true;
              topUpUsd = addRes.totalUsd || 0;
              topUpDetails = addRes.tokensDeposited || [];
              if (process.env.LOG_LEVEL === 'debug') {
                console.log(`✅ Top-up liquidity added: ${formatCurrency(topUpUsd)}`);
              }
              if (addRes.explorer) {
                txLinks.topUp = addRes.explorer;
              }
            } else {
              console.warn(`⚠️  Top-up addLiquidity failed: ${addRes?.error || 'unknown error'}`);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Top-up step skipped due to error:', e?.message || e);
    }

    // Auto-unwrap WSOL to native SOL after successful position opening and potential top-up
    if (isToken0Sol || isToken1Sol) {
      await unwrapWSol(connection, keypair, { commitmentLevel: COMMITMENT_LEVEL });
    }

    // 15.1 Calculate ACTUAL wallet leftovers after all operations
    let actualLeftover0Ui = 0;
    let actualLeftover1Ui = 0;
    let actualLeftoverUsd = 0;
    
    try {
      // Wait a moment for balances to settle after unwrap
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // If token0 is SOL (WSOL), check native SOL balance (after unwrap)
      // Otherwise check token account
      if (isToken0Sol) {
        const solBalance = await connection.getBalance(keypair.publicKey);
        actualLeftover0Ui = solBalance / LAMPORTS_PER_SOL;
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Native SOL balance: ${actualLeftover0Ui.toFixed(6)} SOL`);
        }
      } else {
        const finalBal0Res = await connection.getTokenAccountBalance(ata0).catch(() => null);
        actualLeftover0Ui = parseFloat(finalBal0Res?.value?.uiAmount || '0');
      }
      
      // If token1 is SOL (WSOL), check native SOL balance (after unwrap)
      // Otherwise check token account
      if (isToken1Sol) {
        const solBalance = await connection.getBalance(keypair.publicKey);
        actualLeftover1Ui = solBalance / LAMPORTS_PER_SOL;
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Native SOL balance: ${actualLeftover1Ui.toFixed(6)} SOL`);
        }
      } else {
        const finalBal1Res = await connection.getTokenAccountBalance(ata1).catch(() => null);
        actualLeftover1Ui = parseFloat(finalBal1Res?.value?.uiAmount || '0');
      }
      
      // Calculate USD value of leftovers
      actualLeftoverUsd = (actualLeftover0Ui * (token0Info.price || token0Price)) + 
                          (actualLeftover1Ui * (token1Info.price || token1Price));
      
      console.log(`💰 Wallet leftovers: ${actualLeftover0Ui.toFixed(6)} ${dbPosition.token0_symbol} + ${actualLeftover1Ui.toFixed(6)} ${dbPosition.token1_symbol} = ${formatCurrency(actualLeftoverUsd)}`);
    } catch (leftoverError) {
      console.warn('Failed to calculate wallet leftovers:', leftoverError?.message || leftoverError);
    }

    // 15.5 Automatically add leftover liquidity if significant (> $10)
    let autoAddPerformed = false;
    let autoAddUsd = 0;
    let autoAddDetails = null;
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[AUTO-ADD] Checking leftover: ${formatCurrency(actualLeftoverUsd)} (threshold: $10)`);
    }
    
    if (actualLeftoverUsd > 10) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[AUTO-ADD] ✅ Leftover exceeds $10, using executeTopUp`);
      }
      try {
        // Update progress message (skip for auto-rebalance if processingMsg.text is unavailable)
        if (processingMsg?.message_id && processingMsg.text) {
          await bot.editMessageText(
            `${processingMsg.text}\n\n` +
            `💡 *Auto-adding leftover ${formatCurrency(actualLeftoverUsd)}...*`,
            {
              chat_id: chatId,
              message_id: processingMsg.message_id,
              parse_mode: 'Markdown'
            }
          );
        }
        
        const topUpResult = await executeTopUp({
          connection,
          keypair,
          positionMintAddress: openResult.positionNftMint,
          targetUsd: actualLeftoverUsd,
          positionData: dbPosition
        });
        
        if (topUpResult.success) {
          autoAddPerformed = true;
          autoAddUsd = topUpResult.totalUsd || 0;
          autoAddDetails = {
            tokensDeposited: topUpResult.tokensDeposited,
            signature: topUpResult.signature,
            explorer: topUpResult.explorer
          };
          
          // Add to transaction links
          txLinks.autoAdd = topUpResult.explorer;
          if (topUpResult.swapResults && topUpResult.swapResults.length > 0) {
            topUpResult.swapResults.forEach(swap => {
              if (swap.signature && !txLinks.balanceSwap) {
                txLinks.balanceSwap = `https://solscan.io/tx/${swap.signature}`;
              }
            });
          }
          
          console.log(`✅ Auto-added liquidity: ${formatCurrency(autoAddUsd)}`);
          
          // Unwrap WSOL again after auto-add
          if (isToken0Sol || isToken1Sol) {
            await unwrapWSol(connection, keypair, { commitmentLevel: COMMITMENT_LEVEL });
          }
          
          // Recalculate final leftovers after auto-add
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          if (isToken0Sol) {
            const solBalance = await connection.getBalance(keypair.publicKey);
            actualLeftover0Ui = solBalance / LAMPORTS_PER_SOL;
          } else {
            const finalBal0Res = await connection.getTokenAccountBalance(ata0).catch(() => null);
            actualLeftover0Ui = parseFloat(finalBal0Res?.value?.uiAmount || '0');
          }
          
          if (isToken1Sol) {
            const solBalance = await connection.getBalance(keypair.publicKey);
            actualLeftover1Ui = solBalance / LAMPORTS_PER_SOL;
          } else {
            const finalBal1Res = await connection.getTokenAccountBalance(ata1).catch(() => null);
            actualLeftover1Ui = parseFloat(finalBal1Res?.value?.uiAmount || '0');
          }
          
          actualLeftoverUsd = (actualLeftover0Ui * (token0Info.price || token0Price)) + 
                              (actualLeftover1Ui * (token1Info.price || token1Price));
          
          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`[AUTO-ADD] Recalculated leftovers after auto-add: ${formatCurrency(actualLeftoverUsd)}`);
          }
        } else {
          console.warn('⚠️ Auto-add failed:', topUpResult.error);
        }
      } catch (autoAddError) {
        console.warn('⚠️ Auto-add error:', autoAddError?.message || autoAddError);
      }
    } else {
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[AUTO-ADD] ❌ Leftover ${formatCurrency(actualLeftoverUsd)} is below $10 threshold, skipping`);
      }
    }

    // 16. Save new position to database
    const finalDepositedUsd = (openResult.estimatedUsd || 0) + 
                               (topUpPerformed ? (topUpUsd || 0) : 0) +
                               (autoAddPerformed ? autoAddUsd : 0);
    
    // Track manual vs auto rebalance (Phase 5: New Strategy)
    isAutoRebalance = !!msg._autoRebalanceWallet;
    const rebalanceType = isAutoRebalance ? 'auto' : 'manual';
    const isManualTightRange = !isAutoRebalance && dbPosition.range_percent < 1.0;
    
    const newDbPos = await upsertPosition({
      wallet_id: wallet.id,
      nft_mint: openResult.positionNftMint,
      pool_address: dbPosition.pool_address,
      token0_mint: dbPosition.token0_mint,
      token1_mint: dbPosition.token1_mint,
      token0_symbol: dbPosition.token0_symbol,
      token1_symbol: dbPosition.token1_symbol,
      fee_tier: dbPosition.fee_tier,
      lower_price: openResult.priceRange.lower,
      upper_price: openResult.priceRange.upper,
      current_price: openResult.priceRange.current,
      liquidity_value_usd: finalDepositedUsd,
      range_percent: dbPosition.range_percent,
      auto_rebalance_enabled: dbPosition.auto_rebalance_enabled, // Preserve auto-rebalance setting
      claim_before_rebalance: dbPosition.claim_before_rebalance, // Preserve claim-before-rebalance setting
      last_rebalance_type: rebalanceType, // Track manual vs auto
      manual_range_locked: isManualTightRange, // Lock if user manually set <1%
      status: 'active'
    });

    // 16.1 Carry over statistics from old position to new position (CRITICAL!)
    // This maintains continuity: daily caps, time tracking, PnL, mode state
    try {
      await carryOverStatistics(dbPosition.id, newDbPos.id);
    } catch (carryError) {
      console.error('❌ Failed to carry over statistics:', carryError?.message || carryError);
      // Continue anyway - at least we'll have fresh stats for new position
    }

    // 16.2 Carry over proximity and out-of-range alert settings from old position
    try {
      const existingCfg = await getOutOfRangeConfig(dbPosition.id);
      if (existingCfg && newDbPos && newDbPos.id) {
        const lower = openResult.priceRange.lower;
        const upper = openResult.priceRange.upper;
        const width = upper - lower;
        const threshold = (typeof existingCfg.threshold_percentage === 'number' && isFinite(existingCfg.threshold_percentage))
          ? existingCfg.threshold_percentage
          : 10;
        const distance = width * (threshold / 100);
        const lowerAlert = lower + distance;
        const upperAlert = upper - distance;

        await ensureProximityRow(newDbPos.id);
        await upsertProximityAlert(newDbPos.id, threshold, lowerAlert, upperAlert);

        if (existingCfg.enabled === false) {
          await setProximityEnabled(newDbPos.id, false);
        }

        if (existingCfg.out_of_range_enabled === false) {
          await toggleOutOfRangeEnabled(newDbPos.id);
        }
      }
    } catch (carryError) {
      console.warn('Failed to carry over alert settings:', carryError?.message || carryError);
    }

    // 16.3 Record rebalance in statistics (cost tracking for automation decisions)
    // This increments counters on TOP of carried-over values
    const rebalanceCostUsd = removeResult.totalUsd * 0.001; // 0.1% = 0.001
    try {
      await recordRebalance(newDbPos.id, rebalanceCostUsd);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`📊 Recorded rebalance: cost ${rebalanceCostUsd.toFixed(4)} USD for position ${newDbPos.id}`);
      }
    } catch (statsError) {
      console.warn('Failed to record rebalance in statistics:', statsError?.message || statsError);
    }

    // 16.4 Record rebalance transaction with range details (for history/audit)
    try {
      await recordRebalanceTransaction(wallet.id, dbPosition.id, newDbPos.id, {
        costUsd: rebalanceCostUsd,
        rangePercent: dbPosition.range_percent || 5,
        lowerPrice: openResult.priceRange.lower,
        upperPrice: openResult.priceRange.upper,
        currentPrice: openResult.priceRange.current,
        signature: openResult.signature || null,
        feeSol: 0 // Could track this if needed
      });
    } catch (txError) {
      console.error(`❌ Failed to record rebalance transaction:`, txError?.message || txError);
    }

    // 📸 TRACKING: Capture wallet + LP value AFTER ALL operations complete
    // This includes: position opened, top-up, auto-add, unwrap, everything
    let snapshotAfter = null;
    let worthLossAnalysis = null;
    try {
      const newPersonalPositionPk = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), new PublicKey(openResult.positionNftMint).toBuffer()],
        PROGRAM_ID
      )[0];
      snapshotAfter = await captureRebalanceSnapshot(connection, keypair.publicKey, dbPosition, newPersonalPositionPk.toString());
      
      // Calculate and log worth loss
      if (snapshotBefore && snapshotAfter) {
        worthLossAnalysis = calculateWorthLoss(snapshotBefore, snapshotAfter);
        logWorthLossAnalysis(worthLossAnalysis, dbPosition);
        
        // Save P/L to database
        try {
          await recordRebalancePL(dbPosition.id, worthLossAnalysis.difference.total);
        } catch (dbError) {
          console.warn(`⚠️  Failed to save rebalance P/L to database: ${dbError.message}`);
        }
      }
    } catch (trackError) {
      console.warn(`⚠️  Failed to capture after snapshot: ${trackError.message}`);
    }

    // Fetch cumulative P/L for display
    let cumulativePL = null;
    try {
      const { getPositionStatistics } = await import('../../services/position-statistics.service.js');
      const stats = await getPositionStatistics(dbPosition.id);
      if (stats) {
        cumulativePL = stats.cumulative_rebalance_pl_usd;
      }
    } catch (plError) {
      console.warn(`⚠️  Failed to fetch cumulative P/L: ${plError.message}`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Build unwrapping note
    const unwrapNote = '';
    
    // Build transactions section
    const txLines = [];
    if (txLinks.remove) txLines.push(`• [Remove Liquidity](${txLinks.remove})`);
    if (txLinks.rewardSwaps.length > 0) {
      txLinks.rewardSwaps.forEach((url, i) => txLines.push(`• [Reward Swap ${i + 1}](${url})`));
    }
    if (txLinks.balanceSwap) txLines.push(`• [Balance Swap](${txLinks.balanceSwap})`);
    if (txLinks.open) txLines.push(`• [Open New Position](${txLinks.open})`);
    if (txLinks.topUp) txLines.push(`• [Add Liquidity (Top-up)](${txLinks.topUp})`);
    if (txLinks.autoAdd) txLines.push(`• [Add Liquidity (Auto)](${txLinks.autoAdd})`);
    const transactionsSection = txLines.length ? `*Transactions:*\n${txLines.join('\n')}\n\n` : '';

    // 17. Send success message
    const walletOwnerLine = wallet.label
      ? `*Wallet:* ${wallet.label}`
      : `*Wallet:* \`${formatShortAddress(wallet.wallet_address)}\``;

    // isAutoRebalance already set earlier (no need to redeclare)
    
    let successMessage;
    
    // Calculate capital distribution for both message types
    const totalCapital = finalDepositedUsd + actualLeftoverUsd;
    const utilizationPercent = totalCapital > 0 ? (finalDepositedUsd / totalCapital) * 100 : 100;
    const walletPercent = totalCapital > 0 ? (actualLeftoverUsd / totalCapital) * 100 : 0;
    
    // Build worth loss line for messages
    let worthLossLine = '';
    if (worthLossAnalysis) {
      const lossIcon = worthLossAnalysis.isProfit ? '💰' : '📉';
      const lossText = worthLossAnalysis.isProfit ? 'Gain' : 'Loss';
      const sign = worthLossAnalysis.difference.total >= 0 ? '+' : '';
      worthLossLine = `${lossIcon} *${lossText}:* ${sign}${worthLossAnalysis.worthLossPercent.toFixed(4)}% (${sign}${formatCurrency(worthLossAnalysis.difference.total)})`;
      
      // Add cumulative P/L
      if (cumulativePL !== null) {
        const cumSign = cumulativePL >= 0 ? '+' : '';
        const cumIcon = cumulativePL >= 0 ? '💰' : '📉';
        worthLossLine += `\n${cumIcon} *Total Rebalances P/L:* ${cumSign}${formatCurrency(cumulativePL)}`;
      }
    }
    
    if (isAutoRebalance) {
      // Minimal message for auto-rebalance
      successMessage = `✅ *Position Auto-Rebalanced Successfully!*\n\n` +
        `${walletOwnerLine}\n\n` +
        `• *New Range:* ±*${dbPosition.range_percent}%*\n` +
        `• *Price:* ${openResult.priceRange.current.toFixed(6)}\n` +
        `• *Deposited:* ${formatCurrency(finalDepositedUsd)}\n\n` +
        `• *In Wallet:* ${formatCurrency(actualLeftoverUsd)} (${walletPercent.toFixed(1)}%)` +
        (worthLossLine ? `\n\n${worthLossLine}` : '');
    } else {
      // Detailed message for manual rebalance
      successMessage = `✅ *Position Rebalanced Successfully!*\n\n` +
        `${walletOwnerLine}\n\n` +
        `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n` +
        `*New Position:* \`${formatShortAddress(openResult.positionNftMint)}\`\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `*Closed Position:*\n` +
        `• Withdrawn: ${formatCurrency(removeResult.totalUsd)}\n` +
        `• Rent Reclaimed: ${removeResult.rentReclaimed ? `${removeResult.rentReclaimed.toFixed(4)} SOL` : 'N/A'}\n\n`;

      // if (swapPerformed && swapDetails) {
      //   successMessage += `*Token Balancing:*\n` +
      //     `• Swapped: ${swapDetails.amountIn.toFixed(6)} ${swapDetails.from}\n` +
      //     `• Received: ${swapDetails.amountOut.toFixed(6)} ${swapDetails.to}\n\n`;
      // }

      successMessage += `*New Position:*\n` +
        `• Range: ±${dbPosition.range_percent}%\n` +
        // `• Lower: ${openResult.priceRange.lower.toFixed(6)}\n` +
        // `• Current: ${openResult.priceRange.current.toFixed(6)}\n` +
        // `• Upper: ${openResult.priceRange.upper.toFixed(6)}\n` +
        `• Deposited: ${formatCurrency(finalDepositedUsd)}`;
      
      // Add notes about additional deposits
      const depositNotes = [];
      if (topUpPerformed && topUpUsd) depositNotes.push(`top-up ${formatCurrency(topUpUsd)}`);
      
      successMessage += '\n\n';

      successMessage += `*Capital Distribution:*\n` +
        `• In Position: ${formatCurrency(finalDepositedUsd)} (${utilizationPercent.toFixed(1)}%)\n`;
      
      if (actualLeftoverUsd > 0.01) {
        successMessage += `• In Wallet: ${formatCurrency(actualLeftoverUsd)} (${(100 - utilizationPercent).toFixed(1)}%)\n\n`;
      }
      
      if (actualLeftoverUsd < 10) {
        successMessage += `ℹ️ Small leftover amount (${formatCurrency(actualLeftoverUsd)}) remains in wallet.\n\n`;
      }
      
      // Add worth loss line
      if (worthLossLine) {
        successMessage += `${worthLossLine}\n\n`;
      }
      
      successMessage += `⏱ *Duration:* ${duration}s\n\n` +
        `${transactionsSection}${unwrapNote}`;
    }

    // Build inline keyboard with conditional "Add More" button
    const inlineKeyboard = [];
    
    // Only show "Add More" button if:
    // 1. We didn't auto-add, or auto-add failed
    // 2. AND there are still significant leftovers (> $10)
    if (!autoAddPerformed && actualLeftoverUsd > 10) {
      inlineKeyboard.push([
        { text: '📊 View Positions', callback_data: 'positions' }
      ]);
    } else {
      inlineKeyboard.push([
        { text: '📊 View Positions', callback_data: 'positions' }
      ]);
    }

    // Update the processing message with success result
    if (processingMsg?.message_id) {
      try {
        await bot.editMessageText(
          successMessage,
          {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: inlineKeyboard
            }
          }
        );
      } catch (editError) {
        // If editing fails (e.g., message deleted), send as new message for auto-rebalance
        if (isAutoRebalance) {
          console.warn('Failed to edit auto-rebalance message, sending new message:', editError.message);
          await bot.sendMessage(chatId, successMessage, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: inlineKeyboard }
          });
        } else {
          throw editError;
        }
      }
    } else if (isAutoRebalance) {
      // No message ID available for auto-rebalance, send as new message
      await bot.sendMessage(chatId, successMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    }

    // Update the persistent reply keyboard after successful rebalance
    // This updates the pool buttons to reflect the new position
    try {
      await updatePoolsReplyKeyboard(bot, chatId, wallet.wallet_address);
    } catch (keyboardError) {
      console.warn('Failed to update reply keyboard after rebalance:', keyboardError.message);
    }

    // Release rebalance lock on success
    unlockRebalance(wallet?.wallet_address);

  } catch (error) {
    console.error('Error in handleRebalance:', error);
    
    // Release rebalance lock on error
    unlockRebalance(wallet?.wallet_address);
    
    // Check if this is auto-rebalance (suppress error messages for auto-rebalance)
    const isAutoRebalance = !!msg._autoRebalanceWallet;
    
    if (!isAutoRebalance) {
      // Only send error message for manual rebalance
      const walletLabel = wallet?.label ? `*Wallet:* ${wallet.label}\n\n` : '';
    await bot.sendMessage(chatId,
      `❌ *Rebalance Failed*\n\n` +
      walletLabel +
      `An unexpected error occurred:\n` +
      `${error?.message}`,
      { parse_mode: 'Markdown' }
    );
    } else {
      // Auto-rebalance: Just log the error, don't notify user
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`⚠️  Auto-rebalance failed for position: ${error?.message}`);
      }
    }
  }
}

/**
 * Handles rebalance callback from inline buttons
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleRebalanceCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const nftAddress = data.replace('rebalance_', '');

  // Answer callback immediately
  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Starting rebalance...' });

  // Call main handler with simulated message
  const simulatedMsg = {
    chat: { id: chatId },
    from: { id: callbackQuery.from.id }
  };

  await handleRebalance(bot, simulatedMsg, [nftAddress]);
}

/**
 * Handles "Add More Liquidity" callback from rebalance success message
 * 
 * Adds remaining wallet tokens to the newly created position after rebalance
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleAddMoreLiquidityCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const positionMint = data.replace('addliq_', '');

  // Answer callback immediately
  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Adding liquidity...' });

  try {
    // Get wallet with encryption
    const wallet = await getActiveWalletWithEncryption(telegramId);
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ No wallet configured.', { parse_mode: 'Markdown' });
      return;
    }

    // Decrypt private key
    const privateKey = decryptPrivateKey(
      wallet.encrypted_private_key,
      wallet.nonce,
      wallet.salt,
      process.env.MASTER_PASSWORD
    );
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = createSolanaConnection();

    // Send processing message
    const processingMsg = await bot.sendMessage(chatId,
      `➕ *Adding More Liquidity...*\n\n` +
      `*Position:* \`${formatShortAddress(positionMint)}\`\n\n` +
      `⏳ *Checking wallet balances...*`,
      { parse_mode: 'Markdown' }
    );

    // Get position from DB to find pool and token info
    const dbPosition = await getPositionByNft(positionMint);
    if (!dbPosition) {
      await bot.editMessageText(
        `❌ *Position Not Found*\n\n` +
        `Could not find this position in database.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    // Get token accounts
    const mint0 = new PublicKey(dbPosition.token0_mint);
    const mint1 = new PublicKey(dbPosition.token1_mint);
    const mint0Program = await getMintTokenProgram(connection, mint0);
    const mint1Program = await getMintTokenProgram(connection, mint1);

    const ata0 = await getAssociatedTokenAddress(mint0, keypair.publicKey, false, mint0Program);
    const ata1 = await getAssociatedTokenAddress(mint1, keypair.publicKey, false, mint1Program);

    // Get wallet balances
    const [bal0Res, bal1Res] = await Promise.all([
      connection.getTokenAccountBalance(ata0).catch(() => null),
      connection.getTokenAccountBalance(ata1).catch(() => null)
    ]);

    let token0Amount = parseFloat(bal0Res?.value?.uiAmount || '0');
    let token1Amount = parseFloat(bal1Res?.value?.uiAmount || '0');

    // Handle WSOL case: check native SOL balance if token is SOL
    const isToken0Sol = dbPosition.token0_mint === KNOWN_TOKENS.SOL.mint;
    const isToken1Sol = dbPosition.token1_mint === KNOWN_TOKENS.SOL.mint;
    
    // Determine slippage for SOL calculations
    const rangePercent = dbPosition.range_percent || 5;
    let slippageBps;
    if (rangePercent < 1) {
      slippageBps = 500;
    } else if (rangePercent < 5) {
      slippageBps = 300;
    } else {
      slippageBps = DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS;
    }
    const slippageMultiplier = 1 + (slippageBps / 10000);
    
    // If token0 is SOL and token account balance is zero, check native SOL balance
    if (isToken0Sol && token0Amount === 0) {
      const solBalance = await connection.getBalance(keypair.publicKey);
      const solUi = solBalance / LAMPORTS_PER_SOL;
      const minReserve = 0.05; // Keep minimum for fees
      const effectiveBalance = Math.max(0, solUi - minReserve);
      token0Amount = effectiveBalance / slippageMultiplier;
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`Native SOL balance: ${solUi.toFixed(6)} SOL, usable after reserve+slippage: ${token0Amount.toFixed(6)} SOL`);
      }
    }
    
    // If token1 is SOL and token account balance is zero, check native SOL balance
    if (isToken1Sol && token1Amount === 0) {
      const solBalance = await connection.getBalance(keypair.publicKey);
      const solUi = solBalance / LAMPORTS_PER_SOL;
      const minReserve = 0.05; // Keep minimum for fees
      const effectiveBalance = Math.max(0, solUi - minReserve);
      token1Amount = effectiveBalance / slippageMultiplier;
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`Native SOL balance: ${solUi.toFixed(6)} SOL, usable after reserve+slippage: ${token1Amount.toFixed(6)} SOL`);
      }
    }

    if (token0Amount === 0 && token1Amount === 0) {
      await bot.editMessageText(
        `❌ *No Tokens Available*\n\n` +
        `Your wallet has no ${dbPosition.token0_symbol} or ${dbPosition.token1_symbol} to add.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    // Update message with amounts
    await bot.editMessageText(
      `➕ *Adding More Liquidity...*\n\n` +
      `*Position:* \`${formatShortAddress(positionMint)}\`\n\n` +
      `*Available Tokens:*\n` +
      `• ${token0Amount.toFixed(6)} ${dbPosition.token0_symbol}\n` +
      `• ${token1Amount.toFixed(6)} ${dbPosition.token1_symbol}\n\n` +
      `⏳ *Submitting transaction...*`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown'
      }
    );

    // Call addLiquidity with available amounts
    const positionMintPk = new PublicKey(positionMint);
    const addOpts = {};
    
    if (token0Amount > 0 && token1Amount > 0) {
      addOpts.amount0 = token0Amount;
      addOpts.amount1 = token1Amount;
    } else if (token0Amount > 0) {
      addOpts.amount0 = token0Amount;
      addOpts.baseFlag = true;
    } else if (token1Amount > 0) {
      addOpts.amount1 = token1Amount;
      addOpts.baseFlag = false;
    }
    
    addOpts.slippageBps = slippageBps;
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Using ${slippageBps} bps slippage for ±${rangePercent}% range position`);
    }

    const addRes = await addLiquidity(connection, keypair, positionMintPk, addOpts);

    if (!addRes.success) {
      // Check if it's a slippage error
      const isSlippageError = addRes.error?.includes('6021') || 
                              addRes.error?.includes('PriceSlippageCheck') || 
                              addRes.error?.includes('0x1785');
      
      let errorMessage = `❌ *Failed to Add Liquidity*\n\n`;
      
      if (isSlippageError) {
        errorMessage += `*Price Slippage Check Failed*\n\n` +
          `The price moved while preparing the transaction.\n` +
          `This is common with narrow-range positions (±${rangePercent}%).\n\n` +
          `*What happened:*\n` +
          `• Your position range: ±${rangePercent}%\n` +
          `• Slippage used: ${(slippageBps / 100).toFixed(1)}%\n` +
          `• Price moved slightly, exceeding tolerance\n\n` +
          `*Try:*\n` +
          `• Click "🔄 Try Again" (fresh price check)\n` +
          `• Or add manually via /addposition later`;
      } else {
        errorMessage += `*Error:* ${addRes.error}\n\n` +
          `*Common Causes:*\n` +
          `• Insufficient balance\n` +
          `• Price moved outside range\n` +
          `• Network congestion`;
      }
      
      await bot.editMessageText(
        errorMessage,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Again', callback_data: `addliq_${positionMint}` }],
              [{ text: '📊 View Positions', callback_data: 'positions' }]
            ]
          }
        }
      );
      return;
    }

    // Success!
    const depositedTokens = addRes.tokensDeposited.map(token => 
      `• ${token.uiAmount.toFixed(6)} ${token.symbol}`
    ).join('\n');

    await bot.editMessageText(
      `✅ *Liquidity Added Successfully!*\n\n` +
      `*Position:* \`${formatShortAddress(positionMint)}\`\n\n` +
      `*Tokens Deposited:*\n${depositedTokens}\n\n` +
      `*Total Value:* ${formatCurrency(addRes.totalUsd)}\n\n` +
      `*Transaction:*\n[View on Solscan](${addRes.explorer})`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 View Positions', callback_data: 'positions' }]
          ]
        }
      }
    );

  } catch (error) {
    console.error('Error in handleAddMoreLiquidityCallback:', error);
    await bot.sendMessage(chatId,
      `❌ *Failed to Add Liquidity*\n\n` +
      `${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}


/**
 * Retry rebalance from the token balancing/opening stage.
 * Detects if position is already closed and continues from the right step.
 *
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleRebalanceRetryCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const nftAddress = data.replace('rebalance_retry_', '');

  // Answer callback immediately
  await bot.answerCallbackQuery(callbackQuery.id, { text: '↻ Retrying from last step...' });

  try {
    // Check if position is already closed
    const dbPosition = await getPositionByNft(nftAddress);
    
    if (!dbPosition) {
      await bot.sendMessage(chatId,
        `❌ *Position Not Found*\n\n` +
        `Could not find this position in the database.\n\n` +
        `Position: \`${formatShortAddress(nftAddress)}\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // If position is still active, just retry normally
    if (dbPosition.status === 'active') {
      const simulatedMsg = {
        chat: { id: chatId },
        from: { id: telegramId }
      };
      await handleRebalance(bot, simulatedMsg, [nftAddress]);
      return;
    }

    // Position is closed - continue from token balancing step
    if (dbPosition.status === 'closed') {
      await continueRebalanceFromWalletBalances(bot, chatId, telegramId, dbPosition);
      return;
    }

    // Unknown status
    await bot.sendMessage(chatId,
      `❌ *Invalid Position Status*\n\n` +
      `Position status: ${dbPosition.status}\n\n` +
      `Expected: active or closed`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Error in handleRebalanceRetryCallback:', error);
    await bot.sendMessage(chatId,
      `❌ *Retry Failed*\n\n` +
      `${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Continue rebalance from wallet balances when position is already closed
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {number} chatId - Telegram chat ID
 * @param {number} telegramId - Telegram user ID
 * @param {Object} dbPosition - Database position object
 * @param {Object} [walletOverride] - Optional wallet to use (for auto-rebalance context)
 */
export async function continueRebalanceFromWalletBalances(bot, chatId, telegramId, dbPosition, walletOverride = null) {
  const nftMintAddress = dbPosition.nft_mint;

  try {
    // Get wallet (use override for auto-rebalance, otherwise get active wallet)
    const wallet = walletOverride || await getActiveWalletWithEncryption(telegramId);
    if (!wallet) {
      await bot.sendMessage(chatId,
        '❌ No wallet configured. Use /newwallet or /importwallet',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Verify wallet ownership
    if (dbPosition.wallet_id !== wallet.id) {
      await bot.sendMessage(chatId,
        `❌ *Access Denied*\n\n` +
        `This position belongs to a different wallet.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Decrypt private key
    let privateKey;
    try {
      privateKey = decryptPrivateKey(
        wallet.encrypted_private_key,
        wallet.nonce,
        wallet.salt,
        process.env.MASTER_PASSWORD
      );
    } catch (decryptError) {
      await bot.sendMessage(chatId,
        `❌ *Decryption Failed*\n\n` +
        `Could not decrypt wallet private key.\n\n` +
        `${decryptError.message}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = createSolanaConnection();

    // Acquire rebalance lock to prevent race conditions with recovery job
    lockRebalance(wallet.wallet_address);

    // Check if wallet has claim address configured
    const claimAddress = await getWalletClaimAddress(wallet.id);
    const shouldTransferRewards = !!claimAddress;
    // Rewards were already collected when position was closed, so we don't transfer them again
    const rewardsAll = [];

    // Send processing message
    const processingMsg = await bot.sendMessage(chatId,
      `🔄 *Resuming Rebalance...*\n\n` +
      `*Old Position:* \`${formatShortAddress(nftMintAddress)}\` (closed)\n` +
      `*Range:* ±${dbPosition.range_percent}%\n\n` +
      `⏳ *Querying wallet balances...*`,
      { parse_mode: 'Markdown' }
    );

    // Query wallet token balances
    const mint0 = new PublicKey(dbPosition.token0_mint);
    const mint1 = new PublicKey(dbPosition.token1_mint);
    const mint0Program = await getMintTokenProgram(connection, mint0);
    const mint1Program = await getMintTokenProgram(connection, mint1);

    const ata0 = await getAssociatedTokenAddress(mint0, keypair.publicKey, false, mint0Program);
    const ata1 = await getAssociatedTokenAddress(mint1, keypair.publicKey, false, mint1Program);

    const [bal0Res, bal1Res] = await Promise.all([
      connection.getTokenAccountBalance(ata0).catch(() => null),
      connection.getTokenAccountBalance(ata1).catch(() => null)
    ]);

    // 📸 TRACKING: Capture wallet balances BEFORE re-opening position (position already closed)
    let snapshotBefore = null;
    try {
      snapshotBefore = await captureRebalanceSnapshot(connection, keypair.publicKey, dbPosition, null);
    } catch (trackError) {
      console.warn(`⚠️  Failed to capture before snapshot: ${trackError.message}`);
    }

    // Handle WSOL case: check native SOL balance if token is SOL
    const isToken0Sol = dbPosition.token0_mint === KNOWN_TOKENS.SOL.mint;
    const isToken1Sol = dbPosition.token1_mint === KNOWN_TOKENS.SOL.mint;
    
    let currentToken0Amount = parseFloat(bal0Res?.value?.uiAmount || '0');
    let currentToken1Amount = parseFloat(bal1Res?.value?.uiAmount || '0');
    
    // If token0 is SOL and token account balance is zero, check native SOL balance
    if (isToken0Sol && currentToken0Amount === 0) {
      const solBalance = await connection.getBalance(keypair.publicKey);
      const solUi = solBalance / LAMPORTS_PER_SOL;
      const minReserve = 0.05; // Keep minimum for fees
      currentToken0Amount = Math.max(0, solUi - minReserve);
    }
    
    // If token1 is SOL and token account balance is zero, check native SOL balance
    if (isToken1Sol && currentToken1Amount === 0) {
      const solBalance = await connection.getBalance(keypair.publicKey);
      const solUi = solBalance / LAMPORTS_PER_SOL;
      const minReserve = 0.05; // Keep minimum for fees
      currentToken1Amount = Math.max(0, solUi - minReserve);
    }

    // Check if we have at least some tokens to work with
    if (currentToken0Amount === 0 && currentToken1Amount === 0) {
      await bot.editMessageText(
        `❌ *Cannot Resume Rebalance*\n\n` +
        `No token balances found in wallet.\n\n` +
        `*Required tokens:*\n` +
        `• ${dbPosition.token0_symbol}\n` +
        `• ${dbPosition.token1_symbol}\n\n` +
        `Please manually create a new position with /addposition`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    const token0Decimals = bal0Res?.value?.decimals || 9;
    const token1Decimals = bal1Res?.value?.decimals || 6;

    // Get pool state for ratio calculation
    const poolPk = new PublicKey(dbPosition.pool_address);
    const coder = new BorshCoder(PANCAKESWAP_IDL);
    const poolAi = await connection.getAccountInfo(poolPk);
    if (!poolAi) {
      throw new Error('Pool account not found');
    }
    const poolState = coder.accounts.decode('PoolState', poolAi.data);

    // Calculate price range
    const currentPrice = Number(poolState.sqrt_price_x64) / (2 ** 64);
    const currentPriceActual = currentPrice * currentPrice;
    const lowerPrice = currentPriceActual * (1 - dbPosition.range_percent / 100);
    const upperPrice = currentPriceActual * (1 + dbPosition.range_percent / 100);
    const tickLower = Math.floor(Math.log(lowerPrice) / Math.log(1.0001));
    const tickUpper = Math.ceil(Math.log(upperPrice) / Math.log(1.0001));

    // Calculate optimal ratio
    const ratio = calculateTokenRatio(
      poolState.sqrt_price_x64,
      tickLower,
      tickUpper,
      poolState.tick_current
    );

    // Get token prices
    const token0Info = await getTokenInfo(dbPosition.token0_mint);
    const token1Info = await getTokenInfo(dbPosition.token1_mint);
    const token0Price = token0Info.price || currentPriceActual;
    const token1Price = token1Info.price || 1;

    let balancedToken0 = currentToken0Amount;
    let balancedToken1 = currentToken1Amount;

    // Calculate current ratio
    let token0UsdTotal = currentToken0Amount * (token0Info.price || token0Price);
    let token1UsdTotal = currentToken1Amount * (token1Info.price || token1Price);
    let totalUsd = token0UsdTotal + token1UsdTotal;
    let currentToken0Percent = totalUsd > 0 ? (token0UsdTotal / totalUsd) : 0.5;

    // Check if balancing is needed
    const ratioImbalance = Math.abs(currentToken0Percent - ratio.token0Percent);
    let swapPerformed = false;
    let swapDetails = null;
    let autoAddPerformed = false;
    let autoAddUsd = 0;
    let actualLeftover0Ui = 0;
    let actualLeftover1Ui = 0;
    let actualLeftoverUsd = 0;
    const txLinks = { balanceSwap: null, open: null, topUp: null, autoAdd: null };

    if (ratio.inRange && ratioImbalance > 0.05) {
      await bot.editMessageText(
        `🔄 *Resuming Rebalance...*\n\n` +
        `*Old Position:* \`${formatShortAddress(nftMintAddress)}\` (closed)\n` +
        `*Range:* ±${dbPosition.range_percent}%\n\n` +
        `✅ *Wallet balances loaded*\n` +
        `  • ${currentToken0Amount.toFixed(6)} ${dbPosition.token0_symbol}\n` +
        `  • ${currentToken1Amount.toFixed(6)} ${dbPosition.token1_symbol}\n\n` +
        `*Step 2/3:* Balancing tokens...\n` +
        `⚖️  Swapping to achieve optimal ratio...`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );

      // Perform swap (similar logic as in main handler)
      const needMoreToken0 = currentToken0Percent < ratio.token0Percent;

      if (needMoreToken0) {
        const token1UsdToSwap = (ratio.token0Percent - currentToken0Percent) * totalUsd;
        const token1AmountToSwap = token1UsdToSwap / token1Price;
        const maxSwap = currentToken1Amount * 0.5;
        const swapAmount = Math.min(token1AmountToSwap, maxSwap);

        // Expected price: token0 per token1 (output/input ratio)
        const expectedPrice = token1Price / token0Price;

        const swapResult = await swapWithFreshnessCheck({
          connection,
          wallet: keypair,
          inputMint: dbPosition.token1_mint,
          outputMint: dbPosition.token0_mint,
          amount: toRawAmount(swapAmount, token1Decimals),
          slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
          expectedPrice,
          inputDecimals: token1Decimals,
          outputDecimals: token0Decimals,
          waitForConfirmation: true
        });

        if (swapResult.success) {
          const outputAmount = Number(swapResult.quote.outputAmount) / (10 ** token0Decimals);
          balancedToken0 += outputAmount;
          balancedToken1 -= swapAmount;
          swapPerformed = true;
          swapDetails = {
            from: dbPosition.token1_symbol,
            to: dbPosition.token0_symbol,
            amountIn: swapAmount,
            amountOut: outputAmount
          };
          if (swapResult.signature) {
            txLinks.balanceSwap = `https://solscan.io/tx/${swapResult.signature}`;
          }
        }
      } else {
        const token0UsdToSwap = (currentToken0Percent - ratio.token0Percent) * totalUsd;
        const token0AmountToSwap = token0UsdToSwap / token0Price;
        const maxSwap = currentToken0Amount * 0.5;
        const swapAmount = Math.min(token0AmountToSwap, maxSwap);

        // Expected price: token1 per token0 (output/input ratio)
        const expectedPrice = token0Price / token1Price;

        const swapResult = await swapWithFreshnessCheck({
          connection,
          wallet: keypair,
          inputMint: dbPosition.token0_mint,
          outputMint: dbPosition.token1_mint,
          amount: toRawAmount(swapAmount, token0Decimals),
          slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
          expectedPrice,
          inputDecimals: token0Decimals,
          outputDecimals: token1Decimals,
          waitForConfirmation: true
        });

        if (swapResult.success) {
          const outputAmount = Number(swapResult.quote.outputAmount) / (10 ** token1Decimals);
          balancedToken1 += outputAmount;
          balancedToken0 -= swapAmount;
          swapPerformed = true;
          swapDetails = {
            from: dbPosition.token0_symbol,
            to: dbPosition.token1_symbol,
            amountIn: swapAmount,
            amountOut: outputAmount
          };
          if (swapResult.signature) {
            txLinks.balanceSwap = `https://solscan.io/tx/${swapResult.signature}`;
          }
        }
      }
    }

    // Verify balances before opening position (retry flow)
    await bot.editMessageText(
      `🔄 *Resuming Rebalance...*\n\n` +
      `*Old Position:* \`${formatShortAddress(nftMintAddress)}\` (closed)\n` +
      `*Range:* ±${dbPosition.range_percent}%\n\n` +
      `✅ *Wallet balances loaded*\n` +
      `${swapPerformed ? `✅ *Tokens balanced*\n` : ''}` +
      `*Step 3/3:* Verifying balances...\n\n` +
      `⏳ *Checking on-chain balances...*`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown'
      }
    );

    // Re-verify actual balances
    const mint0PkVerify = new PublicKey(dbPosition.token0_mint);
    const mint1PkVerify = new PublicKey(dbPosition.token1_mint);
    const mint0ProgVerify = await getMintTokenProgram(connection, mint0PkVerify);
    const mint1ProgVerify = await getMintTokenProgram(connection, mint1PkVerify);
    const ata0Verify = await getAssociatedTokenAddress(mint0PkVerify, keypair.publicKey, false, mint0ProgVerify);
    const ata1Verify = await getAssociatedTokenAddress(mint1PkVerify, keypair.publicKey, false, mint1ProgVerify);
    
    const verifyBal0Res = await connection.getTokenAccountBalance(ata0Verify).catch(() => null);
    const verifyBal1Res = await connection.getTokenAccountBalance(ata1Verify).catch(() => null);
    let verifiedToken0 = parseFloat(verifyBal0Res?.value?.uiAmount || '0');
    let verifiedToken1 = parseFloat(verifyBal1Res?.value?.uiAmount || '0');

    // Check native SOL for WSOL tokens
    if (isToken0Sol && verifiedToken0 === 0) {
      const solBal = await connection.getBalance(keypair.publicKey);
      verifiedToken0 = Math.max(0, (solBal / LAMPORTS_PER_SOL) - 0.05);
    }
    if (isToken1Sol && verifiedToken1 === 0) {
      const solBal = await connection.getBalance(keypair.publicKey);
      verifiedToken1 = Math.max(0, (solBal / LAMPORTS_PER_SOL) - 0.05);
    }

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`💰 Retry verified balances: ${verifiedToken0.toFixed(6)} ${dbPosition.token0_symbol}, ${verifiedToken1.toFixed(6)} ${dbPosition.token1_symbol}`);
    }

    const verifiedToken0Usd = verifiedToken0 * (token0Info.price || token0Price);
    const verifiedToken1Usd = verifiedToken1 * (token1Info.price || token1Price);
    const verifiedTotalUsd = verifiedToken0Usd + verifiedToken1Usd;

    if (verifiedTotalUsd < 2.0) {
      console.error(`❌ Insufficient balance in retry: ${formatCurrency(verifiedTotalUsd)}`);
      
      await bot.editMessageText(
        `❌ *Cannot Resume Rebalance*\n\n` +
        `*Old Position:* \`${formatShortAddress(nftMintAddress)}\` (closed)\n\n` +
        `❌ *Insufficient Balance*\n\n` +
        `*Current verified balances:*\n` +
        `• ${verifiedToken0.toFixed(6)} ${dbPosition.token0_symbol} (${formatCurrency(verifiedToken0Usd)})\n` +
        `• ${verifiedToken1.toFixed(6)} ${dbPosition.token1_symbol} (${formatCurrency(verifiedToken1Usd)})\n` +
        `• *Total:* ${formatCurrency(verifiedTotalUsd)}\n\n` +
        `*Minimum required:* $2.00\n\n` +
        `*What to do:*\n` +
        `• Check wallet transactions for swap results\n` +
        `• Top up wallet if needed\n` +
        `• Manually create position with /addposition`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 View Positions', callback_data: 'positions' }]
            ]
          }
        }
      );
      return;
    }

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`✅ Retry balance verification passed: ${formatCurrency(verifiedTotalUsd)}`);
    }

    // Update with verified amounts
    balancedToken0 = verifiedToken0;
    balancedToken1 = verifiedToken1;

    // Open new position
    await bot.editMessageText(
      `🔄 *Resuming Rebalance...*\n\n` +
      `*Old Position:* \`${formatShortAddress(nftMintAddress)}\` (closed)\n` +
      `*Range:* ±${dbPosition.range_percent}%\n\n` +
      `✅ *Wallet balances loaded*\n` +
      `${swapPerformed ? `✅ *Tokens balanced*\n` : ''}` +
      `✅ *Balances verified:* ${formatCurrency(verifiedTotalUsd)}\n\n` +
      `*Step 3/3:* Opening new position...\n\n` +
      `⏳ *Submitting transaction...*`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown'
      }
    );

    const tokenInfo = {
      token0Symbol: dbPosition.token0_symbol,
      token1Symbol: dbPosition.token1_symbol
    };

    const openResult = await openPosition(connection, keypair, poolPk, PANCAKESWAP_IDL, {
      rangePercent: dbPosition.range_percent,
      slippageBps: DEFAULT_OPEN_POSITION_SLIPPAGE_BPS,
      maxToken0ToUse: balancedToken0,
      maxToken1ToUse: balancedToken1,
      tokenInfo
    });

    if (!openResult.success) {
      // Check if this is auto-rebalance (suppress error messages for auto-rebalance)
      const isAutoRebalance = !!walletOverride;
      
      if (!isAutoRebalance) {
        // Only send error message for manual rebalance
      await bot.editMessageText(
        `❌ *Failed to Open New Position*\n\n` +
        `${openResult.error}\n\n` +
        `Your tokens are still in your wallet. Try again or manually create a position with /addposition.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '↻ Retry', callback_data: `rebalance_retry_${nftMintAddress}` }],
              [{ text: '📊 View Positions', callback_data: 'positions' }]
            ]
          }
        }
      );
      } else {
        // Auto-rebalance: Just log the error, don't notify user
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`⚠️  Auto-rebalance failed to open new position for ${nftMintAddress}: ${openResult.error}`);
        }
      }
      return;
    }

    txLinks.open = openResult.explorer;

    // 15.5. Transfer rewards to claim address if configured
    let rewardTransferResult = null;
    if (shouldTransferRewards && rewardsAll.length > 0) {
      if (!isAutoRebalance && processingMsg) {
        await bot.editMessageText(
          `🔄 *Rebalancing Position...*\n\n` +
          `*Old Position:* \`${formatShortAddress(nftMintAddress)}\`\n` +
          `*Range:* ±${dbPosition.range_percent}%\n\n` +
          `✅ *Step 1/4:* Position closed\n` +
          `✅ *Step 2/4:* Rewards kept separate\n` +
          `✅ *Step 3/4:* Tokens balanced\n` +
          `✅ *Step 4/4:* New position opened\n\n` +
          `*Step 5/5:* Transferring rewards to claim address...\n\n` +
          `⏳ *Sending ${rewardsAll.length} token(s) to ${formatShortAddress(claimAddress)}...*`,
          {
            chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      }

      try {
        rewardTransferResult = await transferToClaimAddress(
          connection,
          keypair,
          claimAddress,
          rewardsAll,
          removeResult.unwrappedSol || false
        );

        if (rewardTransferResult.transferred) {
          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`✅ Transferred ${rewardTransferResult.tokenCount} reward tokens to claim address`);
            console.log(`💰 Total transferred: ${formatCurrency(rewardTransferResult.totalUsd)}`);
            if (rewardTransferResult.solFeeReserved) {
              console.log(`💰 Kept ${rewardTransferResult.solFeeReserved} SOL in wallet for fees`);
            }
            if (rewardTransferResult.skipped?.length > 0) {
              console.log(`⏭️  Skipped ${rewardTransferResult.skipped.length} dust tokens (< $0.10)`);
            }
          }
          
          // Add transfer transaction link
          if (rewardTransferResult.signature) {
            txLinks.rewardTransfer = `https://solscan.io/tx/${rewardTransferResult.signature}`;
          }
        } else {
          console.warn(`⚠️  Reward transfer failed: ${rewardTransferResult.error || rewardTransferResult.reason}`);
        }
      } catch (transferError) {
        console.error(`❌ Reward transfer error:`, transferError);
        rewardTransferResult = {
          transferred: false,
          error: transferError.message
        };
      }
    }

    // Save new position to database (include auto-add amount if performed)
    const totalLiquidityUsd = (openResult.estimatedUsd || 0) + (autoAddPerformed ? autoAddUsd : 0);
    
    // Track manual vs auto rebalance (Phase 5: New Strategy - retry flow)
    const isAutoRebalanceRetry = !!walletOverride;
    const rebalanceType = isAutoRebalanceRetry ? 'auto' : 'manual';
    const isManualTightRange = !isAutoRebalanceRetry && dbPosition.range_percent < 1.0;
    
    const newDbPos = await upsertPosition({
      wallet_id: wallet.id,
      nft_mint: openResult.positionNftMint,
      pool_address: dbPosition.pool_address,
      token0_mint: dbPosition.token0_mint,
      token1_mint: dbPosition.token1_mint,
      token0_symbol: dbPosition.token0_symbol,
      token1_symbol: dbPosition.token1_symbol,
      fee_tier: dbPosition.fee_tier,
      lower_price: openResult.priceRange.lower,
      upper_price: openResult.priceRange.upper,
      current_price: openResult.priceRange.current,
      liquidity_value_usd: totalLiquidityUsd,
      range_percent: dbPosition.range_percent,
      auto_rebalance_enabled: dbPosition.auto_rebalance_enabled, // Preserve auto-rebalance setting
      claim_before_rebalance: dbPosition.claim_before_rebalance, // Preserve claim-before-rebalance setting
      last_rebalance_type: rebalanceType, // Track manual vs auto
      manual_range_locked: isManualTightRange, // Lock if user manually set <1%
      status: 'active'
    });

    // Carry over statistics from old position (retry flow)
    try {
      await carryOverStatistics(dbPosition.id, newDbPos.id);
    } catch (carryError) {
      console.error('❌ Failed to carry over statistics (retry):', carryError?.message || carryError);
    }

    // Record rebalance in statistics (retry flow)
    try {
      // Use estimated rebalance cost (0.1% of position value)
      const rebalanceCostUsd = totalLiquidityUsd * 0.001; // 0.1% = 0.001
      await recordRebalance(newDbPos.id, rebalanceCostUsd);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`📊 Recorded rebalance (retry): cost ${rebalanceCostUsd.toFixed(4)} USD for position ${newDbPos.id}`);
      }
    } catch (statsError) {
      console.warn('Failed to record rebalance in statistics (retry):', statsError?.message || statsError);
    }

    // Record rebalance transaction with range details (retry flow)
    try {
      await recordRebalanceTransaction(wallet.id, dbPosition.id, newDbPos.id, {
        costUsd: totalLiquidityUsd * 0.001,
        rangePercent: dbPosition.range_percent || 5,
        lowerPrice: openResult.priceRange.lower,
        upperPrice: openResult.priceRange.upper,
        currentPrice: openResult.priceRange.current,
        signature: openResult.signature || null,
        feeSol: 0
      });
    } catch (txError) {
      console.error(`❌ Failed to record rebalance transaction (retry):`, txError?.message || txError);
    }

    // 📸 TRACKING: Capture wallet + LP value AFTER ALL operations complete (retry flow)
    let snapshotAfter = null;
    let worthLossAnalysis = null;
    try {
      const newPersonalPositionPk = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), new PublicKey(openResult.positionNftMint).toBuffer()],
        PROGRAM_ID
      )[0];
      snapshotAfter = await captureRebalanceSnapshot(connection, keypair.publicKey, dbPosition, newPersonalPositionPk.toString());
      
      // Calculate and log worth loss
      if (snapshotBefore && snapshotAfter) {
        worthLossAnalysis = calculateWorthLoss(snapshotBefore, snapshotAfter);
        logWorthLossAnalysis(worthLossAnalysis, dbPosition);
        
        // Save P/L to database
        try {
          await recordRebalancePL(dbPosition.id, worthLossAnalysis.difference.total);
        } catch (dbError) {
          console.warn(`⚠️  Failed to save rebalance P/L to database: ${dbError.message}`);
        }
      }
    } catch (trackError) {
      console.warn(`⚠️  Failed to capture after snapshot (retry flow): ${trackError.message}`);
    }

    // Fetch cumulative P/L for display (retry flow)
    let cumulativePL = null;
    try {
      const { getPositionStatistics } = await import('../../services/position-statistics.service.js');
      const stats = await getPositionStatistics(dbPosition.id);
      if (stats) {
        cumulativePL = stats.cumulative_rebalance_pl_usd;
      }
    } catch (plError) {
      console.warn(`⚠️  Failed to fetch cumulative P/L: ${plError.message}`);
    }

    // Carry over alert settings
    try {
      const existingCfg = await getOutOfRangeConfig(dbPosition.id);
      if (existingCfg && newDbPos && newDbPos.id) {
        const lower = openResult.priceRange.lower;
        const upper = openResult.priceRange.upper;
        const width = upper - lower;
        const threshold = (typeof existingCfg.threshold_percentage === 'number' && isFinite(existingCfg.threshold_percentage))
          ? existingCfg.threshold_percentage
          : 10;
        const distance = width * (threshold / 100);
        const lowerAlert = lower + distance;
        const upperAlert = upper - distance;

        await ensureProximityRow(newDbPos.id);
        await upsertProximityAlert(newDbPos.id, threshold, lowerAlert, upperAlert);

        if (existingCfg.enabled === false) {
          await setProximityEnabled(newDbPos.id, false);
        }

        if (existingCfg.out_of_range_enabled === false) {
          await toggleOutOfRangeEnabled(newDbPos.id);
        }
      }
    } catch (carryError) {
      console.warn('Failed to carry over alert settings:', carryError?.message || carryError);
    }

    // Auto-unwrap WSOL to native SOL after successful retry
    if (isToken0Sol || isToken1Sol) {
      await unwrapWSol(connection, keypair, { commitmentLevel: COMMITMENT_LEVEL });
    }

    // Calculate ACTUAL wallet leftovers after retry completion
    try {
      // Wait for balances to settle
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // If token0 is SOL, check native SOL balance (after unwrap)
      if (isToken0Sol) {
        const solBalance = await connection.getBalance(keypair.publicKey);
        actualLeftover0Ui = solBalance / LAMPORTS_PER_SOL;
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Native SOL balance: ${actualLeftover0Ui.toFixed(6)} SOL`);
        }
      } else {
        const finalBal0Res = await connection.getTokenAccountBalance(ata0).catch(() => null);
        actualLeftover0Ui = parseFloat(finalBal0Res?.value?.uiAmount || '0');
      }
      
      // If token1 is SOL, check native SOL balance (after unwrap)
      if (isToken1Sol) {
        const solBalance = await connection.getBalance(keypair.publicKey);
        actualLeftover1Ui = solBalance / LAMPORTS_PER_SOL;
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Native SOL balance: ${actualLeftover1Ui.toFixed(6)} SOL`);
        }
      } else {
        const finalBal1Res = await connection.getTokenAccountBalance(ata1).catch(() => null);
        actualLeftover1Ui = parseFloat(finalBal1Res?.value?.uiAmount || '0');
      }
      
      // Calculate USD value of leftovers
      actualLeftoverUsd = (actualLeftover0Ui * (token0Info.price || token0Price)) + 
                          (actualLeftover1Ui * (token1Info.price || token1Price));
      
      console.log(`💰 Wallet leftovers: ${actualLeftover0Ui.toFixed(6)} ${dbPosition.token0_symbol} + ${actualLeftover1Ui.toFixed(6)} ${dbPosition.token1_symbol} = ${formatCurrency(actualLeftoverUsd)}`);
    } catch (leftoverError) {
      console.warn('Failed to calculate wallet leftovers:', leftoverError?.message || leftoverError);
    }

    // Automatically add leftover liquidity if significant (> $10)
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[AUTO-ADD RETRY] Checking leftover: ${formatCurrency(actualLeftoverUsd)} (threshold: $10)`);
    }
    
    if (actualLeftoverUsd > 10) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[AUTO-ADD RETRY] ✅ Leftover exceeds $10, using executeTopUp`);
      }
      try {
        // Update progress message (skip for auto-rebalance if processingMsg.text is unavailable)
        if (processingMsg?.message_id && processingMsg.text) {
          await bot.editMessageText(
            `${processingMsg.text}\n\n` +
            `💡 *Auto-adding leftover ${formatCurrency(actualLeftoverUsd)}...*`,
            {
              chat_id: chatId,
              message_id: processingMsg.message_id,
              parse_mode: 'Markdown'
            }
          );
        }
        
        const topUpResult = await executeTopUp({
          connection,
          keypair,
          positionMintAddress: openResult.positionNftMint,
          targetUsd: actualLeftoverUsd,
          positionData: dbPosition
        });
        
        if (topUpResult.success) {
          autoAddPerformed = true;
          autoAddUsd = topUpResult.totalUsd || 0;
          
          // Add to transaction links
          txLinks.autoAdd = topUpResult.explorer;
          if (topUpResult.swapResults && topUpResult.swapResults.length > 0) {
            topUpResult.swapResults.forEach(swap => {
              if (swap.signature && !txLinks.balanceSwap) {
                txLinks.balanceSwap = `https://solscan.io/tx/${swap.signature}`;
              }
            });
          }
          
          console.log(`✅ Auto-added liquidity: ${formatCurrency(autoAddUsd)}`);
          
          // Unwrap WSOL again after auto-add
          const isToken0Sol = dbPosition.token0_mint === KNOWN_TOKENS.SOL.mint;
          const isToken1Sol = dbPosition.token1_mint === KNOWN_TOKENS.SOL.mint;
          if (isToken0Sol || isToken1Sol) {
            await unwrapWSol(connection, keypair, { commitmentLevel: COMMITMENT_LEVEL });
          }
          
          // Recalculate final leftovers after auto-add
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const mint0 = new PublicKey(dbPosition.token0_mint);
          const mint1 = new PublicKey(dbPosition.token1_mint);
          const mint0Program = await getMintTokenProgram(connection, mint0);
          const mint1Program = await getMintTokenProgram(connection, mint1);
          const ata0 = await getAssociatedTokenAddress(mint0, keypair.publicKey, false, mint0Program);
          const ata1 = await getAssociatedTokenAddress(mint1, keypair.publicKey, false, mint1Program);
          
          if (isToken0Sol) {
            const solBalance = await connection.getBalance(keypair.publicKey);
            actualLeftover0Ui = solBalance / LAMPORTS_PER_SOL;
          } else {
            const finalBal0Res = await connection.getTokenAccountBalance(ata0).catch(() => null);
            actualLeftover0Ui = parseFloat(finalBal0Res?.value?.uiAmount || '0');
          }
          
          if (isToken1Sol) {
            const solBalance = await connection.getBalance(keypair.publicKey);
            actualLeftover1Ui = solBalance / LAMPORTS_PER_SOL;
          } else {
            const finalBal1Res = await connection.getTokenAccountBalance(ata1).catch(() => null);
            actualLeftover1Ui = parseFloat(finalBal1Res?.value?.uiAmount || '0');
          }
          
          const token0Info = await getTokenInfo(dbPosition.token0_mint);
          const token1Info = await getTokenInfo(dbPosition.token1_mint);
          const token0Price = token0Info.price || 0;
          const token1Price = token1Info.price || 1;
          
          actualLeftoverUsd = (actualLeftover0Ui * token0Price) + (actualLeftover1Ui * token1Price);
          
          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`[AUTO-ADD RETRY] Recalculated leftovers after auto-add: ${formatCurrency(actualLeftoverUsd)}`);
          }
        } else {
          console.warn('⚠️ Auto-add failed:', topUpResult.error);
        }
      } catch (autoAddError) {
        console.warn('⚠️ Auto-add error:', autoAddError?.message || autoAddError);
      }
    } else {
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[AUTO-ADD RETRY] ❌ Leftover ${formatCurrency(actualLeftoverUsd)} is below $10 threshold, skipping`);
      }
    }

    // Build transaction links
    const txLines = [];
    if (txLinks.balanceSwap) txLines.push(`• [Balance Swap](${txLinks.balanceSwap})`);
    if (txLinks.open) txLines.push(`• [Open New Position](${txLinks.open})`);
    if (txLinks.autoAdd) txLines.push(`• [Add Liquidity (Auto)](${txLinks.autoAdd})`);
    if (txLinks.rewardTransfer) txLines.push(`• [Reward Transfer](${txLinks.rewardTransfer})`);
    const transactionsSection = txLines.length ? `*Transactions:*\n${txLines.join('\n')}\n\n` : '';

    // Send success message
    const walletOwnerLine = wallet.label
      ? `*Wallet:* ${wallet.label}`
      : `*Wallet:* \`${formatShortAddress(wallet.wallet_address)}\``;

    let successMessage = `✅ *Rebalance Completed Successfully!*\n\n` +
      `${walletOwnerLine}\n\n` +
      `*Old Position:* \`${formatShortAddress(nftMintAddress)}\` (closed)\n` +
      `*New Position:* \`${formatShortAddress(openResult.positionNftMint)}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (swapPerformed && swapDetails) {
      successMessage += `*Token Balancing:*\n` +
        `• Swapped: ${swapDetails.amountIn.toFixed(6)} ${swapDetails.from}\n` +
        `• Received: ${swapDetails.amountOut.toFixed(6)} ${swapDetails.to}\n\n`;
    }

    const finalDepositedUsd = (openResult.estimatedUsd || 0) + (autoAddPerformed ? autoAddUsd : 0);
    
    successMessage += `*New Position:*\n` +
      `• Range: ±${dbPosition.range_percent}%\n` +
      `• Lower: ${openResult.priceRange.lower.toFixed(6)}\n` +
      `• Current: ${openResult.priceRange.current.toFixed(6)}\n` +
      `• Upper: ${openResult.priceRange.upper.toFixed(6)}\n` +
      `• Deposited: ${formatCurrency(finalDepositedUsd)}`;
    
    successMessage += '\n\n';
    
    // Add capital distribution section
    const totalCapital = finalDepositedUsd + actualLeftoverUsd;
    const utilizationPercent = totalCapital > 0 ? (finalDepositedUsd / totalCapital) * 100 : 100;
    
    successMessage += `*Capital Distribution:*\n` +
      `• In Position: ${formatCurrency(finalDepositedUsd)} (${utilizationPercent.toFixed(1)}%)\n`;
    
    if (actualLeftoverUsd > 0.01) {
      successMessage += `• In Wallet: ${formatCurrency(actualLeftoverUsd)} (${(100 - utilizationPercent).toFixed(1)}%)\n`;
    }

    // Add reward transfer information if rewards were transferred
    if (rewardTransferResult && rewardTransferResult.transferred) {
      successMessage += `*Rewards Transferred to Claim Address:*\n` +
        `• Tokens: ${rewardTransferResult.tokenCount}\n` +
        `• Total: ${formatCurrency(rewardTransferResult.totalUsd)}\n`
      
      if (rewardTransferResult.solFeeReserved) {
        successMessage += `• Fee Reserve: ${rewardTransferResult.solFeeReserved} SOL kept in wallet\n`;
      }
      
      if (rewardTransferResult.skipped?.length > 0) {
        successMessage += `• Dust Skipped: ${rewardTransferResult.skipped.length} token(s) < $0.10\n`;
      }
      
      successMessage += `\n`;
    } else if (shouldTransferRewards && rewardsAll.length > 0 && rewardTransferResult && !rewardTransferResult.transferred) {
      // Transfer was attempted but failed
      successMessage += `⚠️ *Reward Transfer Failed*\n` +
        `Rewards are still in your wallet.\n` +
        `You can manually claim them with /claim\n\n`;
    }

    // Add worth loss line
    if (worthLossAnalysis) {
      const lossIcon = worthLossAnalysis.isProfit ? '💰 Rebalance ' : '📉 Rebalance ';
      const lossText = worthLossAnalysis.isProfit ? 'Gain' : 'Loss';
      const sign = worthLossAnalysis.difference.total >= 0 ? '+' : '';
      successMessage += `${lossIcon} *${lossText}:* ${sign}${worthLossAnalysis.worthLossPercent.toFixed(4)}% (${sign}${formatCurrency(worthLossAnalysis.difference.total)})\n`;
      
      // Add cumulative P/L
      if (cumulativePL !== null) {
        const cumSign = cumulativePL >= 0 ? '+' : '';
        const cumIcon = cumulativePL >= 0 ? '💰' : '📉';
        successMessage += `${cumIcon} *Total Rebalances P/L:* ${cumSign}${formatCurrency(cumulativePL)}\n`;
      }
      
      successMessage += `\n`;
    }

    successMessage += `${transactionsSection}`;

    // Build inline keyboard with conditional "Add More" button
    const inlineKeyboard = [];
    
    // Only show "Add More" button if:
    // 1. We didn't auto-add, or auto-add failed
    // 2. AND there are still significant leftovers (> $10)
    if (!autoAddPerformed && actualLeftoverUsd > 10) {
      inlineKeyboard.push([
        { text: '📊 View Positions', callback_data: 'positions' }
      ]);
    } else {
      inlineKeyboard.push([
        { text: '📊 View Positions', callback_data: 'positions' }
      ]);
    }

    await bot.editMessageText(
      successMessage,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: inlineKeyboard
        }
      }
    );

    // Update reply keyboard
    try {
      await updatePoolsReplyKeyboard(bot, chatId, wallet.wallet_address);
    } catch (keyboardError) {
      console.warn('Failed to update reply keyboard:', keyboardError.message);
    }

    // Release rebalance lock on success
    unlockRebalance(wallet?.wallet_address);

  } catch (error) {
    console.error('Error in continueRebalanceFromWalletBalances:', error);
    
    // Check if this is auto-rebalance (suppress error messages for auto-rebalance)
    const isAutoRebalance = !!walletOverride;
    
    // Release rebalance lock on error
    const walletForUnlock = walletOverride || await getActiveWalletWithEncryption(telegramId);
    unlockRebalance(walletForUnlock?.wallet_address);
    
    if (!isAutoRebalance) {
      // Only send error message for manual rebalance
      const walletLabel = walletForUnlock?.label ? `*Wallet:* ${walletForUnlock.label}\n\n` : '';
    await bot.sendMessage(chatId,
      `❌ *Rebalance Failed*\n\n` +
      walletLabel +
      `${error?.message}`,
      { parse_mode: 'Markdown' }
    );
    } else {
      // Auto-rebalance: Just log the error, don't notify user
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`⚠️  Auto-rebalance failed in continueRebalanceFromWalletBalances: ${error?.message}`);
      }
    }
  }
}

/**
 * Check if user has pending rebalance range input
 * 
 * @param {number} telegramId - Telegram user ID
 * @returns {boolean} True if pending range input exists
 */
export function hasPendingRebalanceRange(telegramId) {
  return pendingRebalanceRange.has(telegramId);
}

/**
 * Clear pending rebalance range input for user
 * 
 * @param {number} telegramId - Telegram user ID
 */
export function clearPendingRebalanceRange(telegramId) {
  pendingRebalanceRange.delete(telegramId);
}

/**
 * Handles "New Range" callback from position buttons
 * 
 * Asks user to input a new range percentage for rebalancing
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleRebalanceNewRangeCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const nftMintAddress = data.replace('rebalance_newrange_', '');

  try {
    // Answer callback immediately
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Enter new range...' });

    // Check if position exists in DB
    const dbPosition = await getPositionByNft(nftMintAddress);
    if (!dbPosition) {
      await bot.sendMessage(chatId,
        `❌ *Position Not Found*\n\n` +
        `This position is not tracked in the database.\n\n` +
        `*Provided:* \`${formatShortAddress(nftMintAddress)}\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Get current range percent if available
    const currentRange = dbPosition.range_percent 
      ? ` (current: ±${dbPosition.range_percent}%)`
      : '';

    // Send prompt message
    const promptMsg = await bot.sendMessage(chatId,
      `🔧 *Rebalance with New Range*\n\n` +
      `*Position:* ${dbPosition.token0_symbol}-${dbPosition.token1_symbol}${currentRange}\n\n` +
      `Enter the new range percentage\n\n` +
      `*Valid range:* 0.1% to 50%\n\n` +
      `Type /cancel to abort.`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['/cancel']],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );

    // Store pending state
    pendingRebalanceRange.set(telegramId, {
      chatId,
      nftMintAddress,
      messageId: promptMsg.message_id
    });

  } catch (error) {
    console.error('Error in handleRebalanceNewRangeCallback:', error);
    await bot.sendMessage(chatId,
      `❌ *Error*\n\n${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handles range percentage input from user
 * 
 * Validates input, updates database, and triggers rebalance
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} msg - Telegram message object
 */
export async function handleRebalanceRangeMessage(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const text = msg.text.trim();

  const pending = pendingRebalanceRange.get(telegramId);
  if (!pending) {
    return;
  }

  try {
    // Parse range percentage
    const rangePercent = parseFloat(text);

    // Validate input
    if (isNaN(rangePercent) || rangePercent <= 0) {
      await bot.sendMessage(chatId,
        `❌ *Invalid Input*\n\n` +
        `Please enter a positive number.\n\n` +
        `*Example:* \`3\` for ±3%`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (rangePercent < 0.1 || rangePercent > 50) {
      await bot.sendMessage(chatId,
        `❌ *Range Out of Bounds*\n\n` +
        `Please enter a value between 0.1% and 50%.\n\n` +
        `*Your input:* ${rangePercent}%`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Clear pending state
    clearPendingRebalanceRange(telegramId);

    // Build reply markup to remove /cancel keyboard
    let replyMarkup = { remove_keyboard: true };
    try {
      const keyboard = await buildWalletKeyboard(telegramId);
      if (keyboard) replyMarkup = keyboard;
    } catch (_) {
      // keep remove_keyboard fallback
    }

    // Show confirmation and remove the /cancel keyboard
    await bot.sendMessage(chatId,
      `✅ *New Range Set*\n\n` +
      `Range: ±${rangePercent}%\n\n` +
      `Starting rebalance...`,
      { parse_mode: 'Markdown', reply_markup: replyMarkup }
    );

    // Update the position's range_percent in database
    const { db } = await import('../../db/index.js');
    const { positions } = await import('../../db/schema.js');
    const { eq } = await import('drizzle-orm');
    
    await db.update(positions)
      .set({
        range_percent: rangePercent,
        updated_at: new Date()
      })
      .where(eq(positions.nft_mint, pending.nftMintAddress));

    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`✅ Updated range_percent to ${rangePercent}% for position ${formatShortAddress(pending.nftMintAddress)}`);
    }

    // Call the main rebalance handler
    const simulatedMsg = {
      chat: { id: chatId },
      from: { id: telegramId }
    };

    await handleRebalance(bot, simulatedMsg, [pending.nftMintAddress]);

  } catch (error) {
    console.error('Error in handleRebalanceRangeMessage:', error);
    clearPendingRebalanceRange(telegramId);
    
    await bot.sendMessage(chatId,
      `❌ *Error*\n\n${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

