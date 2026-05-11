/**
 * Claim Rewards Handler
 * 
 * Handles the /claim command for claiming rewards and fees from PancakeSwap positions.
 * This handler orchestrates the claim flow with user confirmation and progress updates.
 * 
 * @module claim.handler
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { claimRewards, transferToClaimAddress } from '../../utils/claim.util.js';
import { compoundRewards } from '../../utils/compound.util.js';
import { getActiveWalletWithEncryption, getWalletClaimAddress } from '../../services/wallet.service.js';
import { getPositionByNft } from '../../services/position.service.js';
import { recordClaim, recordClaimFee } from '../../services/position-statistics.service.js';
import { recordClaimTransaction } from '../../services/transaction.service.js';
import { decryptPrivateKey } from '../../utils/encryption.util.js';
import { formatCurrency, formatTokenAmount, formatShortAddress } from '../../utils/format.util.js';
import { COMMITMENT_LEVEL, SPLIT_CLAIM_PERCENT, SPLIT_KEEP_PERCENT } from '../../config/constants.js';
import { updatePoolsReplyKeyboard } from '../keyboard.util.js';

/**
 * Format claimed tokens for display
 * 
 * @param {Array<Object>} claimed - Array of claimed token objects
 * @returns {string} Formatted token list
 * @private
 */
function formatClaimedTokens(claimed) {
  if (!claimed || claimed.length === 0) {
    return "• No rewards available";
  }

  return claimed.map(item => {
    const usdStr = item.usdValue != null ? ` (~${formatCurrency(item.usdValue)})` : "";
    return `• ${formatTokenAmount(item.uiAmount)} ${item.symbol}${usdStr}`;
  }).join('\n');
}

/**
 * Handles claim callback from inline keyboard buttons
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} callbackQuery - Callback query object from Telegram
 * 
 * @example
 * Callback data format: claim_<nft_mint_address>
 */
export async function handleClaimCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;
  const data = callbackQuery.data;

  // Extract NFT address from callback data
  // Format: claim_<nft_address>
  const nftAddress = data.replace('claim_', '');

  if (!nftAddress) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Invalid claim data',
      show_alert: true
    });
    return;
  }

  // Answer callback immediately
  await bot.answerCallbackQuery(callbackQuery.id, {
    text: '🔄 Processing claim...'
  });

  // Create a synthetic message object for handleClaim
  const syntheticMsg = {
    chat: { id: chatId },
    from: { id: telegramId }
  };

  // Call handleClaim with the NFT address as argument
  await handleClaim(bot, syntheticMsg, [nftAddress]);
}

/**
 * Handles the /claim command
 * 
 * Allows users to claim accumulated rewards and fees from their PancakeSwap positions.
 * Includes confirmation step and progress updates during transaction execution.
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} msg - Telegram message object
 * @param {Array<string>} args - Command arguments [position_nft_mint]
 * 
 * @example
 * User: /claim <nft_mint_address>
 * OR click "Claim" button from /rewards
 */
export async function handleClaim(bot, msg, args) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
    const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
    try {
        // 1. Validate position NFT mint argument
        if (args.length === 0) {
            await bot.sendMessage(chatId,
                `❌ *Missing Position Address*\n\n` +
                `Please provide your position NFT mint address.\n\n` +
                `*Usage:*\n` +
                `\`/claim <nft_mint_address>\`\n\n` +
                `*Find your position:*`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📊 View Positions', callback_data: 'positions' }],
                            [{ text: '💰 Check Rewards', callback_data: 'rewards' }]
                        ]
                    }
                }
            );
            return;
        }

        const positionMintStr = args[0];
        let positionMintPk;

        try {
            positionMintPk = new PublicKey(positionMintStr);
        } catch (error) {
            await bot.sendMessage(chatId,
                `❌ *Invalid Position Address*\n\n` +
                `The provided address is not valid.\n\n` +
                `*Example:*\n` +
                `\`/claim AbC123...XyZ789\``,
                { parse_mode: 'Markdown' }
            );
            return;
        }

    // 2. Get active wallet WITH encryption data (needed for decryption)
    const wallet = await getActiveWalletWithEncryption(telegramId);
    
    if (!wallet) {
            await bot.sendMessage(chatId,
                `❌ *No Wallet Configured*\n\n` +
                `You need to set up a wallet first.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🆕 Create New Wallet', callback_data: 'newwallet' }],
                            [{ text: '📥 Import Existing Wallet', callback_data: 'importwallet' }],
                            [{ text: '❓ Help', callback_data: 'help' }]
                        ]
                    }
                }
            );
            return;
        }

        // 3. Show processing message
        const processingMsg = await bot.sendMessage(chatId,
            `🔄 *Processing Claim Request...*\n\n` +
            `*Position:* \`${positionMintStr.slice(0, 8)}...${positionMintStr.slice(-8)}\`\n\n` +
            `⏳ Building transaction...\n\n` +
            `*This may take 10-30 seconds*`,
            { parse_mode: 'Markdown' }
        );

    // 4. Validate wallet has encryption data
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

    // 5. Check MASTER_PASSWORD is set
    if (!process.env.MASTER_PASSWORD) {
      await bot.sendMessage(chatId,
        `❌ *Configuration Error*\n\n` +
        `MASTER_PASSWORD is not configured.\n\n` +
        `Please contact the bot administrator.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 6. Decrypt private key and create keypair
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
    const connection = new Connection(SOLANA_RPC_URL, COMMITMENT_LEVEL);

    // 7. Get claim address and split strategy settings from wallet
    const claimAddress = await getWalletClaimAddress(wallet.id);
    const splitStrategy = wallet.split_strategy || false;
    const claimPercent = Math.round(SPLIT_CLAIM_PERCENT * 100);
    const keepPercent = Math.round(SPLIT_KEEP_PERCENT * 100);

    // 8. Regular claim flow (with or without split strategy)
    let statusMessage = `🔄 *Claiming Rewards...*\n\n` +
                       `*Position:* \`${positionMintStr.slice(0, 8)}...${positionMintStr.slice(-8)}\`\n`;
    
    if (claimAddress) {
      if (splitStrategy) {
        statusMessage += `*Split Strategy:* Enabled (${claimPercent}% sent / ${keepPercent}% kept)\n` +
                        `*Claim Address:* \`${formatShortAddress(claimAddress)}\`\n`;
      } else {
        statusMessage += `*Claim Address:* \`${formatShortAddress(claimAddress)}\`\n`;
      }
    }
    
    statusMessage += `\n⏳ Submitting transaction to Solana...\n\n` +
                     `*Please wait...*`;
    
    await bot.editMessageText(statusMessage, {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown'
    });

    const result = await claimRewards(
      connection, 
      keypair, 
      positionMintPk, 
      claimAddress,
      splitStrategy && claimAddress ? splitStrategy : false // Only split if claim address is set
    );

    // 10. Handle result
    if (!result.success) {
            await bot.editMessageText(
                `❌ *Claim Failed*\n\n` +
                `*Error:* ${result.error}\n\n` +
                `*Common Causes:*\n` +
                `• No rewards available to claim\n` +
                `• Insufficient SOL for transaction fees\n` +
                `• Position not found or inactive\n` +
                `• Network congestion`,
                {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💰 Check Rewards', callback_data: 'rewards' }],
                            [{ text: '📊 View Positions', callback_data: 'positions' }],
                            [{ text: '❓ Help', callback_data: 'help' }]
                        ]
                    }
                }
            );
      return;
    }

    // 11. Show success message
    const totalValueStr = result.totalUsd > 0 ? `~${formatCurrency(result.totalUsd)}` : "Unknown";

        // Build metadata summary
        let metadataStr = '';
        if (result.metadata) {
            const parts = [];
            if (result.metadata.feeTokensClaimed > 0) {
                parts.push(`${result.metadata.feeTokensClaimed} fee token(s)`);
            }
            if (result.metadata.rewardTokensClaimed > 0) {
                parts.push(`${result.metadata.rewardTokensClaimed} reward token(s)`);
            }
            if (parts.length > 0) {
                metadataStr = `\n*Claimed:* ${parts.join(' + ')}\n`;
            }
        }

        // Build transfer summary if claim address was used
        let transferStr = '';
        if (result.transfer) {
            if (result.transfer.transferred) {
                const transferValueStr = result.transfer.totalUsd > 0 ? formatCurrency(result.transfer.totalUsd) : "Unknown";
                
                if (result.transfer.splitStrategy) {
                    // Split strategy was used - partial transfer, rest kept in wallet
                    transferStr = `\n🎯 *Split Transfer (${claimPercent}% sent / ${keepPercent}% kept):*\n` +
                        `• ${result.transfer.tokenCount} token(s) (~${transferValueStr})\n` +
                        `• ${claimPercent}% → \`${formatShortAddress(result.transfer.claimAddress)}\`\n` +
                        `• ${keepPercent}% kept in wallet\n`;
                } else {
                    // Regular transfer to claim address
                    transferStr = `\n🎯 *Transferred to Claim Address:*\n` +
                        `• ${result.transfer.tokenCount} token(s) (~${transferValueStr})\n` +
                        `• To: \`${formatShortAddress(result.transfer.claimAddress)}\`\n`;
                }
                
                if (result.transfer.solFeeReserved > 0) {
                    transferStr += `• Kept ${result.transfer.solFeeReserved} SOL for transaction fees\n`;
                }
                if (result.transfer.skipped?.length > 0) {
                    transferStr += `• Skipped ${result.transfer.skipped.length} dust token(s) (< $0.10)\n`;
                }
                transferStr += `• [View Transfer](${result.transfer.explorer})\n`;
            } else if (result.transfer.reason === 'all_dust') {
                transferStr = `\n⏭️ *Claim Address Set:*\n` +
                    `All tokens were dust (< $0.10), kept in wallet\n`;
            } else if (result.transfer.error) {
                transferStr = `\n⚠️ *Transfer to claim address failed*\n` +
                    `Tokens remain in your wallet\n`;
            }
        }

        await bot.editMessageText(
            `✅ *Rewards Claimed Successfully!*\n\n` +
            `*Received:*\n` +
            `${formatClaimedTokens(result.claimed)}\n` +
            metadataStr +
            `\n*Total Value:* ${totalValueStr}\n` +
            transferStr +
            `\n*Claim Transaction:*\n` +
            `[View on Solscan](${result.explorer})`,
            {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💵 Check Balance', callback_data: 'balance' }],
                        [{ text: '📊 View Positions', callback_data: 'positions' }],
                        [{ text: '💰 Check Rewards', callback_data: 'rewards' }]
                    ]
                }
            }
        );
        
        // Record claim in statistics and transaction history (non-blocking)
        if (result.totalUsd > 0) {
            void getPositionByNft(positionMintStr).then(async dbPosition => {
                if (dbPosition && dbPosition.id) {
                    // 1. Record individual transaction for history/audit
                    try {
                        await recordClaimTransaction(wallet.id, dbPosition.id, result);
                        if (process.env.LOG_LEVEL === 'debug') {
                            console.log(`✅ Claim transaction recorded in history`);
                        }
                    } catch (txError) {
                        console.error(`❌ Failed to record claim transaction:`, txError?.message || txError);
                    }
                    
                    // 2. Update position statistics aggregates
                    await recordClaim(dbPosition.id, result.totalUsd);
                    
                    // 3. Record transaction fee
                    if (result.transactionFee > 0) {
                        await recordClaimFee(dbPosition.id, result.transactionFee);
                    }
                }
            }).catch(err => {
                console.warn(`Failed to record claim in statistics:`, err?.message || err);
            });
        }

        // Send the persistent reply keyboard with pool buttons
        try {
            await updatePoolsReplyKeyboard(bot, chatId, wallet.wallet_address);
        } catch (keyboardError) {
            console.warn('Failed to send reply keyboard:', keyboardError.message);
        }

  } catch (error) {
        await bot.sendMessage(chatId,
            `❌ *Unexpected Error*\n\n` +
            `An unexpected error occurred while claiming rewards.\n\n` +
            `*Error:* ${error.message}\n\n` +
            `Please try again or contact support if the issue persists.`,
            { parse_mode: 'Markdown' }
        );
    }
}
