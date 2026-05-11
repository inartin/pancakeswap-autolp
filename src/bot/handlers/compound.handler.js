/**
 * Compound Rewards Handler
 * 
 * Handles the /compound command for automatically compounding position rewards.
 * This handler orchestrates the compound flow with real-time progress updates
 * for each phase: claiming, swapping, balancing, and adding liquidity.
 * 
 * @module compound.handler
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { compoundRewards } from '../../utils/compound.util.js';
import { getActiveWalletWithEncryption, getWalletClaimAddress } from '../../services/wallet.service.js';
import { getPositionByNft } from '../../services/position.service.js';
import { recordCompound, recordCompoundFees } from '../../services/position-statistics.service.js';
import { decryptPrivateKey } from '../../utils/encryption.util.js';
import { formatCurrency, formatTokenAmount, formatShortAddress } from '../../utils/format.util.js';
import { COMMITMENT_LEVEL, MIN_USD_TO_COMPOUND, DEFAULT_SWAP_SLIPPAGE_BPS, DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS } from '../../config/constants.js';
import { updatePoolsReplyKeyboard } from '../keyboard.util.js';

/**
 * Format swap information for display
 * 
 * @param {Array<Object>} swaps - Array of swap objects
 * @returns {string} Formatted swap list
 * @private
 */
function formatSwaps(swaps) {
  if (!swaps || swaps.length === 0) {
    return "• No swaps performed";
  }

  return swaps.map((swap, i) => {
    const purpose = swap.purpose === 'balance' ? ' (balance)' : '';
    return `${i + 1}. ${formatTokenAmount(swap.inputAmount)} ${swap.inputToken} → ${formatTokenAmount(swap.outputAmount)} ${swap.outputToken}${purpose}`;
  }).join('\n');
}

/**
 * Format claimed tokens for display
 *
 * @param {Array<Object>} claimed - Array of claimed token objects
 * @returns {string} Formatted token list
 * @private
 */
function formatClaimedTokens(claimed) {
  if (!claimed || claimed.length === 0) {
    return "• None";
  }

  return claimed.map(item => {
    const usdStr = item.usdValue != null ? ` (${formatCurrency(item.usdValue)})` : "";
    return `• ${formatTokenAmount(item.uiAmount)} ${item.symbol}${usdStr}`;
  }).join('\n');
}

/**
 * Decode Solana error codes to user-friendly messages
 *
 * @param {string} errorMessage - Raw error message from transaction
 * @returns {string} User-friendly error message
 * @private
 */
function decodeErrorMessage(errorMessage) {
  if (!errorMessage) return "Unknown error";

  // Check for common error codes
  if (errorMessage.includes('0x1785')) {
    return "Price slippage check failed";
  }
  if (errorMessage.includes('0x1786')) {
    return "Insufficient liquidity";
  }
  if (errorMessage.includes('0x1787')) {
    return "Invalid tick range";
  }
  if (errorMessage.includes('Simulation failed')) {
    // Extract the first meaningful part before logs
    const match = errorMessage.match(/Simulation failed[^.]*\./);
    if (match) return match[0].replace(/\.$/, '');
    return "Transaction simulation failed";
  }

  // Return clean message without verbose logs
  const cleanMsg = errorMessage.split('Logs:')[0].trim();
  return cleanMsg || errorMessage;
}

/**
 * Handles compound callback from inline keyboard buttons
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} callbackQuery - Callback query object from Telegram
 * 
 * @example
 * Callback data format: compound_<nft_mint_address>
 */
export async function handleCompoundCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;
  const data = callbackQuery.data;

  // Extract NFT address from callback data
  // Format: compound_<nft_address>
  const nftAddress = data.replace('compound_', '');

  if (!nftAddress) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Invalid compound data',
      show_alert: true
    });
    return;
  }

  // Answer callback immediately
  await bot.answerCallbackQuery(callbackQuery.id, {
    text: '🔄 Starting compound...'
  });

  // Create a synthetic message object for handleCompound
  const syntheticMsg = {
    chat: { id: chatId },
    from: { id: telegramId }
  };

  // Call handleCompound with the NFT address as argument
  await handleCompound(bot, syntheticMsg, [nftAddress]);
}

/**
 * Handles the /compound command
 * 
 * Automatically compounds position rewards by claiming, swapping non-pool tokens,
 * balancing amounts, and adding liquidity back to the position.
 * Shows real-time progress updates for each phase.
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} msg - Telegram message object
 * @param {Array<string>} args - Command arguments [position_nft_mint, ...options]
 * 
 * @example
 * User: /compound <nft_mint_address>
 * User: /compound <nft_mint_address> nobalance
 * OR click "Compound" button from /rewards
 */
export async function handleCompound(bot, msg, args) {
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
        `\`/compound <nft_mint_address> [options]\`\n\n` +
        `*Options:*\n` +
        `• \`nobalance\` - Skip auto-balancing step\n\n` +
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
        `\`/compound AbC123...XyZ789\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Parse options
    const autoBalance = !args.includes('nobalance');

    // 2. Get active wallet WITH encryption data
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

    // 3. Get claim address to check if split mode is active (from active wallet)
    const claimAddressCheck = wallet.claim_address;
    const usingSplitModeCheck = claimAddressCheck !== null;
    
    // Show initial processing message
    const processingMsg = await bot.sendMessage(chatId,
      `🔄 *Compound in Progress...*\n\n` +
      `*Position:* \`${positionMintStr.slice(0, 8)}...${positionMintStr.slice(-8)}\`\n` +
      (usingSplitModeCheck ? `*Mode:* 🔀 Compound + Transfer Non-SOL\n` : '') +
      (usingSplitModeCheck ? `*Claim Address:* \`${formatShortAddress(claimAddressCheck)}\`\n` : '') +
      `\n⏳ Initializing...\n\n` +
      `*Please wait...*`,
      { parse_mode: 'Markdown' }
    );

    // 4. Validate wallet has encryption data
    if (!wallet.encrypted_private_key || !wallet.nonce || !wallet.salt) {
      await bot.editMessageText(
        `❌ *Wallet Data Incomplete*\n\n` +
        `The wallet encryption data is missing or incomplete.\n\n` +
        `This wallet may have been created with an older version.\n` +
        `Please re-import the wallet using \`/importwallet\``,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    // 5. Check MASTER_PASSWORD is set
    if (!process.env.MASTER_PASSWORD) {
      await bot.editMessageText(
        `❌ *Configuration Error*\n\n` +
        `MASTER_PASSWORD is not configured.\n\n` +
        `Please contact the bot administrator.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
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
      await bot.editMessageText(
        `❌ *Decryption Failed*\n\n` +
        `Could not decrypt wallet private key.\n\n` +
        `*Error:* ${decryptError.message}\n\n` +
        `This may indicate:\n` +
        `• Incorrect MASTER_PASSWORD\n` +
        `• Corrupted wallet data\n\n` +
        `Please contact support.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      return;
    }

    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = new Connection(SOLANA_RPC_URL, COMMITMENT_LEVEL);

    // 7. Get claim address if set for this wallet
    const claimAddress = await getWalletClaimAddress(wallet.id);
    const usingSplitMode = claimAddress !== null;
    
    // 8. Execute compound with progress updates
    const startTime = Date.now();
    
    // Progress callback to update Telegram message in real-time
    const updateProgress = async (event, data) => {
      let phaseText = '';
      let emoji = '⏳';
      const totalSteps = usingSplitMode ? 6 : 5;
      
      switch (event) {
        case 'claim_start':
          phaseText = `${emoji} Step 1/${totalSteps}: Claiming rewards...`;
          break;
        case 'claim_complete':
          phaseText = `${emoji} Step 2/${totalSteps}: Analyzing tokens...`;
          break;
        case 'analyze_start':
          phaseText = `${emoji} Step 2/${totalSteps}: Analyzing tokens...`;
          break;
        case 'analyze_complete':
          phaseText = `${emoji} Step 3/${totalSteps}: Swapping extras...`;
          break;
        case 'swap_start':
          phaseText = `${emoji} Step 3/${totalSteps}: Swapping extras...`;
          break;
        case 'swap_complete':
          phaseText = `${emoji} Step 4/${totalSteps}: Balancing amounts...`;
          break;
        case 'balance_start':
          phaseText = `${emoji} Step 4/${totalSteps}: Balancing amounts...`;
          break;
        case 'balance_complete':
          phaseText = `${emoji} Step 5/${totalSteps}: Adding liquidity...`;
          break;
        case 'addliquidity_start':
          phaseText = `${emoji} Step 5/${totalSteps}: Adding liquidity...`;
          break;
        case 'addliquidity_complete':
          if (usingSplitMode) {
            phaseText = `${emoji} Step 6/${totalSteps}: Transferring to claim address...`;
          } else {
            phaseText = `✅ Step 5/${totalSteps}: Complete!`;
          }
          break;
        case 'transfer_start':
          phaseText = `${emoji} Step 6/${totalSteps}: Transferring to claim address...`;
          break;
        case 'transfer_complete':
          phaseText = `✅ Step 6/${totalSteps}: Complete!`;
          break;
        default:
          return;
      }
      
      try {
        await bot.editMessageText(
          `🔄 *Compound in Progress...*\n\n` +
          `*Position:* \`${positionMintStr.slice(0, 8)}...${positionMintStr.slice(-8)}\`\n\n` +
          `${phaseText}\n\n` +
          `*Please wait...*`,
          {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown'
          }
        );
        
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // Ignore errors from too frequent updates
        if (!error.message.includes('message is not modified')) {
          console.error('Error updating progress:', error);
        }
      }
    };
    
    // Start compound process with progress callbacks
    const result = await compoundRewards(connection, keypair, positionMintPk, {
      slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS,
      swapSlippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
      autoBalance,
      minUsdToCompound: MIN_USD_TO_COMPOUND,
      claimAddress: claimAddress, // Pass claim address for 50/50 split mode
      onProgress: updateProgress
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // 8. Handle result
    if (!result.success) {
      // Decode error message to remove verbose logs
      const cleanError = decodeErrorMessage(result.error);

      // Determine error phase and phase-specific common causes
      let phaseMsg = '';
      let commonCauses = '';

      if (result.phase === 'claim') {
        phaseMsg = '*Failed at:* Step 1 - Claiming rewards';
        commonCauses =
          `• No rewards available to claim\n` +
          `• Insufficient SOL for transaction fees\n` +
          `• Network congestion`;
      } else if (result.phase === 'add_liquidity') {
        phaseMsg = '*Failed at:* Step 5 - Adding liquidity';
        commonCauses =
          `• Rapid price changes during deposit\n` +
          `• Position out of range\n` +
          `• Insufficient tokens for optimal ratio\n` +
          `• Network congestion`;
      } else {
        phaseMsg = '*Failed during:* Compound process';
        commonCauses =
          `• Token swap failed (low liquidity)\n` +
          `• Insufficient SOL for transaction fees\n` +
          `• Network congestion`;
      }

      await bot.editMessageText(
        `❌ *Compound Failed*\n\n` +
        `${phaseMsg}\n\n` +
        `*Error:* ${cleanError}\n\n` +
        `*Common Causes:*\n` +
        `${commonCauses}\n\n` +
        `*Duration:* ${duration}s`,
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

    // 9. Handle early exit (no rewards or below threshold)
    if (result.message) {
      await bot.editMessageText(
        `ℹ️ *Compound Skipped*\n\n` +
        `*Position:* \`${positionMintStr.slice(0, 8)}...${positionMintStr.slice(-8)}\`\n\n` +
        `*Reason:* ${result.message}\n\n` +
        `*Claimed Value:* ${formatCurrency(result.summary.totalUsdClaimed)}\n\n` +
        `Try again when rewards accumulate to at least $1.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Check Rewards', callback_data: 'rewards' }],
              [{ text: '📊 View Positions', callback_data: 'positions' }]
            ]
          }
        }
      );
      return;
    }

    // 10. Show detailed success message with all phases
    const summary = result.summary;
    const claimResult = result.claimResult;
    const swaps = result.swaps || [];
    const addLiqResult = result.addLiquidityResult;

    // Build step summary
    const phaseEmojis = [
      '✅ Step 1: Claimed rewards',
      '✅ Step 2: Analyzed tokens',
      swaps.length > 0 ? `✅ Step 3: Performed ${swaps.length} swap(s)` : '✅ Step 3: No swaps needed',
      autoBalance ? '✅ Step 4: Balanced amounts' : '⊘ Step 4: Skipped (disabled)',
      '✅ Step 5: Added liquidity',
      result.transfer?.transferred ? '✅ Step 6: Transferred to claim address' : 
        (result.splitMode ? '⊘ Step 6: Transfer skipped (dust)' : '')
    ].filter(s => s).join('\n');

    // Build detailed breakdown
    let breakdown = '';
    
    // Claimed tokens
    if (claimResult && claimResult.claimed) {
      breakdown += `*Claimed (${formatCurrency(summary.totalUsdClaimed)}):*\n`;
      breakdown += `${formatClaimedTokens(claimResult.claimed)}\n\n`;
    }

    // Swaps performed
    if (swaps.length > 0) {
      const swapPurposes = swaps.filter(s => s.purpose !== 'balance').length;
      const balanceSwaps = swaps.filter(s => s.purpose === 'balance').length;
      
      breakdown += `*Swaps Performed (${swaps.length} total):*\n`;
      if (swapPurposes > 0) breakdown += `• ${swapPurposes} extra token swap(s)\n`;
      if (balanceSwaps > 0) breakdown += `• ${balanceSwaps} balance swap(s)\n`;
      breakdown += `\n`;
    }

    // Liquidity added
    if (addLiqResult && addLiqResult.tokensDeposited) {
      breakdown += `*Deposited (${formatCurrency(summary.totalUsdCompounded)}):*\n`;
      addLiqResult.tokensDeposited.forEach(token => {
        const usdStr = token.usdValue ? ` (${formatCurrency(token.usdValue)})` : '';
        breakdown += `• ${token.uiAmount.toFixed(6)} ${token.symbol}${usdStr}\n`;
      });
      breakdown += `\n`;
    }

    // Transfer to claim address
    if (result.transfer?.transferred) {
      breakdown += `*Transferred (${formatCurrency(summary.totalUsdTransferred)}):*\n`;
      breakdown += `• To: \`${formatShortAddress(result.transfer.claimAddress)}\`\n`;
      breakdown += `• ${result.transfer.tokenCount} token(s) (non-SOL)\n`;
      if (result.transfer.solFeeReserved > 0) {
        breakdown += `• Kept ${result.transfer.solFeeReserved} SOL for fees\n`;
      }
      breakdown += `\n`;
    } else if (result.splitMode && result.transfer?.reason === 'all_dust') {
      breakdown += `*Transfer:* All non-SOL tokens were dust (< $0.10), kept in wallet\n\n`;
    }

    // Efficiency calculation
    // In split mode, target is: all SOL + 50% of non-SOL tokens
    // So target = totalClaimed - totalTransferred
    const targetAmount = result.splitMode 
      ? summary.totalUsdClaimed - summary.totalUsdTransferred
      : summary.totalUsdClaimed;
    const efficiency = targetAmount > 0 
      ? ((summary.totalUsdCompounded / targetAmount) * 100).toFixed(1)
      : 0;

    // Liquidity percentage calculation
    let liquidityDisplay = '+0%';
    if (addLiqResult?.metadata?.previousLiquidity && summary.liquidityAdded) {
      const previousLiq = BigInt(addLiqResult.metadata.previousLiquidity);
      const addedLiq = BigInt(summary.liquidityAdded);
      
      if (previousLiq > 0n) {
        const percentageIncrease = (Number(addedLiq) / Number(previousLiq)) * 100;
        liquidityDisplay = `+${percentageIncrease.toFixed(2)}%`;
      }
    }

    await bot.editMessageText(
      `✅ *Compound Successful!*\n\n` +
      `*Position:* \`${positionMintStr.slice(0, 8)}...${positionMintStr.slice(-8)}\`\n` +
      (result.splitMode ? `*Mode:* 🔀 Compound + Transfer Non-SOL\n` : '') +
      `\n${phaseEmojis}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `*Summary:*\n` +
      `💰 Claimed: ${formatCurrency(summary.totalUsdClaimed)}\n` +
      `📊 Compounded: ${formatCurrency(summary.totalUsdCompounded)}\n` +
      (result.splitMode ? `📤 Transferred: ${formatCurrency(summary.totalUsdTransferred)}\n` : '') +
      `⚡ Efficiency: ${efficiency}%\n` +
      `🔄 Swaps: ${swaps.length}\n` +
      `📈 Liquidity: ${liquidityDisplay}\n` +
      `⏱️ Duration: ${duration}s\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${breakdown}` +
      `*Transactions:*\n` +
      `• [Claim](${result.transactions.claim})\n` +
      (swaps.length > 0 ? swaps.map((s, i) => `• [Swap ${i + 1}](${s.explorer})`).join('\n') + '\n' : '') +
      `• [Add Liquidity](${result.transactions.addLiquidity})\n` +
      (result.transactions.transfer ? `• [Transfer](${result.transactions.transfer})\n` : ''),
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 View Position', callback_data: 'positions' }],
            [{ text: '💵 Check Balance', callback_data: 'balance' }],
            [{ text: '💰 Check Rewards', callback_data: 'rewards' }]
          ]
        }
      }
    );

    // Record compound statistics (non-blocking)
    if (summary.totalUsdCompounded > 0) {
      void getPositionByNft(positionMintStr).then(async dbPosition => {
        if (dbPosition && dbPosition.id) {
          await recordCompound(dbPosition.id, summary.totalUsdCompounded);
          // Record transaction fees
          if (result.fees?.totalSol > 0) {
            await recordCompoundFees(dbPosition.id, result.fees.totalSol);
          }
        }
      }).catch(err => {
        console.warn(`Failed to record compound in statistics:`, err?.message || err);
      });
    }

    // Send the persistent reply keyboard with pool buttons
    try {
      await updatePoolsReplyKeyboard(bot, chatId, wallet.wallet_address);
    } catch (keyboardError) {
      console.warn('Failed to send reply keyboard:', keyboardError.message);
    }

  } catch (error) {
    console.error('Compound handler error:', error);
    await bot.sendMessage(chatId,
      `❌ *Unexpected Error*\n\n` +
      `An unexpected error occurred during compound.\n\n` +
      `*Error:* ${error.message}\n\n` +
      `Please try again or contact support if the issue persists.`,
      { parse_mode: 'Markdown' }
    );
  }
}

