/**
 * Top Up Position Handler
 * 
 * Handles adding liquidity to existing positions by:
 * 1. Showing wallet balances and requesting USD amount
 * 2. Swapping tokens to match position's optimal ratio
 * 3. Adding liquidity to the position
 * 
 * This is similar to addposition but uses existing position's range
 * and similar to compound but uses wallet funds instead of claimed rewards.
 * 
 * @module topup.handler
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { BorshCoder } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { getActiveWalletWithEncryption } from '../../services/wallet.service.js';
import { decryptPrivateKey } from '../../utils/encryption.util.js';
import { formatCurrency, formatTokenAmount } from '../../utils/format.util.js';
import { getTokenInfo, getMintDecimals } from '../../utils/token.util.js';
import { swapTokensUltra } from '../../utils/jupiter-ultra.util.js';
import { addLiquidity } from '../../utils/add-liquidity.util.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { formatUserFriendlyError } from '../formatters/message.formatter.js';
import {
  PROGRAM_ID,
  PANCAKESWAP_IDL,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  KNOWN_TOKENS,
  DEFAULT_MIN_SOL_RESERVE,
  LAMPORTS_PER_SOL,
  COMMITMENT_LEVEL,
  getTokenSymbol,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS,
  DEFAULT_PRIORITY_FEE_LAMPORTS,
  FINALIZATION_DELAY_MS,
  SOL_RESERVE_BUFFER
} from '../../config/constants.js';

// In-memory store for pending top-up operations
// Key: telegram user ID, Value: { step, chatId, data }
const pendingTopUp = new Map();

/**
 * Fetch token info with retry mechanism
 * 
 * @param {string} mintAddress - Token mint address
 * @param {number} maxRetries - Maximum number of retry attempts (default: 1)
 * @param {number} retryDelayMs - Delay between retries in milliseconds (default: 1500)
 * @returns {Promise<Object>} Token info object
 */
async function getTokenInfoWithRetry(mintAddress, maxRetries = 1, retryDelayMs = 1500) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const tokenInfo = await getTokenInfo(mintAddress);
    
    // If we got a valid price, return immediately
    if (tokenInfo.price && tokenInfo.price > 0) {
      if (attempt > 0) {
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`[getTokenInfoWithRetry] Success on attempt ${attempt + 1} for ${mintAddress.slice(0, 8)}...`);
        }
      }
      return tokenInfo;
    }
    
    // If this was the last attempt, return what we have (even if null)
    if (attempt === maxRetries) {
      console.warn(`[getTokenInfoWithRetry] All ${maxRetries + 1} attempts failed for ${mintAddress.slice(0, 8)}... Source: ${tokenInfo.source}`);
      return tokenInfo;
    }
    
    // Wait before retrying (don't wait after last attempt)
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[getTokenInfoWithRetry] Attempt ${attempt + 1} failed, retrying in ${retryDelayMs}ms...`);
    }
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }
}

/**
 * Parse USD amount from user input
 * Supports: "$500", "500", "$1,000", "1000"
 * 
 * @param {string} input - User input string
 * @returns {number|null} Parsed USD amount or null if invalid
 */
function parseUsdAmount(input) {
  if (!input) return null;
  
  // Remove $ and commas
  const cleaned = input.replace(/[$,]/g, '').trim();
  const parsed = parseFloat(cleaned);
  
  if (isNaN(parsed) || parsed <= 0) return null;
  
  return parsed;
}

/**
 * Format token balance with USD value
 * 
 * @param {number} balance - Token balance (UI amount)
 * @param {string} symbol - Token symbol
 * @param {number} usdPrice - USD price per token
 * @returns {string} Formatted balance string
 */
function formatBalance(balance, symbol, usdPrice) {
  const usdValue = balance * usdPrice;
  return `${formatTokenAmount(balance)} ${symbol} (${formatCurrency(usdValue)})`;
}

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
 * Calculate optimal token ratio based on position range and current price
 * Same logic as compound.util.js
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
 * Retry a Jupiter swap with incremental slippage and priority fee
 * 
 * @param {Object} params - Swap parameters
 * @returns {Promise<Object>} Swap result
 */
async function retrySwapWithBackoff({ connection, wallet, inputMint, outputMint, amount, onAttempt }) {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (typeof onAttempt === 'function') {
        await onAttempt(attempt);
      }
    } catch (_) {}
    const slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS + (attempt - 1) * 50; // +0, +50, +100 bps
    const priorityFee = DEFAULT_PRIORITY_FEE_LAMPORTS * attempt; // bump priority
    try {
      const res = await swapTokensUltra({
        connection,
        wallet,
        inputMint,
        outputMint,
        amount,
        slippageBps,
        priorityFee,
        waitForConfirmation: true
      });
      if (res?.success) {
        return res;
      }
      lastError = res?.error || 'Swap failed';
    } catch (e) {
      lastError = e?.message || 'Swap exception';
    }
  }
  return { success: false, error: lastError || 'Swap failed after retries' };
}

/**
 * Handle top-up callback - starts the conversation flow
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleTopUpCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;
  const data = callbackQuery.data;
  
  // Extract NFT address from callback data: topup_<nft_address>
  const nftAddress = data.replace('topup_', '');
  
  if (!nftAddress) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Invalid position data',
      show_alert: true
    });
    return;
  }
  
  // Answer callback immediately
  await bot.answerCallbackQuery(callbackQuery.id, {
    text: '💰 Starting top-up...'
  });
  
  try {
    // Get active wallet
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
              [{ text: '📥 Import Existing Wallet', callback_data: 'importwallet' }]
            ]
          }
        }
      );
      return;
    }
    
    // Show loading message
    const loadingMsg = await bot.sendMessage(chatId,
      `🔄 *Fetching Position & Balance...*\n\n` +
      `*Position:* \`${nftAddress.slice(0, 8)}...${nftAddress.slice(-8)}\`\n\n` +
      `⏳ *Please wait...*`,
      { parse_mode: 'Markdown' }
    );
    
    // Connect to Solana
    const connection = new Connection(process.env.SOLANA_RPC_URL, COMMITMENT_LEVEL);
    const walletPk = new PublicKey(wallet.wallet_address);
    const positionMintPk = new PublicKey(nftAddress);
    
    // Fetch position and pool data
    const coder = new BorshCoder(PANCAKESWAP_IDL);
    const [personalPositionPk] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), positionMintPk.toBuffer()],
      PROGRAM_ID
    );
    
    const positionAi = await connection.getAccountInfo(personalPositionPk);
    if (!positionAi) {
      throw new Error('Position account not found');
    }
    
    const position = coder.accounts.decode("PersonalPositionState", positionAi.data);
    const poolPk = new PublicKey(position.pool_id);
    
    const poolAi = await connection.getAccountInfo(poolPk);
    if (!poolAi) {
      throw new Error('Pool account not found');
    }
    
    const pool = coder.accounts.decode("PoolState", poolAi.data);
    const mint0 = new PublicKey(pool.token_mint_0);
    const mint1 = new PublicKey(pool.token_mint_1);
    
    // Get token info (symbols and prices) with retry
    const [token0Info, token1Info] = await Promise.all([
      getTokenInfoWithRetry(mint0.toBase58(), 1, 1500),
      getTokenInfoWithRetry(mint1.toBase58(), 1, 1500)
    ]);
    
    const token0Symbol = token0Info.ticker && token0Info.ticker !== 'UNKNOWN' 
      ? token0Info.ticker 
      : getTokenSymbol(mint0.toBase58());
    const token1Symbol = token1Info.ticker && token1Info.ticker !== 'UNKNOWN'
      ? token1Info.ticker
      : getTokenSymbol(mint1.toBase58());
    
    // Validate token prices are available
    if (!token0Info.price || token0Info.price <= 0) {
      console.error(`[handleTopUpCallback] Failed to fetch ${token0Symbol} price. Source: ${token0Info.source}`);
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.sendMessage(chatId,
        `❌ *Price Data Unavailable*\n\n` +
        `Unable to fetch ${token0Symbol} price from market data APIs. This is required to calculate the optimal token ratio for adding liquidity.\n\n` +
        `*Please try again in a moment.*`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    if (!token1Info.price || token1Info.price <= 0) {
      console.error(`[handleTopUpCallback] Failed to fetch ${token1Symbol} price. Source: ${token1Info.source}`);
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.sendMessage(chatId,
        `❌ *Price Data Unavailable*\n\n` +
        `Unable to fetch ${token1Symbol} price from market data APIs. This is required to calculate the optimal token ratio for adding liquidity.\n\n` +
        `*Please try again in a moment.*`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[handleTopUpCallback] Token prices: ${token0Symbol}=$${token0Info.price.toFixed(4)}, ${token1Symbol}=$${token1Info.price.toFixed(4)}`);
    }
    
    // Get wallet balances
    const solBalance = await connection.getBalance(walletPk);
    const solBalanceUi = solBalance / LAMPORTS_PER_SOL;
    
    // Fetch SOL price (with fallback chain: Jupiter → Moralis → DexScreener)
    const solInfo = await getTokenInfo(KNOWN_TOKENS.SOL.mint);
    const solPrice = solInfo.price || 0;
    
    // Helper: read ATA balance with program detection
    const readBalanceWithProgramDetection = async (mintPk) => {
      try {
        // Try Token-2022 first
        let ata = await getAssociatedTokenAddress(mintPk, walletPk, false, TOKEN_2022_PROGRAM);
        let ataInfo = await connection.getAccountInfo(ata);
        if (ataInfo) {
          const bal = await connection.getTokenAccountBalance(ata);
          return bal?.value?.uiAmount || 0;
        }
        // Fallback to Token Program
        ata = await getAssociatedTokenAddress(mintPk, walletPk, false, TOKEN_PROGRAM);
        ataInfo = await connection.getAccountInfo(ata);
        if (ataInfo) {
          const bal = await connection.getTokenAccountBalance(ata);
          return bal?.value?.uiAmount || 0;
        }
      } catch (e) {
        console.warn(`Failed to read balance for ${mintPk.toBase58()}:`, e.message);
      }
      return 0;
    };
    
    const token0Balance = await readBalanceWithProgramDetection(mint0);
    const token1Balance = await readBalanceWithProgramDetection(mint1);
    
    // Check if either token is WSOL
    const wsolMint = KNOWN_TOKENS.SOL.mint;
    const isToken0Wsol = mint0.toBase58() === wsolMint;
    const isToken1Wsol = mint1.toBase58() === wsolMint;
    
    // Calculate total available USD (excluding SOL reserve)
    const availableSolUsd = Math.max(0, (solBalanceUi - DEFAULT_MIN_SOL_RESERVE) * solPrice);
    const token0UsdValue = token0Balance * token0Info.price;
    const token1UsdValue = token1Balance * token1Info.price;
    
    let totalAvailableUsd;
    if (isToken0Wsol && isToken1Wsol) {
      totalAvailableUsd = availableSolUsd;
    } else if (isToken0Wsol) {
      totalAvailableUsd = availableSolUsd + token1UsdValue;
    } else if (isToken1Wsol) {
      totalAvailableUsd = token0UsdValue + availableSolUsd;
    } else {
      totalAvailableUsd = availableSolUsd + token0UsdValue + token1UsdValue;
    }
    
    // Store pending operation
    pendingTopUp.set(telegramId, {
      step: 'usd',
      chatId,
      data: {
        nftAddress,
        positionMintPk: positionMintPk.toBase58(),
        poolPk: poolPk.toBase58(),
        mint0: mint0.toBase58(),
        mint1: mint1.toBase58(),
        token0Symbol,
        token1Symbol,
        token0Price: token0Info.price || 0,
        token1Price: token1Info.price || 1,
        solPrice,
        solBalance: solBalanceUi,
        token0Balance,
        token1Balance,
        isToken0Wsol,
        isToken1Wsol,
        tickLower: position.tick_lower_index,
        tickUpper: position.tick_upper_index,
        poolSqrtPrice: pool.sqrt_price_x64.toString(),
        poolTickCurrent: pool.tick_current
      }
    });
    
    // Delete loading message
    await bot.deleteMessage(chatId, loadingMsg.message_id);
    
    // Build balance display
    let balancesText = `*Your Balances:*\n`;
    balancesText += `• SOL: ${formatBalance(solBalanceUi, 'SOL', solPrice)}\n`;
    
    // Only show token0 balance if it's not WSOL
    if (!isToken0Wsol && token0Balance > 0) {
      balancesText += `• ${token0Symbol}: ${formatBalance(token0Balance, token0Symbol, token0Info.price)}\n`;
    }
    
    // Only show token1 balance if it's not WSOL
    if (!isToken1Wsol && token1Balance > 0) {
      balancesText += `• ${token1Symbol}: ${formatBalance(token1Balance, token1Symbol, token1Info.price)}\n`;
    }
    
    await bot.sendMessage(chatId,
      `💰 *Top Up Position*\n\n` +
      `*Pool:* ${token0Symbol}/${token1Symbol}\n` +
      `*Position:* \`${nftAddress.slice(0, 8)}...${nftAddress.slice(-8)}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${balancesText}\n` +
      `*Available (after ${DEFAULT_MIN_SOL_RESERVE} SOL reserve):* ${formatCurrency(totalAvailableUsd)}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💵 *How much USD do you want to add?*\n\n` +
      `*Example:* \`$500\` or \`500\`\n\n` +
      `Or /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Error in handleTopUpCallback:', error);
    await bot.sendMessage(chatId,
      `❌ *Error*\n\nFailed to load position data: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handle incoming messages for pending top-up operations
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} msg - Telegram message object
 */
export async function handleTopUpMessage(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const text = msg.text.trim();
  
  const pending = pendingTopUp.get(telegramId);
  if (!pending) return;
  
  try {
    if (pending.step === 'usd') {
      await handleUsdAmount(bot, msg, text, pending);
    }
  } catch (error) {
    console.error('Error in handleTopUpMessage:', error);
    await bot.sendMessage(chatId,
      `❌ *Error*\n\n${error.message}\n\nPlease try again or /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handle USD amount input and execute top-up
 */
async function handleUsdAmount(bot, msg, text, pending) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  // Parse USD amount
  const usdAmount = parseUsdAmount(text);
  
  if (!usdAmount) {
    await bot.sendMessage(chatId,
      `❌ *Invalid Amount*\n\n` +
      `Please provide a valid USD amount.\n\n` +
      `*Examples:*\n` +
      `• \`$500\`\n` +
      `• \`500\`\n` +
      `• \`1000\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  const data = pending.data;
  
  // Check if amount is available
  const solUsdValue = Math.max(0, (data.solBalance - DEFAULT_MIN_SOL_RESERVE) * data.solPrice);
  const token0UsdValue = data.token0Balance * data.token0Price;
  const token1UsdValue = data.token1Balance * data.token1Price;
  
  let totalAvailableUsd;
  if (data.isToken0Wsol && data.isToken1Wsol) {
    totalAvailableUsd = solUsdValue;
  } else if (data.isToken0Wsol) {
    totalAvailableUsd = solUsdValue + token1UsdValue;
  } else if (data.isToken1Wsol) {
    totalAvailableUsd = token0UsdValue + solUsdValue;
  } else {
    totalAvailableUsd = solUsdValue + token0UsdValue + token1UsdValue;
  }
  
  if (usdAmount > totalAvailableUsd) {
    await bot.sendMessage(chatId,
      `❌ *Insufficient Balance*\n\n` +
      `You requested: ${formatCurrency(usdAmount)}\n` +
      `Available: ${formatCurrency(totalAvailableUsd)}\n\n` +
      `Please enter a lower amount or /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Show processing message
  const processingMsg = await bot.sendMessage(chatId,
    `🔄 *Adding Liquidity...*\n\n` +
    `*Pool:* ${data.token0Symbol}/${data.token1Symbol}\n` +
    `*Amount:* ${formatCurrency(usdAmount)}\n\n` +
    `⏳ Step 1/3: Preparing tokens...\n\n` +
    `*Please wait...*`,
    { parse_mode: 'Markdown' }
  );
  
  try {
    // Get wallet and decrypt
    const wallet = await getActiveWalletWithEncryption(telegramId);
    
    if (!wallet.encrypted_private_key || !wallet.nonce || !wallet.salt) {
      throw new Error('Wallet encryption data is missing. Please re-import your wallet.');
    }
    
    if (!process.env.MASTER_PASSWORD) {
      throw new Error('MASTER_PASSWORD is not configured.');
    }
    
    let privateKey;
    try {
      privateKey = decryptPrivateKey(
        wallet.encrypted_private_key,
        wallet.nonce,
        wallet.salt,
        process.env.MASTER_PASSWORD
      );
    } catch (decryptError) {
      throw new Error(`Failed to decrypt wallet: ${decryptError.message}`);
    }
    
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = new Connection(process.env.SOLANA_RPC_URL, COMMITMENT_LEVEL);
    const positionMintPk = new PublicKey(data.positionMintPk);
    const poolPk = new PublicKey(data.poolPk);
    const mint0 = new PublicKey(data.mint0);
    const mint1 = new PublicKey(data.mint1);
    const wsolMint = KNOWN_TOKENS.SOL.mint;
    
    // Calculate optimal token ratio based on position range
    const ratio = calculateTokenRatio(
      BigInt(data.poolSqrtPrice),
      data.tickLower,
      data.tickUpper,
      data.poolTickCurrent
    );
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Position range: [${data.tickLower}, ${data.tickUpper}], Current tick: ${data.poolTickCurrent}`);
      console.log(`Optimal ratio: ${(ratio.token0Percent * 100).toFixed(1)}% token0, ${(ratio.token1Percent * 100).toFixed(1)}% token1`);
    }
    
    // Target: split USD according to optimal ratio
    const targetToken0Usd = usdAmount * ratio.token0Percent;
    const targetToken1Usd = usdAmount * ratio.token1Percent;
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Target: ${formatCurrency(targetToken0Usd)} token0, ${formatCurrency(targetToken1Usd)} token1`);
    }
    
    // Current balances in USD
    let currentToken0Usd = data.isToken0Wsol ? solUsdValue : token0UsdValue;
    let currentToken1Usd = data.isToken1Wsol ? solUsdValue : token1UsdValue;
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Current: ${formatCurrency(currentToken0Usd)} token0, ${formatCurrency(currentToken1Usd)} token1`);
    }
    
    const swapResults = [];
    
    // Swap tokens if needed to reach target ratio
    if (!data.isToken0Wsol && currentToken0Usd < targetToken0Usd) {
      // Need more token0 - swap from SOL
      const neededUsd = targetToken0Usd - currentToken0Usd;
      const maxSwapSol = data.isToken1Wsol 
        ? Math.max(0, (data.solBalance - DEFAULT_MIN_SOL_RESERVE - targetToken1Usd / data.solPrice))
        : (data.solBalance - DEFAULT_MIN_SOL_RESERVE);
      const swapAmountSol = Math.min(neededUsd / data.solPrice, maxSwapSol);
      
      if (swapAmountSol > 0.001) {
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Swapping ${swapAmountSol.toFixed(6)} SOL → ${data.token0Symbol}...`);
        }
        
        const swapResult = await retrySwapWithBackoff({
          connection,
          wallet: keypair,
          inputMint: wsolMint,
          outputMint: data.mint0,
          amount: BigInt(Math.floor(swapAmountSol * LAMPORTS_PER_SOL)),
          onAttempt: async (attempt) => {
            try {
              await bot.editMessageText(
                `🔄 *Adding Liquidity...*\n\n` +
                `*Pool:* ${data.token0Symbol}/${data.token1Symbol}\n` +
                `*Amount:* ${formatCurrency(usdAmount)}\n\n` +
                `⏳ Step 1/3: Preparing tokens...\n\n` +
                `🔁 Swapping SOL → ${data.token0Symbol} (attempt ${attempt}/3)\n\n` +
                `*Please wait...*`,
                { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
              );
            } catch (_) {}
          }
        });
        
        if (swapResult.success) {
          swapResults.push({ from: 'SOL', to: data.token0Symbol, amount: swapAmountSol });
          currentToken0Usd += swapAmountSol * data.solPrice * 0.98; // Account for slippage
        }
      }
    }
    
    if (!data.isToken1Wsol && currentToken1Usd < targetToken1Usd) {
      // Need more token1 - swap from SOL
      const neededUsd = targetToken1Usd - currentToken1Usd;
      const maxSwapSol = data.isToken0Wsol 
        ? Math.max(0, (data.solBalance - DEFAULT_MIN_SOL_RESERVE - targetToken0Usd / data.solPrice))
        : (data.solBalance - DEFAULT_MIN_SOL_RESERVE);
      const swapAmountSol = Math.min(neededUsd / data.solPrice, maxSwapSol);
      
      if (swapAmountSol > 0.001) {
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Swapping ${swapAmountSol.toFixed(6)} SOL → ${data.token1Symbol}...`);
        }
        
        const swapResult = await retrySwapWithBackoff({
          connection,
          wallet: keypair,
          inputMint: wsolMint,
          outputMint: data.mint1,
          amount: BigInt(Math.floor(swapAmountSol * LAMPORTS_PER_SOL)),
          onAttempt: async (attempt) => {
            try {
              await bot.editMessageText(
                `🔄 *Adding Liquidity...*\n\n` +
                `*Pool:* ${data.token0Symbol}/${data.token1Symbol}\n` +
                `*Amount:* ${formatCurrency(usdAmount)}\n\n` +
                `⏳ Step 1/3: Preparing tokens...\n\n` +
                `🔁 Swapping SOL → ${data.token1Symbol} (attempt ${attempt}/3)\n\n` +
                `*Please wait...*`,
                { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
              );
            } catch (_) {}
          }
        });
        
        if (swapResult.success) {
          swapResults.push({ from: 'SOL', to: data.token1Symbol, amount: swapAmountSol });
          currentToken1Usd += swapAmountSol * data.solPrice * 0.98; // Account for slippage
        }
      }
    }
    
    // Additional balancing: when one side is SOL and short, swap the other token → SOL
    // Case A: token0 is SOL and below target → swap token1 to SOL
    if (data.isToken0Wsol && currentToken0Usd < targetToken0Usd) {
      const neededUsd = targetToken0Usd - currentToken0Usd;
      const surplusToken1Usd = Math.max(0, currentToken1Usd - targetToken1Usd);
      const swapUsd = Math.min(neededUsd, surplusToken1Usd);

      if (swapUsd > 1) { // Only swap if meaningful amount (>$1)
        try {
          const token1Decimals = await getMintDecimals(connection, mint1) || 6;
          const swapAmountToken1 = swapUsd / data.token1Price;
          const amountRaw = BigInt(Math.floor(swapAmountToken1 * (10 ** token1Decimals)));

          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`Swapping ${swapAmountToken1.toFixed(6)} ${data.token1Symbol} → SOL...`);
          }

          const swapResult = await retrySwapWithBackoff({
            connection,
            wallet: keypair,
            inputMint: data.mint1,
            outputMint: wsolMint,
            amount: amountRaw,
            onAttempt: async (attempt) => {
              try {
                await bot.editMessageText(
                  `🔄 *Adding Liquidity...*\n\n` +
                  `*Pool:* ${data.token0Symbol}/${data.token1Symbol}\n` +
                  `*Amount:* ${formatCurrency(usdAmount)}\n\n` +
                  `⏳ Step 1/3: Preparing tokens...\n\n` +
                  `🔁 Swapping ${data.token1Symbol} → SOL (attempt ${attempt}/3)\n\n` +
                  `*Please wait...*`,
                  { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
                );
              } catch (_) {}
            }
          });

          if (swapResult.success) {
            swapResults.push({
              from: data.token1Symbol,
              to: 'SOL',
              amount: swapAmountToken1,
              signature: swapResult.signature
            });
            currentToken1Usd = Math.max(0, currentToken1Usd - swapUsd);
            currentToken0Usd += swapUsd * 0.98; // account for slippage/fees
            if (process.env.LOG_LEVEL === 'debug') {
              console.log(`✅ Swapped successfully. New balances: Token0 USD=$${currentToken0Usd.toFixed(2)}, Token1 USD=$${currentToken1Usd.toFixed(2)}`);
            }
          } else {
            console.warn(`Failed to swap ${data.token1Symbol} → SOL:`, swapResult.error || 'Unknown error');
          }
        } catch (swapError) {
          console.warn(`Failed to swap ${data.token1Symbol} → SOL:`, swapError.message);
        }
      }
    }

    // Case B: token1 is SOL and below target → swap token0 to SOL
    if (data.isToken1Wsol && currentToken1Usd < targetToken1Usd) {
      const neededUsd = targetToken1Usd - currentToken1Usd;
      const surplusToken0Usd = Math.max(0, currentToken0Usd - targetToken0Usd);
      const swapUsd = Math.min(neededUsd, surplusToken0Usd);

      if (swapUsd > 1) { // Only swap if meaningful amount (>$1)
        try {
          const token0Decimals = await getMintDecimals(connection, mint0) || 6;
          const swapAmountToken0 = swapUsd / data.token0Price;
          const amountRaw = BigInt(Math.floor(swapAmountToken0 * (10 ** token0Decimals)));

          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`Swapping ${swapAmountToken0.toFixed(6)} ${data.token0Symbol} → SOL...`);
          }

          const swapResult = await retrySwapWithBackoff({
            connection,
            wallet: keypair,
            inputMint: data.mint0,
            outputMint: wsolMint,
            amount: amountRaw,
            onAttempt: async (attempt) => {
              try {
                await bot.editMessageText(
                  `🔄 *Adding Liquidity...*\n\n` +
                  `*Pool:* ${data.token0Symbol}/${data.token1Symbol}\n` +
                  `*Amount:* ${formatCurrency(usdAmount)}\n\n` +
                  `⏳ Step 1/3: Preparing tokens...\n\n` +
                  `🔁 Swapping ${data.token0Symbol} → SOL (attempt ${attempt}/3)\n\n` +
                  `*Please wait...*`,
                  { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
                );
              } catch (_) {}
            }
          });

          if (swapResult.success) {
            swapResults.push({
              from: data.token0Symbol,
              to: 'SOL',
              amount: swapAmountToken0,
              signature: swapResult.signature
            });
            currentToken0Usd = Math.max(0, currentToken0Usd - swapUsd);
            currentToken1Usd += swapUsd * 0.98; // account for slippage/fees
            if (process.env.LOG_LEVEL === 'debug') {
              console.log(`✅ Swapped successfully. New balances: Token0 USD=$${currentToken0Usd.toFixed(2)}, Token1 USD=$${currentToken1Usd.toFixed(2)}`);
            }
          } else {
            console.warn(`Failed to swap ${data.token0Symbol} → SOL:`, swapResult.error || 'Unknown error');
          }
        } catch (swapError) {
          console.warn(`Failed to swap ${data.token0Symbol} → SOL:`, swapError.message);
        }
      }
    }
    
    // Wait for finalization
    await new Promise((r) => setTimeout(r, FINALIZATION_DELAY_MS));
    
    // Check SOL reserve and top up if needed
    await bot.editMessageText(
      `🔄 *Adding Liquidity...*\n\n` +
      `*Pool:* ${data.token0Symbol}/${data.token1Symbol}\n` +
      `*Amount:* ${formatCurrency(usdAmount)}\n\n` +
      `⏳ Step 2/3: Checking SOL reserve...\n\n` +
      `*Please wait...*`,
      { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
    );
    
    const currentSolBalance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
    const neededSol = DEFAULT_MIN_SOL_RESERVE - currentSolBalance;
    
    if (neededSol > 0.001) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`⚠️ SOL balance (${currentSolBalance.toFixed(6)}) below reserve. Need ${neededSol.toFixed(6)} SOL`);
      }
      
      // Try to swap token1 → SOL for fees
      if (!data.isToken1Wsol) {
        const swapAmountUsd = (neededSol + 0.01) * data.solPrice;
        const token1Decimals = await getMintDecimals(connection, mint1) || 6;
        const swapAmountToken1 = swapAmountUsd / data.token1Price;
        const amountRaw = BigInt(Math.floor(swapAmountToken1 * (10 ** token1Decimals)));
        
        const topUpResult = await retrySwapWithBackoff({
          connection,
          wallet: keypair,
          inputMint: data.mint1,
          outputMint: wsolMint,
          amount: amountRaw,
          onAttempt: async (attempt) => {
            try {
              await bot.editMessageText(
                `🔄 *Adding Liquidity...*\n\n` +
                `*Pool:* ${data.token0Symbol}/${data.token1Symbol}\n` +
                `*Amount:* ${formatCurrency(usdAmount)}\n\n` +
                `⏳ Step 2/3: Topping up SOL for fees...\n\n` +
                `🔁 Swapping ${data.token1Symbol} → SOL (attempt ${attempt}/3)\n\n` +
                `*Please wait...*`,
                { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
              );
            } catch (_) {}
          }
        });
        
        if (topUpResult.success) {
          await new Promise((r) => setTimeout(r, FINALIZATION_DELAY_MS));
        }
      }
    }
    
    // Final check
    const finalSolBalance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
    if (finalSolBalance < (DEFAULT_MIN_SOL_RESERVE - SOL_RESERVE_BUFFER)) {
      pendingTopUp.delete(telegramId);
      await bot.editMessageText(
        `❌ *Insufficient SOL for Transaction Fees*\n\n` +
        `Your wallet has *${finalSolBalance.toFixed(6)} SOL*, but needs at least *${DEFAULT_MIN_SOL_RESERVE} SOL*.\n\n` +
        `Please top up your wallet with SOL first.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      return;
    }
    
    // Fetch initial liquidity for percentage calculation
    let initialLiquidity = 0n;
    try {
      const positionAi = await connection.getAccountInfo(new PublicKey(data.positionMintPk));
      if (positionAi) {
        const coder = new BorshCoder(PANCAKESWAP_IDL);
        const [personalPositionPk] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), new PublicKey(data.positionMintPk).toBuffer()],
          PROGRAM_ID
        );
        const posAi = await connection.getAccountInfo(personalPositionPk);
        if (posAi) {
          const pos = coder.accounts.decode("PersonalPositionState", posAi.data);
          initialLiquidity = pos.liquidity;
        }
      }
    } catch (e) {
      console.warn('Could not fetch initial liquidity:', e.message);
    }
    
    // Add liquidity
    await bot.editMessageText(
      `🔄 *Adding Liquidity...*\n\n` +
      `*Pool:* ${data.token0Symbol}/${data.token1Symbol}\n` +
      `*Amount:* ${formatCurrency(usdAmount)}\n\n` +
      `⏳ Step 3/3: Adding liquidity to position...\n\n` +
      `*Please wait...*`,
      { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
    );
    
    // Fetch fresh pool state
    const coder = new BorshCoder(PANCAKESWAP_IDL);
    const freshPoolAi = await connection.getAccountInfo(poolPk);
    if (!freshPoolAi) throw new Error("Pool account not found");
    const freshPool = coder.accounts.decode("PoolState", freshPoolAi.data);
    
    // Recalculate ratio with fresh price
    const freshRatio = calculateTokenRatio(
      freshPool.sqrt_price_x64,
      data.tickLower,
      data.tickUpper,
      freshPool.tick_current
    );
    
    // Determine limiting token
    const token0UsdCurrent = currentToken0Usd;
    const token1UsdCurrent = currentToken1Usd;
    const totalUsdCurrent = token0UsdCurrent + token1UsdCurrent;
    const currentToken0Percent = token0UsdCurrent / totalUsdCurrent;
    
    const token0Limiting = currentToken0Percent < freshRatio.token0Percent;
    const baseFlag = token0Limiting;
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Limiting token: ${token0Limiting ? 'Token 0' : 'Token 1'}`);
    }
    
    // Helper: read ATA balance with program detection
    const readBalanceForMint = async (mintPk) => {
      try {
        // Try Token-2022 first
        let ata = await getAssociatedTokenAddress(mintPk, keypair.publicKey, false, TOKEN_2022_PROGRAM);
        let ataInfo = await connection.getAccountInfo(ata);
        if (ataInfo) {
          const bal = await connection.getTokenAccountBalance(ata);
          return bal?.value?.uiAmount || 0;
        }
        // Fallback to Token Program
        ata = await getAssociatedTokenAddress(mintPk, keypair.publicKey, false, TOKEN_PROGRAM);
        ataInfo = await connection.getAccountInfo(ata);
        if (ataInfo) {
          const bal = await connection.getTokenAccountBalance(ata);
          return bal?.value?.uiAmount || 0;
        }
      } catch (e) {
        console.warn(`Failed to read balance for ${mintPk.toBase58()}:`, e.message);
      }
      return 0;
    };
    
    // Refetch fresh balances after swaps
    if (process.env.LOG_LEVEL === 'debug') {
      console.log('Fetching fresh balances after swaps...');
    }
    const freshSolBalance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
    
    // For WSOL tokens, use native SOL balance (not wrapped balance)
    // For other tokens, fetch from token accounts
    const freshToken0Balance = data.isToken0Wsol 
      ? freshSolBalance 
      : await readBalanceForMint(mint0);
    const freshToken1Balance = data.isToken1Wsol 
      ? freshSolBalance 
      : await readBalanceForMint(mint1);
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Fresh balances: SOL=${freshSolBalance.toFixed(6)}, Token0=${freshToken0Balance.toFixed(6)}, Token1=${freshToken1Balance.toFixed(6)}`);
    }
    
    // Calculate max amounts to use with fresh balances
    // Account for slippage that will be applied by addLiquidity (dividing prevents exceeding balance after slippage is applied)
    const slippageMultiplier = 1 + (DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS / 10000); // 1.01 for 1% slippage
    const token0ToUse = data.isToken0Wsol 
      ? Math.max(0, (freshSolBalance - DEFAULT_MIN_SOL_RESERVE) / slippageMultiplier) 
      : freshToken0Balance;
    const token1ToUse = data.isToken1Wsol 
      ? Math.max(0, (freshSolBalance - DEFAULT_MIN_SOL_RESERVE) / slippageMultiplier) 
      : freshToken1Balance;
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Token amounts to use: Token0=${token0ToUse.toFixed(6)}, Token1=${token1ToUse.toFixed(6)}`);
    }
    
    // Validate we have tokens to add
    // For in-range positions, BOTH tokens are required
    // For out-of-range positions, only one token is needed
    const needsBothTokens = freshRatio.inRange;
    const hasInsufficientTokens = needsBothTokens 
      ? (token0ToUse <= 0 || token1ToUse <= 0)
      : (token0ToUse <= 0 && token1ToUse <= 0);
    
    if (hasInsufficientTokens) {
      pendingTopUp.delete(telegramId);
      
      let errorMessage = `❌ *Insufficient Balance for Top-Up*\n\n`;
      
      if (needsBothTokens) {
        // In-range position needs both tokens
        errorMessage += `Position is IN RANGE and requires BOTH tokens to add liquidity.\n\n`;
        
        if (token0ToUse <= 0) {
          errorMessage += `*Missing:* ${data.token0Symbol}\n`;
          if (data.isToken0Wsol) {
            const minRequired = DEFAULT_MIN_SOL_RESERVE + 0.02; // Reserve + small amount for liquidity
            errorMessage += `*Current SOL:* ${freshSolBalance.toFixed(6)} SOL\n` +
                          `*Required:* At least ${minRequired.toFixed(3)} SOL\n\n` +
                          `*What to do:*\n` +
                          `• Top up wallet with more SOL (need ~${Math.max(0, minRequired - freshSolBalance + 0.01).toFixed(3)} more)\n` +
                          `• Or try a smaller USD amount`;
          }
        } else if (token1ToUse <= 0) {
          errorMessage += `*Missing:* ${data.token1Symbol}\n\n` +
                        `*What to do:*\n` +
                        `• Top up wallet with ${data.token1Symbol}\n` +
                        `• Or try a smaller USD amount`;
        }
      } else {
        // Out of range - no tokens available at all
        errorMessage += `After swaps and fees, there's not enough balance to add liquidity.\n\n` +
                       `*What to do:*\n` +
                       `• Top up wallet with more tokens\n` +
                       `• Or try a smaller USD amount`;
      }
      
      await bot.editMessageText(errorMessage, {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 View Positions', callback_data: 'positions' }],
            [{ text: '💵 Check Balance', callback_data: 'balance' }]
          ]
        }
      });
      return;
    }
    
    // Add liquidity
    const addOptions = baseFlag
      ? { amount0: token0ToUse, slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS, baseFlag }
      : { amount1: token1ToUse, slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS, baseFlag };
    
    let addLiqResult = await addLiquidity(connection, keypair, positionMintPk, addOptions);
    
    // Retry on slippage error
    if (!addLiqResult.success && addLiqResult.error?.includes('PriceSlippageCheck')) {
      if (process.env.LOG_LEVEL === 'debug') {
        console.log('Retrying with increased slippage...');
      }
      const retryOptions = baseFlag
        ? { amount0: token0ToUse, slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS + 100, baseFlag }
        : { amount1: token1ToUse, slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS + 100, baseFlag };
      
      addLiqResult = await addLiquidity(connection, keypair, positionMintPk, retryOptions);
    }
    
    // Clear pending
    pendingTopUp.delete(telegramId);
    
    if (!addLiqResult.success) {
      const errorMsg = formatUserFriendlyError(addLiqResult.error || 'Unknown error');
      await bot.editMessageText(
        `❌ *Failed to Add Liquidity*\n\n` +
        `${errorMsg}\n\n` +
        `Please try again.`,
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
    
    // Calculate percentage increase
    let percentageIncrease = 0;
    let liquidityIncreaseText = '';
    if (initialLiquidity > 0n && addLiqResult.liquidityAdded) {
      try {
        // Safely convert both values to BigInt to handle both Number and BigInt types
        const initialLiqBigInt = typeof initialLiquidity === 'bigint' 
          ? initialLiquidity 
          : BigInt(Math.floor(Number(initialLiquidity)));
        const addedLiq = typeof addLiqResult.liquidityAdded === 'bigint'
          ? addLiqResult.liquidityAdded
          : BigInt(Math.floor(Number(addLiqResult.liquidityAdded)));
        
        const finalLiquidity = initialLiqBigInt + addedLiq;
        const increasePercent = Number((addedLiq * 10000n) / initialLiqBigInt) / 100;
        percentageIncrease = increasePercent;
        liquidityIncreaseText = `*Liquidity Increase:* +${increasePercent.toFixed(2)}%\n`;
      } catch (e) {
        console.warn('Could not calculate percentage:', e.message);
      }
    }
    
    // Build swap transactions note with amounts
    let swapsSummaryText = '';
    if (swapResults.length > 0) {
      swapsSummaryText = `*Swaps Executed:*\n`;
      for (const swap of swapResults) {
        swapsSummaryText += `• ${formatTokenAmount(swap.amount)} ${swap.from} → ${swap.to}\n`;
      }
      swapsSummaryText += `\n`;
    }
    
    // Format deposited tokens
    const depositedTokens = addLiqResult.tokensDeposited || [];
    let tokensDepositedText = '';
    if (depositedTokens.length > 0) {
      tokensDepositedText = `*Tokens Deposited:*\n`;
      for (const token of depositedTokens) {
        tokensDepositedText += `• ${formatTokenAmount(token.uiAmount)} ${token.symbol}\n`;
      }
      tokensDepositedText += `\n`;
    }
    
    // Build transaction links section
    let transactionsText = `*Transactions:*\n`;
    transactionsText += `🔗 [Add Liquidity](${addLiqResult.explorer})\n`;
    if (swapResults.length > 0) {
      swapResults.forEach((swap, index) => {
        if (swap.signature) {
          const swapLabel = swapResults.length > 1 ? `Swap ${index + 1}` : 'Swap';
          transactionsText += `🔗 [${swapLabel}: ${swap.from}→${swap.to}](https://solscan.io/tx/${swap.signature})\n`;
        }
      });
    }
    
    // Success!
    await bot.editMessageText(
      `✅ *Position Topped Up Successfully!*\n\n` +
      `💧 *Pool:* ${data.token0Symbol}/${data.token1Symbol}\n` +
      `*Position:* \`${data.nftAddress.slice(0, 8)}...${data.nftAddress.slice(-8)}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${liquidityIncreaseText}` +
      `*Value Added:* ${formatCurrency(addLiqResult.totalUsd)}\n\n` +
      `${tokensDepositedText}` +
      `${swapsSummaryText}` +
      `${transactionsText}`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 View Positions', callback_data: 'positions' }],
            [{ text: '💰 Top Up Again', callback_data: `topup_${data.nftAddress}` }]
          ]
        }
      }
    );
    
  } catch (error) {
    console.error('Error adding liquidity:', error);
    pendingTopUp.delete(telegramId);
    
    const errorMsg = formatUserFriendlyError(error.message || 'Unknown error');
    await bot.editMessageText(
      `❌ *Error Adding Liquidity*\n\n` +
      `${errorMsg}\n\n` +
      `Please try again or contact support.`,
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
  }
}

/**
 * Execute top-up without conversation flow (for programmatic use)
 * 
 * @param {Object} params - Top-up parameters
 * @param {Connection} params.connection - Solana connection
 * @param {Keypair} params.keypair - Wallet keypair
 * @param {string} params.positionMintAddress - Position NFT mint address
 * @param {number} params.targetUsd - USD amount to add
 * @param {Object} params.positionData - Position data from DB
 * @returns {Promise<Object>} Result with success, swaps, addLiqResult, etc.
 */
export async function executeTopUp({ connection, keypair, positionMintAddress, targetUsd, positionData }) {
  try {
    const positionMintPk = new PublicKey(positionMintAddress);
    const poolPk = new PublicKey(positionData.pool_address);
    const mint0 = new PublicKey(positionData.token0_mint);
    const mint1 = new PublicKey(positionData.token1_mint);
    const wsolMint = KNOWN_TOKENS.SOL.mint;
    
    // Check if tokens are WSOL
    const isToken0Wsol = positionData.token0_mint === wsolMint;
    const isToken1Wsol = positionData.token1_mint === wsolMint;
    
    // Get token info and prices with retry
    const [token0Info, token1Info] = await Promise.all([
      getTokenInfoWithRetry(positionData.token0_mint, 1, 1500),
      getTokenInfoWithRetry(positionData.token1_mint, 1, 1500)
    ]);
    
    // Validate token prices are available
    const token0Symbol = positionData.token0_symbol || 'token0';
    const token1Symbol = positionData.token1_symbol || 'token1';
    
    if (!token0Info.price || token0Info.price <= 0) {
      console.error(`[executeTopUp] Failed to fetch ${token0Symbol} price. Source: ${token0Info.source}`);
      return {
        success: false,
        error: `Unable to fetch ${token0Symbol} price from market data APIs. This is required to calculate the optimal token ratio. Please try again in a moment.`
      };
    }
    
    if (!token1Info.price || token1Info.price <= 0) {
      console.error(`[executeTopUp] Failed to fetch ${token1Symbol} price. Source: ${token1Info.source}`);
      return {
        success: false,
        error: `Unable to fetch ${token1Symbol} price from market data APIs. This is required to calculate the optimal token ratio. Please try again in a moment.`
      };
    }
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[executeTopUp] Token prices: ${token0Symbol}=$${token0Info.price.toFixed(4)}, ${token1Symbol}=$${token1Info.price.toFixed(4)}`);
    }
    
    // Fetch position and pool state
    const coder = new BorshCoder(PANCAKESWAP_IDL);
    const [personalPositionPk] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), positionMintPk.toBuffer()],
      PROGRAM_ID
    );
    
    const positionAi = await connection.getAccountInfo(personalPositionPk);
    if (!positionAi) throw new Error('Position account not found');
    const position = coder.accounts.decode("PersonalPositionState", positionAi.data);
    
    const poolAi = await connection.getAccountInfo(poolPk);
    if (!poolAi) throw new Error('Pool account not found');
    const pool = coder.accounts.decode("PoolState", poolAi.data);
    
    // Calculate optimal ratio
    const ratio = calculateTokenRatio(
      pool.sqrt_price_x64,
      position.tick_lower_index,
      position.tick_upper_index,
      pool.tick_current
    );
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[executeTopUp] Optimal ratio: ${(ratio.token0Percent * 100).toFixed(1)}% token0, ${(ratio.token1Percent * 100).toFixed(1)}% token1`);
    }
    
    // Target amounts based on ratio
    const targetToken0Usd = targetUsd * ratio.token0Percent;
    const targetToken1Usd = targetUsd * ratio.token1Percent;
    
    // Get current wallet balances
    const solBalance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
    
    const readBalanceForMint = async (mintPk) => {
      try {
        let ata = await getAssociatedTokenAddress(mintPk, keypair.publicKey, false, TOKEN_2022_PROGRAM);
        let ataInfo = await connection.getAccountInfo(ata);
        if (ataInfo) {
          const bal = await connection.getTokenAccountBalance(ata);
          return bal?.value?.uiAmount || 0;
        }
        ata = await getAssociatedTokenAddress(mintPk, keypair.publicKey, false, TOKEN_PROGRAM);
        ataInfo = await connection.getAccountInfo(ata);
        if (ataInfo) {
          const bal = await connection.getTokenAccountBalance(ata);
          return bal?.value?.uiAmount || 0;
        }
      } catch (e) {
        console.warn(`Failed to read balance for ${mintPk.toBase58()}:`, e.message);
      }
      return 0;
    };
    
    const token0Balance = isToken0Wsol ? solBalance : await readBalanceForMint(mint0);
    const token1Balance = isToken1Wsol ? solBalance : await readBalanceForMint(mint1);
    
    // Calculate current USD values (with fallback chain)
    const solPriceInfo = await getTokenInfo(KNOWN_TOKENS.SOL.mint);
    const solPrice = solPriceInfo.price || 0;
    let currentToken0Usd = isToken0Wsol 
      ? Math.max(0, (solBalance - DEFAULT_MIN_SOL_RESERVE) * solPrice)
      : token0Balance * token0Info.price;
    let currentToken1Usd = isToken1Wsol 
      ? Math.max(0, (solBalance - DEFAULT_MIN_SOL_RESERVE) * solPrice)
      : token1Balance * token1Info.price;
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[executeTopUp] Current: ${formatCurrency(currentToken0Usd)} token0, ${formatCurrency(currentToken1Usd)} token1`);
      console.log(`[executeTopUp] Target: ${formatCurrency(targetToken0Usd)} token0, ${formatCurrency(targetToken1Usd)} token1`);
    }
    
    const swapResults = [];
    
    // Swap tokens if needed to reach target ratio
    // First: SOL → token swaps (when we have excess SOL and need other tokens)
    if (!isToken0Wsol && currentToken0Usd < targetToken0Usd) {
      // Need more token0 - swap from SOL
      const neededUsd = targetToken0Usd - currentToken0Usd;
      const maxSwapSol = isToken1Wsol 
        ? Math.max(0, (solBalance - DEFAULT_MIN_SOL_RESERVE - targetToken1Usd / solPrice))
        : (solBalance - DEFAULT_MIN_SOL_RESERVE);
      const swapAmountSol = Math.min(neededUsd / solPrice, maxSwapSol);
      
      if (swapAmountSol > 0.001) {
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`[executeTopUp] Swapping ${swapAmountSol.toFixed(6)} SOL → ${positionData.token0_symbol}...`);
        }
        
        const swapResult = await retrySwapWithBackoff({
          connection,
          wallet: keypair,
          inputMint: wsolMint,
          outputMint: positionData.token0_mint,
          amount: BigInt(Math.floor(swapAmountSol * LAMPORTS_PER_SOL))
        });
        
        if (swapResult.success) {
          swapResults.push({ from: 'SOL', to: positionData.token0_symbol, amount: swapAmountSol, signature: swapResult.signature });
          currentToken0Usd += swapAmountSol * solPrice * 0.98;
        }
      }
    }
    
    if (!isToken1Wsol && currentToken1Usd < targetToken1Usd) {
      // Need more token1 - swap from SOL
      const neededUsd = targetToken1Usd - currentToken1Usd;
      const maxSwapSol = isToken0Wsol 
        ? Math.max(0, (solBalance - DEFAULT_MIN_SOL_RESERVE - targetToken0Usd / solPrice))
        : (solBalance - DEFAULT_MIN_SOL_RESERVE);
      const swapAmountSol = Math.min(neededUsd / solPrice, maxSwapSol);
      
      if (swapAmountSol > 0.001) {
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`[executeTopUp] Swapping ${swapAmountSol.toFixed(6)} SOL → ${positionData.token1_symbol}...`);
        }
        
        const swapResult = await retrySwapWithBackoff({
          connection,
          wallet: keypair,
          inputMint: wsolMint,
          outputMint: positionData.token1_mint,
          amount: BigInt(Math.floor(swapAmountSol * LAMPORTS_PER_SOL))
        });
        
        if (swapResult.success) {
          swapResults.push({ from: 'SOL', to: positionData.token1_symbol, amount: swapAmountSol, signature: swapResult.signature });
          currentToken1Usd += swapAmountSol * solPrice * 0.98;
        }
      }
    }
    
    // Then: Token → SOL swaps (when SOL is limiting)
    if (isToken0Wsol && currentToken0Usd < targetToken0Usd) {
      const neededUsd = targetToken0Usd - currentToken0Usd;
      const surplusToken1Usd = Math.max(0, currentToken1Usd - targetToken1Usd);
      const swapUsd = Math.min(neededUsd, surplusToken1Usd);
      
      if (swapUsd > 1) {
        const token1Decimals = await getMintDecimals(connection, mint1) || 6;
        const swapAmountToken1 = swapUsd / token1Info.price;
        const amountRaw = BigInt(Math.floor(swapAmountToken1 * (10 ** token1Decimals)));
        
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`[executeTopUp] Swapping ${swapAmountToken1.toFixed(6)} ${positionData.token1_symbol} → SOL...`);
        }
        
        const swapResult = await retrySwapWithBackoff({
          connection,
          wallet: keypair,
          inputMint: positionData.token1_mint,
          outputMint: wsolMint,
          amount: amountRaw
        });
        
        if (swapResult.success) {
          swapResults.push({ from: positionData.token1_symbol, to: 'SOL', amount: swapAmountToken1, signature: swapResult.signature });
          currentToken1Usd = Math.max(0, currentToken1Usd - swapUsd);
          currentToken0Usd += swapUsd * 0.98;
        }
      }
    }
    
    if (isToken1Wsol && currentToken1Usd < targetToken1Usd) {
      const neededUsd = targetToken1Usd - currentToken1Usd;
      const surplusToken0Usd = Math.max(0, currentToken0Usd - targetToken0Usd);
      const swapUsd = Math.min(neededUsd, surplusToken0Usd);
      
      if (swapUsd > 1) {
        const token0Decimals = await getMintDecimals(connection, mint0) || 6;
        const swapAmountToken0 = swapUsd / token0Info.price;
        const amountRaw = BigInt(Math.floor(swapAmountToken0 * (10 ** token0Decimals)));
        
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`[executeTopUp] Swapping ${swapAmountToken0.toFixed(6)} ${positionData.token0_symbol} → SOL...`);
        }
        
        const swapResult = await retrySwapWithBackoff({
          connection,
          wallet: keypair,
          inputMint: positionData.token0_mint,
          outputMint: wsolMint,
          amount: amountRaw
        });
        
        if (swapResult.success) {
          swapResults.push({ from: positionData.token0_symbol, to: 'SOL', amount: swapAmountToken0, signature: swapResult.signature });
          currentToken0Usd = Math.max(0, currentToken0Usd - swapUsd);
          currentToken1Usd += swapUsd * 0.98;
        }
      }
    }
    
    // Wait for finalization
    await new Promise((r) => setTimeout(r, FINALIZATION_DELAY_MS));
    
    // Refetch fresh balances
    const freshSolBalance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
    const freshToken0Balance = isToken0Wsol ? freshSolBalance : await readBalanceForMint(mint0);
    const freshToken1Balance = isToken1Wsol ? freshSolBalance : await readBalanceForMint(mint1);
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[executeTopUp] Fresh balances: SOL=${freshSolBalance.toFixed(6)}, Token0=${freshToken0Balance.toFixed(6)}, Token1=${freshToken1Balance.toFixed(6)}`);
    }
    
    // Calculate amounts to use
    // Account for slippage that will be applied by addLiquidity (dividing prevents exceeding balance after slippage is applied)
    const slippageMultiplier = 1 + (DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS / 10000); // 1.01 for 1% slippage
    const token0ToUse = isToken0Wsol 
      ? Math.max(0, (freshSolBalance - DEFAULT_MIN_SOL_RESERVE) / slippageMultiplier) 
      : freshToken0Balance;
    const token1ToUse = isToken1Wsol 
      ? Math.max(0, (freshSolBalance - DEFAULT_MIN_SOL_RESERVE) / slippageMultiplier) 
      : freshToken1Balance;
    
    // Validate we have tokens
    const needsBothTokens = ratio.inRange;
    const hasInsufficientTokens = needsBothTokens 
      ? (token0ToUse <= 0 || token1ToUse <= 0)
      : (token0ToUse <= 0 && token1ToUse <= 0);
    
    if (hasInsufficientTokens) {
      return {
        success: false,
        error: 'Insufficient tokens after swaps',
        swapResults
      };
    }
    
    // Fetch fresh pool state
    const freshPoolAi = await connection.getAccountInfo(poolPk);
    if (!freshPoolAi) throw new Error("Pool account not found");
    const freshPool = coder.accounts.decode("PoolState", freshPoolAi.data);
    
    // Recalculate ratio with fresh price
    const freshRatio = calculateTokenRatio(
      freshPool.sqrt_price_x64,
      position.tick_lower_index,
      position.tick_upper_index,
      freshPool.tick_current
    );
    
    // Determine limiting token
    const token0UsdCurrent = token0ToUse * token0Info.price;
    const token1UsdCurrent = token1ToUse * token1Info.price;
    const totalUsdCurrent = token0UsdCurrent + token1UsdCurrent;
    const currentToken0Percent = token0UsdCurrent / totalUsdCurrent;
    const token0Limiting = currentToken0Percent < freshRatio.token0Percent;
    const baseFlag = token0Limiting;
    
    // Add liquidity
    const addOptions = baseFlag
      ? { amount0: token0ToUse, slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS, baseFlag }
      : { amount1: token1ToUse, slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS, baseFlag };
    
    let addLiqResult = await addLiquidity(connection, keypair, positionMintPk, addOptions);
    
    // Retry on slippage error
    if (!addLiqResult.success && addLiqResult.error?.includes('PriceSlippageCheck')) {
      const retryOptions = baseFlag
        ? { amount0: token0ToUse, slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS + 100, baseFlag }
        : { amount1: token1ToUse, slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS + 100, baseFlag };
      addLiqResult = await addLiquidity(connection, keypair, positionMintPk, retryOptions);
    }
    
    return {
      success: addLiqResult.success,
      error: addLiqResult.error,
      swapResults,
      addLiqResult,
      tokensDeposited: addLiqResult.tokensDeposited || [],
      totalUsd: addLiqResult.totalUsd || 0,
      signature: addLiqResult.signature,
      explorer: addLiqResult.explorer
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      swapResults: []
    };
  }
}

/**
 * Check if user has pending top-up operation
 * 
 * @param {number} telegramId - Telegram user ID
 * @returns {boolean} True if pending operation exists
 */
export function hasPendingTopUp(telegramId) {
  return pendingTopUp.has(telegramId);
}

/**
 * Cancel pending top-up operation
 * 
 * @param {number} telegramId - Telegram user ID
 */
export function cancelPendingTopUp(telegramId) {
  pendingTopUp.delete(telegramId);
}

