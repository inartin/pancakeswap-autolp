/**
 * Add Position Handler
 * 
 * Handles the /addposition command for creating new liquidity positions.
 * This handler orchestrates a multi-step conversation flow:
 * 1. Request pool address
 * 2. Fetch pool info, show balances, request USD amount
 * 3. Request price range percentage
 * 4. Swap tokens if needed (maintaining SOL reserve), open position
 * 
 * @module addposition.handler
 */

import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { BorshCoder } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { getActiveWalletWithEncryption } from '../../services/wallet.service.js';
import { upsertPosition, getMostUsedPoolsByWallet } from '../../services/position.service.js';
import { decryptPrivateKey } from '../../utils/encryption.util.js';
import { formatCurrency, formatShortAddress, formatTokenAmount } from '../../utils/format.util.js';
import { getSolanaBalance, createSolanaConnection } from '../../utils/rpc.util.js';
import { getTokenInfo, getMintDecimals, getMintTokenProgram, unwrapWSol } from '../../utils/token.util.js';
import { swapTokensUltra } from '../../utils/jupiter-ultra.util.js';
import { openPosition } from '../../utils/open-position.util.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { formatUserFriendlyError } from '../formatters/message.formatter.js';
import { buildPoolsReplyKeyboard } from '../keyboard.util.js';
import { updatePoolsReplyKeyboard } from '../keyboard.util.js';
import {
  PROGRAM_ID,
  PANCAKESWAP_IDL,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  KNOWN_TOKENS,
  DEFAULT_MIN_SOL_RESERVE,
  LAMPORTS_PER_SOL,
  COMMITMENT_LEVEL,
  PREFLIGHT_COMMITMENT,
  getTokenSymbol,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  DEFAULT_OPEN_POSITION_SLIPPAGE_BPS,
  DEFAULT_PRIORITY_FEE_LAMPORTS,
  FINALIZATION_DELAY_MS,
  RECOMMENDED_SOL_BUFFER,
  SOL_RESERVE_BUFFER
} from '../../config/constants.js';

// In-memory store for pending add position operations
// Key: telegram user ID, Value: { step, chatId, data }
const pendingAddPosition = new Map();

// In-memory store for last-used add position settings (for retry)
// Key: telegram user ID, Value: { chatId, poolPk, usdAmount, rangePercent }
const lastAddPositionSettings = new Map();

/**
 * Determine if a stored symbol is effectively missing
 * Treats null/empty/UNKNOWN, abbreviated addresses (…)
 * and raw base58 addresses as missing symbols
 */
function isSymbolMissing(symbol) {
  if (!symbol) return true;
  const value = String(symbol).trim();
  if (value.length === 0) return true;
  if (value.toUpperCase() === 'UNKNOWN') return true;
  if (value.includes('...')) return true; // abbreviated address like abcd...wxyz
  // raw base58 address (32-44 chars, excluding 0OIl)
  const base58Re = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (base58Re.test(value)) return true;
  return false;
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
 * Parse range percentage from user input
 * Supports: "5%", "5", "3.5%", "3.5"
 * 
 * @param {string} input - User input string
 * @returns {number|null} Parsed percentage or null if invalid
 */
function parseRangePercent(input) {
  if (!input) return null;
  
  // Remove % symbol
  const cleaned = input.replace(/%/g, '').trim();
  const parsed = parseFloat(cleaned);
  
  if (isNaN(parsed) || parsed <= 0 || parsed > 100) return null;
  
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
 * Fetch pool information and token balances
 * 
 * @param {Connection} connection - Solana connection
 * @param {PublicKey} poolPk - Pool public key
 * @param {PublicKey} walletPk - Wallet public key
 * @returns {Promise<Object>} Pool info and balances
 */
async function fetchPoolInfo(connection, poolPk, walletPk) {
  const coder = new BorshCoder(PANCAKESWAP_IDL);
  
  // Fetch pool state
  const poolAi = await connection.getAccountInfo(poolPk);
  if (!poolAi) {
    throw new Error('Pool account not found. Please check the pool address.');
  }
  
  const pool = coder.accounts.decode('PoolState', poolAi.data);
  const mint0 = new PublicKey(pool.token_mint_0);
  const mint1 = new PublicKey(pool.token_mint_1);
  
  // Get token info (symbols and prices)
  const [token0Info, token1Info] = await Promise.all([
    getTokenInfo(mint0.toBase58()),
    getTokenInfo(mint1.toBase58())
  ]);
  
  // Use fallback for unknown tokens
  const token0Symbol = token0Info.ticker && token0Info.ticker !== 'UNKNOWN' 
    ? token0Info.ticker 
    : getTokenSymbol(mint0.toBase58());
  const token1Symbol = token1Info.ticker && token1Info.ticker !== 'UNKNOWN'
    ? token1Info.ticker
    : getTokenSymbol(mint1.toBase58());
  
  // Get wallet balances
  const solBalance = await connection.getBalance(walletPk);
  const solBalanceUi = solBalance / LAMPORTS_PER_SOL;
  
  // Fetch SOL price in USD (with fallback chain: Jupiter → Moralis → DexScreener)
  const solInfo = await getTokenInfo(KNOWN_TOKENS.SOL.mint);
  const solPrice = solInfo.price || 0;
  
  // Get token account balances (detect legacy vs Token-2022)
  let token0Balance = 0;
  let token1Balance = 0;

  // Helper: try to read ATA balance for a given program (with fallback)
  const readBalanceWithProgramDetection = async (mintPk) => {
    try {
      const program = await getMintTokenProgram(connection, mintPk);
      const is2022 = program.equals(TOKEN_2022_PROGRAM);
      const ata = await getAssociatedTokenAddress(mintPk, walletPk, false, program);
      const ataInfo = await connection.getAccountInfo(ata);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[balances] ${mintPk.toBase58()} program=${is2022 ? 'Token-2022' : 'Token'} ata=${ata.toBase58()} exists=${!!ataInfo}`);
      }
      if (ataInfo) {
        const bal = await connection.getTokenAccountBalance(ata);
        return bal?.value?.uiAmount || 0;
      }
      // Fallback: try the other program in case of mismatch
      const altProgram = is2022 ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
      const altAta = await getAssociatedTokenAddress(mintPk, walletPk, false, altProgram);
      const altInfo = await connection.getAccountInfo(altAta);
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`[balances] fallback ata=${altAta.toBase58()} exists=${!!altInfo}`);
      }
      if (altInfo) {
        const bal = await connection.getTokenAccountBalance(altAta);
        return bal?.value?.uiAmount || 0;
      }
    } catch (e) {
      console.warn(`[balances] Failed to read ATA for ${mintPk.toBase58()}: ${e?.message || e}`);
    }
    return 0;
  };

  token0Balance = await readBalanceWithProgramDetection(mint0);
  token1Balance = await readBalanceWithProgramDetection(mint1);
  
  return {
    mint0,
    mint1,
    token0Symbol,
    token1Symbol,
    token0Price: token0Info.price || 0,
    token1Price: token1Info.price || 1,
    solPrice,
    solBalance: solBalanceUi,
    token0Balance,
    token1Balance,
    pool
  };
}

/**
 * Retry a Jupiter swap with incremental slippage and priority fee
 * Ensures swap confirmation before proceeding.
 *
 * @param {Object} params - swapTokens params
 * @param {Connection} params.connection
 * @param {Keypair} params.wallet
 * @param {string} params.inputMint
 * @param {string} params.outputMint
 * @param {bigint} params.amount
 * @param {(attempt:number)=>Promise<void>|void} [params.onAttempt] - optional progress callback per attempt (1-based)
 * @returns {Promise<{success:boolean, signature?:string, error?:string}>}
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
 * Retry opening a position with incremental slippage.
 * @param {Object} params
 * @param {import('@solana/web3.js').Connection} params.connection
 * @param {import('@solana/web3.js').Keypair} params.wallet
 * @param {import('@solana/web3.js').PublicKey} params.poolPk
 * @param {any} params.idl
 * @param {Object} params.options - base options for openPosition
 * @param {(attempt:number)=>Promise<void>|void} [params.onAttempt] - optional progress callback
 * @returns {Promise<{success:boolean, error?:string, [key:string]:any}>}
 */
async function retryOpenPositionWithBackoff({ connection, wallet, poolPk, idl, options, onAttempt }) {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (typeof onAttempt === 'function') {
        await onAttempt(attempt);
      }
    } catch (_) {}
    const slippageBps = (options?.slippageBps ?? DEFAULT_OPEN_POSITION_SLIPPAGE_BPS) + (attempt - 1) * 50; // +0, +50, +100 bps
    try {
      const res = await openPosition(
        connection,
        wallet,
        poolPk,
        idl,
        { ...options, slippageBps }
      );
      if (res?.success) return res;
      lastError = res?.error || 'Open position failed';
    } catch (e) {
      lastError = e?.message || 'Open position exception';
    }
  }
  return { success: false, error: lastError || 'Open position failed after retries' };
}

/**
 * Handles the /addposition command
 * Starts the multi-step conversation flow
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} msg - Telegram message object
 */
export async function handleAddPosition(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  try {
    // Check if user has an active wallet
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
    
    // Initialize pending operation
    pendingAddPosition.set(telegramId, {
      step: 'pool',
      chatId,
      data: {}
    });

    // Attempt to show most-used pools as quick-select buttons (all-time)
    let inlineKeyboard;
    try {
      const topPools = await getMostUsedPoolsByWallet(wallet.id, 3);
      if (Array.isArray(topPools) && topPools.length > 0) {
        // Setup for fee fetching (optional enhancement)
        let getCachedPoolStructure = null;
        let coder = null;
        let connection = null;
        
        try {
          const cacheUtil = await import('../../cache/redis-cache.util.js');
          getCachedPoolStructure = cacheUtil.getCachedPoolStructure;
          coder = new BorshCoder(PANCAKESWAP_IDL);
          connection = createSolanaConnection();
        } catch (setupError) {
          console.warn('Fee fetching setup failed, will show pools without fees:', setupError.message);
        }
        
        // Resolve missing tickers and optionally fetch fee rates
        const enriched = await Promise.all(topPools.map(async (p) => {
          let t0 = p.token0Symbol;
          let t1 = p.token1Symbol;
          let feePercent = null;
          
          try {
            if (isSymbolMissing(t0) && p.token0Mint) {
              const info0 = await getTokenInfo(p.token0Mint);
              t0 = info0?.ticker || t0;
            }
          } catch {}
          try {
            if (isSymbolMissing(t1) && p.token1Mint) {
              const info1 = await getTokenInfo(p.token1Mint);
              t1 = info1?.ticker || t1;
            }
          } catch {}
          
          // Fetch pool fee rate from AmmConfig (optional)
          if (getCachedPoolStructure && coder && connection) {
            try {
              const poolPk = new PublicKey(p.poolAddress);
              const poolStructure = await getCachedPoolStructure(connection, poolPk, coder);
              if (poolStructure?.tradeFeeRate != null) {
                feePercent = (poolStructure.tradeFeeRate / 1_000_000) * 100;
              }
            } catch (feeError) {
              // Fee fetching failed for this pool - continue without it
            }
          }
          
          return { ...p, token0Symbol: t0, token1Symbol: t1, feePercent };
        }));

        inlineKeyboard = [
          enriched.map((p) => {
            let label;
            if (p.token0Symbol && p.token1Symbol) {
              label = `${p.token0Symbol}/${p.token1Symbol}`;
              if (p.feePercent != null) {
                label += ` (${p.feePercent.toFixed(2)}%)`;
              }
            } else {
              label = `Pool ${formatShortAddress(p.poolAddress)}`;
            }
            return { text: label, callback_data: `addposition_pool_${p.poolAddress}` };
          }),
          [ { text: '❌ Cancel', callback_data: 'addposition_cancel' } ]
        ];
      }
    } catch (error) {
      console.error('Error creating pool selection buttons:', error);
    }

    const hasTop = !!inlineKeyboard;

    await bot.sendMessage(
      chatId,
      hasTop
        ? (
          `➕ *Add New Position*\n\n` +
          `Let's create a new liquidity position!\n\n` +
          `*Step 1/3:* Choose one of your frequently used pools or send a pool address.`
        )
        : (
          `➕ *Add New Position*\n\n` +
          `Let's create a new liquidity position!\n\n` +
          `*Step 1/3:* Please send the pool address.\n\n` +
          `*Example:*\n` +
          `\`22HUWiJaTNph96KQTKZVy2wg8KzfCems5nyW7E5H5J6w\`\n\n` +
          `Or /cancel to abort.`
        ),
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard || [[{ text: '❌ Cancel', callback_data: 'addposition_cancel' }]] } }
    );
    
  } catch (error) {
    console.error('Error in handleAddPosition:', error);
    await bot.sendMessage(chatId,
      `❌ *Error*\n\nFailed to start add position: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handles incoming messages for pending add position operations
 * Routes to appropriate handler based on current step
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} msg - Telegram message object
 */
export async function handleAddPositionMessage(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const text = msg.text.trim();
  
  const pending = pendingAddPosition.get(telegramId);
  if (!pending) return;
  
  try {
    if (pending.step === 'pool') {
      await handlePoolAddress(bot, msg, text, pending);
    } else if (pending.step === 'usd') {
      await handleUsdAmount(bot, msg, text, pending);
    } else if (pending.step === 'range') {
      await handleRangePercent(bot, msg, text, pending);
    }
  } catch (error) {
    console.error('Error in handleAddPositionMessage:', error);
    await bot.sendMessage(chatId,
      `❌ *Error*\n\n${error.message}\n\nPlease try again or /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handle pool address input (Step 1)
 */
async function handlePoolAddress(bot, msg, text, pending) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  // Validate pool address
  let poolPk;
  try {
    poolPk = new PublicKey(text);
  } catch (error) {
    await bot.sendMessage(chatId,
      `❌ *Invalid Pool Address*\n\n` +
      `Please provide a valid Solana address.\n\n` +
      `*Example:*\n` +
      `\`GLfJcQZgtLV2QyEBxmNNZ75uJFG1VRiLiki8PfcTZQjW\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Show loading message
  const loadingMsg = await bot.sendMessage(chatId,
    `🔄 *Fetching Pool Information...*\n\n` +
    `Checking pool state and your balances...`,
    { parse_mode: 'Markdown' }
  );
  
  try {
    // Get wallet
    const wallet = await getActiveWalletWithEncryption(telegramId);
    const walletPk = new PublicKey(wallet.wallet_address);
    
    // Connect to Solana
    const connection = new Connection(process.env.SOLANA_RPC_URL, COMMITMENT_LEVEL);
    
    // Fetch pool info and balances
    const poolInfo = await fetchPoolInfo(connection, poolPk, walletPk);
    
    // Calculate total available USD
    const solUsdValue = (poolInfo.solBalance - DEFAULT_MIN_SOL_RESERVE) * poolInfo.solPrice;
    const token0UsdValue = poolInfo.token0Balance * poolInfo.token0Price;
    const token1UsdValue = poolInfo.token1Balance * poolInfo.token1Price;
    const totalAvailableUsd = Math.max(0, solUsdValue) + token0UsdValue + token1UsdValue;
    
    // Update pending state
    pending.step = 'usd';
    pending.data.poolAddress = text;
    pending.data.poolPk = poolPk.toBase58();
    pending.data.poolInfo = poolInfo;
    pendingAddPosition.set(telegramId, pending);
    
    // Delete loading message and show pool info
    await bot.deleteMessage(chatId, loadingMsg.message_id);
    
    // Check if either token is WSOL to avoid showing it twice
    const isToken0Wsol = poolInfo.mint0.toBase58() === KNOWN_TOKENS.SOL.mint;
    const isToken1Wsol = poolInfo.mint1.toBase58() === KNOWN_TOKENS.SOL.mint;
    
    // Use fetched SOL price
    const solPrice = poolInfo.solPrice;
    
    // Build balance display
    let balancesText = `*Your Balances:*\n`;
    balancesText += `• SOL: ${formatBalance(poolInfo.solBalance, 'SOL', solPrice)}\n`;
    
    // Only show token0 balance if it's not WSOL
    if (!isToken0Wsol && poolInfo.token0Balance > 0) {
      balancesText += `• ${poolInfo.token0Symbol}: ${formatBalance(poolInfo.token0Balance, poolInfo.token0Symbol, poolInfo.token0Price)}\n`;
    }
    
    // Only show token1 balance if it's not WSOL
    if (!isToken1Wsol && poolInfo.token1Balance > 0) {
      balancesText += `• ${poolInfo.token1Symbol}: ${formatBalance(poolInfo.token1Balance, poolInfo.token1Symbol, poolInfo.token1Price)}\n`;
    }
    
    await bot.sendMessage(chatId,
      `✅ *Pool Found*\n\n` +
      `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
      `*Address:* \`${formatShortAddress(text)}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${balancesText}\n` +
      `*Available (after ${DEFAULT_MIN_SOL_RESERVE} SOL reserve):* ${formatCurrency(totalAvailableUsd)}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `*Step 2/3:* How much USD do you want to add to ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}?\n\n` +
      `*Example:* \`$500\` or \`500\`\n\n` +
      `Or /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    await bot.deleteMessage(chatId, loadingMsg.message_id);
    throw error;
  }
}

/**
 * Handle USD amount input (Step 2)
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
  
  // Check if amount is available
  const poolInfo = pending.data.poolInfo;
  const solUsdValue = Math.max(0, (poolInfo.solBalance - DEFAULT_MIN_SOL_RESERVE) * poolInfo.solPrice);
  const token0UsdValue = poolInfo.token0Balance * poolInfo.token0Price;
  const token1UsdValue = poolInfo.token1Balance * poolInfo.token1Price;
  const totalAvailableUsd = solUsdValue + token0UsdValue + token1UsdValue;
  
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
  
  // Update pending state
  pending.step = 'range';
  pending.data.usdAmount = usdAmount;
  pendingAddPosition.set(telegramId, pending);
  
  await bot.sendMessage(chatId,
    `✅ *Amount Confirmed*\n\n` +
    `Depositing: ${formatCurrency(usdAmount)}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `*Step 3/3:* What price range?\n\n` +
    `This creates a symmetric range around the current price.\n\n` +
    `*Examples:*\n` +
    `• \`5%\` - Narrow range (±5%)\n` +
    `• \`10%\` - Medium range (±10%)\n` +
    `• \`20%\` - Wide range (±20%)\n\n` +
    `*Tip:* Narrower ranges earn more fees but require more frequent rebalancing.\n\n` +
    `Or /cancel to abort.`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handle range percentage input (Step 3) and execute position creation
 */
async function handleRangePercent(bot, msg, text, pending) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  // Parse range percentage
  const rangePercent = parseRangePercent(text);
  
  if (!rangePercent) {
    await bot.sendMessage(chatId,
      `❌ *Invalid Range*\n\n` +
      `Please provide a valid percentage.\n\n` +
      `*Examples:*\n` +
      `• \`5%\` or \`5\`\n` +
      `• \`10%\` or \`10\`\n` +
      `• \`20%\` or \`20\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Persist last-used settings for quick retry with same inputs
  try {
    if (pending?.data?.poolPk && pending?.data?.usdAmount) {
      lastAddPositionSettings.set(telegramId, {
        chatId,
        poolPk: pending.data.poolPk,
        usdAmount: pending.data.usdAmount,
        rangePercent
      });
    }
  } catch (_) {}
  
  // Show processing message
  const processingMsg = await bot.sendMessage(chatId,
    `🔄 *Creating Position...*\n\n` +
    `*Pool:* ${pending.data.poolInfo.token0Symbol}/${pending.data.poolInfo.token1Symbol}\n` +
    `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
    `*Range:* ±${rangePercent}%\n\n` +
    `⏳ Step 1/4: Checking balances...\n\n` +
    `*Please wait...*`,
    { parse_mode: 'Markdown' }
  );
  
  try {
    // Get wallet
    const wallet = await getActiveWalletWithEncryption(telegramId);
    
    // Validate encryption data
    if (!wallet.encrypted_private_key || !wallet.nonce || !wallet.salt) {
      throw new Error('Wallet encryption data is missing. Please re-import your wallet.');
    }
    
    if (!process.env.MASTER_PASSWORD) {
      throw new Error('MASTER_PASSWORD is not configured.');
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
      throw new Error(`Failed to decrypt wallet: ${decryptError.message}`);
    }
    
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = new Connection(process.env.SOLANA_RPC_URL, COMMITMENT_LEVEL);
    
    // Update: Analyzing pool
    await bot.editMessageText(
      `🔄 *Creating Position...*\n\n` +
      `*Pool:* ${pending.data.poolInfo.token0Symbol}/${pending.data.poolInfo.token1Symbol}\n` +
      `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
      `*Range:* ±${rangePercent}%\n\n` +
      `⏳ Step 2/4: Analyzing pool...\n\n` +
      `*Please wait...*`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown'
      }
    );
    
    // Fetch fresh pool info
    const poolPk = new PublicKey(pending.data.poolPk);
    const poolInfo = await fetchPoolInfo(connection, poolPk, keypair.publicKey);
    
    // Update: Swapping tokens if needed
    await bot.editMessageText(
      `🔄 *Creating Position...*\n\n` +
      `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
      `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
      `*Range:* ±${rangePercent}%\n\n` +
      `⏳ Step 3/4: Preparing tokens...\n\n` +
      `*Please wait...*`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown'
      }
    );
    
    // Swap tokens if needed to reach target USD amount
    const swapResults = [];
    const targetUsd = pending.data.usdAmount;
    
    // Check if either token is SOL/WSOL (don't need to swap for SOL)
    const wsolMint = KNOWN_TOKENS.SOL.mint;
    const isToken0Sol = poolInfo.mint0.toBase58() === wsolMint;
    const isToken1Sol = poolInfo.mint1.toBase58() === wsolMint;
    
    // Get SOL price
    const solPrice = poolInfo.solPrice;
    
    // Calculate how much USD we have in each token (excluding SOL reserve)
    const availableSolUsd = Math.max(0, (poolInfo.solBalance - DEFAULT_MIN_SOL_RESERVE) * solPrice);
    const token0UsdValue = poolInfo.token0Balance * poolInfo.token0Price;
    const token1UsdValue = poolInfo.token1Balance * poolInfo.token1Price;
    
    // Calculate total available USD (SOL counts for whichever token is SOL/WSOL)
    let totalAvailable;
    if (isToken0Sol && isToken1Sol) {
      // Both tokens are SOL (rare edge case) - use all SOL
      totalAvailable = availableSolUsd;
    } else if (isToken0Sol) {
      // Token0 is SOL - SOL can be used for token0, other balance for token1
      totalAvailable = availableSolUsd + token1UsdValue;
    } else if (isToken1Sol) {
      // Token1 is SOL - SOL can be used for token1, other balance for token0
      totalAvailable = token0UsdValue + availableSolUsd;
    } else {
      // Neither token is SOL - need to swap SOL to both tokens
      totalAvailable = availableSolUsd + token0UsdValue + token1UsdValue;
    }
    
    // Cap target at available funds
    const actualTarget = Math.min(targetUsd, totalAvailable);
    
    // Target: 50% in token0, 50% in token1 (openPosition will adjust to exact CLMM ratio)
    const targetToken0Usd = actualTarget * 0.5;
    const targetToken1Usd = actualTarget * 0.5;
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Target: ${formatCurrency(actualTarget)} | Token0: ${formatCurrency(targetToken0Usd)} | Token1: ${formatCurrency(targetToken1Usd)}`);
    }
    
    // Determine current balances in USD for each token position
    let currentToken0Usd = isToken0Sol ? availableSolUsd : token0UsdValue;
    let currentToken1Usd = isToken1Sol ? availableSolUsd : token1UsdValue;
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Current - Token0: ${formatCurrency(currentToken0Usd)} | Token1: ${formatCurrency(currentToken1Usd)}`);
    }
    
    // Swap logic: ensure we have enough of each token to meet target
    // If we don't have enough of a token, swap SOL to get it
    
    if (!isToken0Sol && currentToken0Usd < targetToken0Usd) {
      // Need more token0 - swap from SOL
      const neededUsd = targetToken0Usd - currentToken0Usd;
      // Don't swap more SOL than available
      const maxSwapSol = isToken1Sol 
        ? Math.max(0, (poolInfo.solBalance - DEFAULT_MIN_SOL_RESERVE - targetToken1Usd / solPrice))
        : (poolInfo.solBalance - DEFAULT_MIN_SOL_RESERVE);
      const swapAmountSol = Math.min(neededUsd / solPrice, maxSwapSol);
      
      if (swapAmountSol > 0.001) { // Only swap if meaningful amount
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Swapping ${swapAmountSol.toFixed(6)} SOL to ${poolInfo.token0Symbol}...`);
        }
        try {
          const swapResult = await retrySwapWithBackoff({
            connection,
            wallet: keypair,
            inputMint: wsolMint,
            outputMint: poolInfo.mint0.toBase58(),
            amount: BigInt(Math.floor(swapAmountSol * LAMPORTS_PER_SOL)),
            onAttempt: async (attempt) => {
              try {
                await bot.editMessageText(
                  `🔄 *Creating Position...*\n\n` +
                  `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
                  `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
                  `*Range:* ±${rangePercent}%\n\n` +
                  `⏳ Step 3/4: Preparing tokens...\n\n` +
                  `🔁 Swapping SOL → ${poolInfo.token0Symbol} (attempt ${attempt}/3)\n\n` +
                  `*Please wait...*`,
                  { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
                );
              } catch (_) {}
            }
          });
          
          if (swapResult.success) {
            swapResults.push({
              from: 'SOL',
              to: poolInfo.token0Symbol,
              amountIn: swapAmountSol,
              signature: swapResult.signature
            });
            // Update current balance (approximate)
            currentToken0Usd += swapAmountSol * solPrice * 0.98; // Account for slippage
          } else {
            console.warn(`Failed to swap SOL to ${poolInfo.token0Symbol}:`, swapResult.error || 'Unknown error');
          }
        } catch (swapError) {
          console.warn(`Failed to swap SOL to ${poolInfo.token0Symbol}:`, swapError.message);
        }
      }
    }
    
    if (!isToken1Sol && currentToken1Usd < targetToken1Usd) {
      // Need more token1 - swap from SOL
      const neededUsd = targetToken1Usd - currentToken1Usd;
      // Don't swap more SOL than available (accounting for token0 if it used SOL)
      const maxSwapSol = isToken0Sol 
        ? Math.max(0, (poolInfo.solBalance - DEFAULT_MIN_SOL_RESERVE - targetToken0Usd / solPrice))
        : (poolInfo.solBalance - DEFAULT_MIN_SOL_RESERVE);
      const swapAmountSol = Math.min(neededUsd / solPrice, maxSwapSol);
      
      if (swapAmountSol > 0.001) { // Only swap if meaningful amount
        if (process.env.LOG_LEVEL === 'debug') {
          console.log(`Swapping ${swapAmountSol.toFixed(6)} SOL to ${poolInfo.token1Symbol}...`);
        }
        try {
          const swapResult = await retrySwapWithBackoff({
            connection,
            wallet: keypair,
            inputMint: wsolMint,
            outputMint: poolInfo.mint1.toBase58(),
            amount: BigInt(Math.floor(swapAmountSol * LAMPORTS_PER_SOL)),
            onAttempt: async (attempt) => {
              try {
                await bot.editMessageText(
                  `🔄 *Creating Position...*\n\n` +
                  `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
                  `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
                  `*Range:* ±${rangePercent}%\n\n` +
                  `⏳ Step 3/4: Preparing tokens...\n\n` +
                  `🔁 Swapping SOL → ${poolInfo.token1Symbol} (attempt ${attempt}/3)\n\n` +
                  `*Please wait...*`,
                  { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
                );
              } catch (_) {}
            }
          });
          
          if (swapResult.success) {
            swapResults.push({
              from: 'SOL',
              to: poolInfo.token1Symbol,
              amountIn: swapAmountSol,
              signature: swapResult.signature
            });
            // Update current balance (approximate)
            currentToken1Usd += swapAmountSol * solPrice * 0.98; // Account for slippage
          } else {
            console.warn(`Failed to swap SOL to ${poolInfo.token1Symbol}:`, swapResult.error || 'Unknown error');
          }
        } catch (swapError) {
          console.warn(`Failed to swap SOL to ${poolInfo.token1Symbol}:`, swapError.message);
        }
      }
    }

    // Additional balancing: when one side is SOL and short, swap the other token → SOL
    // Case A: token0 is SOL and below target → swap token1 to SOL
    if (isToken0Sol && currentToken0Usd < targetToken0Usd) {
      const neededUsd = targetToken0Usd - currentToken0Usd;
      const surplusToken1Usd = Math.max(0, currentToken1Usd - targetToken1Usd);
      const swapUsd = Math.min(neededUsd, surplusToken1Usd);

      if (swapUsd > 0.01) { // Only swap if meaningful amount
        try {
          const token1Decimals = await getMintDecimals(connection, poolInfo.mint1) || 6;
          const swapAmountToken1 = swapUsd / poolInfo.token1Price; // human-readable amount
          const amountRaw = BigInt(Math.floor(swapAmountToken1 * (10 ** token1Decimals)));

          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`Swapping ${swapAmountToken1.toFixed(6)} ${poolInfo.token1Symbol} → SOL...`);
          }

          const swapResult = await retrySwapWithBackoff({
            connection,
            wallet: keypair,
            inputMint: poolInfo.mint1.toBase58(),
            outputMint: wsolMint,
            amount: amountRaw,
            onAttempt: async (attempt) => {
              try {
                await bot.editMessageText(
                  `🔄 *Creating Position...*\n\n` +
                  `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
                  `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
                  `*Range:* ±${rangePercent}%\n\n` +
                  `⏳ Step 3/4: Preparing tokens...\n\n` +
                  `🔁 Swapping ${poolInfo.token1Symbol} → SOL (attempt ${attempt}/3)\n\n` +
                  `*Please wait...*`,
                  { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
                );
              } catch (_) {}
            }
          });

          if (swapResult.success) {
            swapResults.push({
              from: poolInfo.token1Symbol,
              to: 'SOL',
              amountIn: swapAmountToken1,
              signature: swapResult.signature
            });
            // Update approximate balances for further planning in this step
            currentToken1Usd = Math.max(0, currentToken1Usd - swapUsd);
            currentToken0Usd += swapUsd * 0.98; // account for slippage/fees
          } else {
            console.warn(`Failed to swap ${poolInfo.token1Symbol} → SOL:`, swapResult.error || 'Unknown error');
          }
        } catch (swapError) {
          console.warn(`Failed to swap ${poolInfo.token1Symbol} → SOL:`, swapError.message);
        }
      }
    }

    // Case B: token1 is SOL and below target → swap token0 to SOL
    if (isToken1Sol && currentToken1Usd < targetToken1Usd) {
      const neededUsd = targetToken1Usd - currentToken1Usd;
      const surplusToken0Usd = Math.max(0, currentToken0Usd - targetToken0Usd);
      const swapUsd = Math.min(neededUsd, surplusToken0Usd);

      if (swapUsd > 0.01) { // Only swap if meaningful amount
        try {
          const token0Decimals = await getMintDecimals(connection, poolInfo.mint0) || 6;
          const swapAmountToken0 = swapUsd / poolInfo.token0Price; // human-readable amount
          const amountRaw = BigInt(Math.floor(swapAmountToken0 * (10 ** token0Decimals)));

          if (process.env.LOG_LEVEL === 'debug') {
            console.log(`Swapping ${swapAmountToken0.toFixed(6)} ${poolInfo.token0Symbol} → SOL...`);
          }

          const swapResult = await retrySwapWithBackoff({
            connection,
            wallet: keypair,
            inputMint: poolInfo.mint0.toBase58(),
            outputMint: wsolMint,
            amount: amountRaw,
            onAttempt: async (attempt) => {
              try {
                await bot.editMessageText(
                  `🔄 *Creating Position...*\n\n` +
                  `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
                  `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
                  `*Range:* ±${rangePercent}%\n\n` +
                  `⏳ Step 3/4: Preparing tokens...\n\n` +
                  `🔁 Swapping ${poolInfo.token0Symbol} → SOL (attempt ${attempt}/3)\n\n` +
                  `*Please wait...*`,
                  { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
                );
              } catch (_) {}
            }
          });

          if (swapResult.success) {
            swapResults.push({
              from: poolInfo.token0Symbol,
              to: 'SOL',
              amountIn: swapAmountToken0,
              signature: swapResult.signature
            });
            // Update approximate balances
            currentToken0Usd = Math.max(0, currentToken0Usd - swapUsd);
            currentToken1Usd += swapUsd * 0.98; // account for slippage/fees
          } else {
            console.warn(`Failed to swap ${poolInfo.token0Symbol} → SOL:`, swapResult.error || 'Unknown error');
          }
        } catch (swapError) {
          console.warn(`Failed to swap ${poolInfo.token0Symbol} → SOL:`, swapError.message);
        }
      }
    }
    
    // Small finalization delay to ensure post-swap balances are visible on RPC
    try {
      await new Promise((r) => setTimeout(r, FINALIZATION_DELAY_MS));
    } catch {}

    // Critical: Check SOL reserve and top up if needed (for non-SOL pools)
    // This ensures we have enough SOL for transaction fees when opening positions
    const currentSolBalance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
    const neededSol = DEFAULT_MIN_SOL_RESERVE - currentSolBalance;

    if (neededSol > 0.001) { // Need at least 0.001 more SOL for fees
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`⚠️ SOL balance (${currentSolBalance.toFixed(6)}) below reserve. Need to top up by ${neededSol.toFixed(6)} SOL`);
      }
      
      // Refresh pool info to get current balances after previous swaps
      const currentPoolInfo = await fetchPoolInfo(connection, poolPk, keypair.publicKey);
      
      // Try to swap from token1 (usually stablecoin like USDC) first
      let topUpSuccess = false;
      
      if (!isToken1Sol && currentPoolInfo.token1Balance > 0) {
        const swapAmountUsd = (neededSol + 0.01) * solPrice; // Add 0.01 SOL buffer for safety
        const token1Available = currentPoolInfo.token1Balance * currentPoolInfo.token1Price;
        
        if (token1Available >= swapAmountUsd * 0.9) { // Allow 10% buffer for slippage
          try {
            const token1Decimals = await getMintDecimals(connection, poolInfo.mint1) || 6;
            const swapAmountToken1 = swapAmountUsd / currentPoolInfo.token1Price;
            const amountRaw = BigInt(Math.floor(swapAmountToken1 * (10 ** token1Decimals)));
            
            if (process.env.LOG_LEVEL === 'debug') {
              console.log(`Swapping ${swapAmountToken1.toFixed(6)} ${currentPoolInfo.token1Symbol} → SOL for fee reserve...`);
            }
            
            const topUpResult = await retrySwapWithBackoff({
              connection,
              wallet: keypair,
              inputMint: poolInfo.mint1.toBase58(),
              outputMint: wsolMint,
              amount: amountRaw,
              onAttempt: async (attempt) => {
                try {
                  await bot.editMessageText(
                    `🔄 *Creating Position...*\n\n` +
                    `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
                    `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
                    `*Range:* ±${rangePercent}%\n\n` +
                    `⏳ Step 3.5/4: Topping up SOL for fees...\n\n` +
                    `🔁 Swapping ${currentPoolInfo.token1Symbol} → SOL (attempt ${attempt}/3)\n\n` +
                    `*Please wait...*`,
                    { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
                  );
                } catch (_) {}
              }
            });
            
            if (topUpResult.success) {
              swapResults.push({
                from: currentPoolInfo.token1Symbol,
                to: 'SOL',
                amountIn: swapAmountToken1,
                signature: topUpResult.signature
              });
              topUpSuccess = true;
              if (process.env.LOG_LEVEL === 'debug') {
                console.log(`✅ Topped up SOL successfully from ${currentPoolInfo.token1Symbol}`);
              }
              
              // Wait for swap to finalize
              await new Promise((r) => setTimeout(r, FINALIZATION_DELAY_MS));
            } else {
              console.warn(`Failed to top up SOL from ${currentPoolInfo.token1Symbol}: ${topUpResult.error}`);
            }
          } catch (topUpError) {
            console.warn(`Failed to top up SOL from ${currentPoolInfo.token1Symbol}:`, topUpError.message);
          }
        }
      }
      
      // Fallback: Try token0 if token1 failed or not available
      if (!topUpSuccess && !isToken0Sol && currentPoolInfo.token0Balance > 0) {
        const swapAmountUsd = (neededSol + 0.01) * solPrice; // Add 0.01 SOL buffer for safety
        const token0Available = currentPoolInfo.token0Balance * currentPoolInfo.token0Price;
        
        if (token0Available >= swapAmountUsd * 0.9) { // Allow 10% buffer for slippage
          try {
            const token0Decimals = await getMintDecimals(connection, poolInfo.mint0) || 6;
            const swapAmountToken0 = swapAmountUsd / currentPoolInfo.token0Price;
            const amountRaw = BigInt(Math.floor(swapAmountToken0 * (10 ** token0Decimals)));
            
            if (process.env.LOG_LEVEL === 'debug') {
              console.log(`Swapping ${swapAmountToken0.toFixed(6)} ${currentPoolInfo.token0Symbol} → SOL for fee reserve...`);
            }
            
            const topUpResult = await retrySwapWithBackoff({
              connection,
              wallet: keypair,
              inputMint: poolInfo.mint0.toBase58(),
              outputMint: wsolMint,
              amount: amountRaw,
              onAttempt: async (attempt) => {
                try {
                  await bot.editMessageText(
                    `🔄 *Creating Position...*\n\n` +
                    `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
                    `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
                    `*Range:* ±${rangePercent}%\n\n` +
                    `⏳ Step 3.5/4: Topping up SOL for fees...\n\n` +
                    `🔁 Swapping ${currentPoolInfo.token0Symbol} → SOL (attempt ${attempt}/3)\n\n` +
                    `*Please wait...*`,
                    { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
                  );
                } catch (_) {}
              }
            });
            
            if (topUpResult.success) {
              swapResults.push({
                from: currentPoolInfo.token0Symbol,
                to: 'SOL',
                amountIn: swapAmountToken0,
                signature: topUpResult.signature
              });
              topUpSuccess = true;
              if (process.env.LOG_LEVEL === 'debug') {
                console.log(`✅ Topped up SOL successfully from ${currentPoolInfo.token0Symbol}`);
              }
              
              // Wait for swap to finalize
              await new Promise((r) => setTimeout(r, FINALIZATION_DELAY_MS));
            } else {
              console.warn(`Failed to top up SOL from ${currentPoolInfo.token0Symbol}: ${topUpResult.error}`);
            }
          } catch (topUpError) {
            console.warn(`Failed to top up SOL from ${currentPoolInfo.token0Symbol}:`, topUpError.message);
          }
        }
      }
      
      // If still not enough SOL after all attempts, throw clear error
      if (!topUpSuccess) {
        const finalSolBalance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
        if (finalSolBalance < (DEFAULT_MIN_SOL_RESERVE - SOL_RESERVE_BUFFER)) {
          pendingAddPosition.delete(telegramId);
          await bot.editMessageText(
            `❌ *Insufficient SOL for Transaction Fees*\n\n` +
            `Your wallet has *${finalSolBalance.toFixed(6)} SOL*, but needs at least *${DEFAULT_MIN_SOL_RESERVE} SOL* to cover transaction fees.\n\n` +
            `*What to do:*\n` +
            `• Top up your wallet with at least ${(DEFAULT_MIN_SOL_RESERVE - finalSolBalance + RECOMMENDED_SOL_BUFFER).toFixed(3)} SOL\n` +
            `• Or reduce the position size to free up tokens for swapping to SOL\n\n` +
            `*Tip:* Keep at least 0.1 SOL in your wallet for smooth operations.`,
            {
              chat_id: chatId,
              message_id: processingMsg.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '↻ Try Again', callback_data: 'addposition' }],
                  [{ text: '💰 Check Balance', callback_data: 'balance' }],
                  [{ text: '❓ Help', callback_data: 'help' }]
                ]
              }
            }
          );
          return;
        }
      }
    }

    // Update: Opening position
    await bot.editMessageText(
      `🔄 *Creating Position...*\n\n` +
      `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
      `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
      `*Range:* ±${rangePercent}%\n\n` +
      `⏳ Step 4/4: Opening position...\n\n` +
      `*Please wait...*`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown'
      }
    );
    
    // Calculate max amounts to use based on target USD
    // After swaps, we should have tokens available
    // Refresh pool info to get current balances after swaps
    const finalPoolInfo = await fetchPoolInfo(connection, poolPk, keypair.publicKey);
    
    // Calculate how much of each token to use based on target USD
    // Assume 50/50 split (openPosition will adjust to exact ratio)
    // Add 2% buffer to account for CLMM ratio variations
    const slippageBuffer = 1.02;
    const finalTargetToken0Usd = targetUsd * 0.5 * slippageBuffer;
    const finalTargetToken1Usd = targetUsd * 0.5 * slippageBuffer;
    
    // Calculate max amounts, ensuring we don't exceed available balance
    let maxToken0, maxToken1;
    
    if (isToken0Sol) {
      // Token0 is SOL/WSOL - use target USD / SOL price, capped by available balance
      maxToken0 = Math.min(
        finalTargetToken0Usd / solPrice,
        Math.max(0, finalPoolInfo.solBalance - DEFAULT_MIN_SOL_RESERVE)
      );
    } else {
      // Token0 is not SOL - use target USD / token price, capped by balance
      maxToken0 = Math.min(
        finalTargetToken0Usd / finalPoolInfo.token0Price,
        finalPoolInfo.token0Balance
      );
    }
    
    if (isToken1Sol) {
      // Token1 is SOL/WSOL (rare, but possible)
      maxToken1 = Math.min(
        finalTargetToken1Usd / solPrice,
        Math.max(0, finalPoolInfo.solBalance - DEFAULT_MIN_SOL_RESERVE)
      );
    } else {
      // Token1 is not SOL - use target USD / token price, capped by balance
      maxToken1 = Math.min(
        finalTargetToken1Usd / finalPoolInfo.token1Price,
        finalPoolInfo.token1Balance
      );
    }
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`Target USD: $${targetUsd}`);
      console.log(`Max Token0: ${maxToken0.toFixed(6)} ${finalPoolInfo.token0Symbol}`);
      console.log(`Max Token1: ${maxToken1.toFixed(6)} ${finalPoolInfo.token1Symbol}`);
    }
    
    // Guard: for symmetric range around current price, both sides must be > 0
    if (maxToken0 <= 0 || maxToken1 <= 0) {
      // Abort flow before attempting on-chain open
      pendingAddPosition.delete(telegramId);
      await bot.editMessageText(
        `❌ *Preparation Failed*
\n` +
        `Swaps did not provide sufficient tokens to open a symmetric position.
\n` +
        `Please try again by increasing swap slippage/priority or lowering the USD amount, then retry.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '↻ Retry with same settings', callback_data: 'addposition_retry' }],
              [{ text: '❓ Help', callback_data: 'help' }]
            ]
          }
        }
      );
      return;
    }
    
    // Open position with limited amounts (retry with increasing slippage)
    const result = await retryOpenPositionWithBackoff({
      connection,
      wallet: keypair,
      poolPk,
      idl: PANCAKESWAP_IDL,
      options: {
        rangePercent,
        slippageBps: DEFAULT_OPEN_POSITION_SLIPPAGE_BPS,
        minSolReserve: DEFAULT_MIN_SOL_RESERVE,
        maxToken0ToUse: maxToken0,
        maxToken1ToUse: maxToken1,
        tokenInfo: {
          token0Symbol: finalPoolInfo.token0Symbol,
          token1Symbol: finalPoolInfo.token1Symbol,
          token0Price: finalPoolInfo.token0Price,
          token1Price: finalPoolInfo.token1Price
        }
      },
      onAttempt: async (attempt) => {
        try {
          await bot.editMessageText(
            `🔄 *Creating Position...*\n\n` +
            `*Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
            `*Amount:* ${formatCurrency(pending.data.usdAmount)}\n` +
            `*Range:* ±${rangePercent}%\n\n` +
            `⏳ Step 4/4: Opening position...\n\n` +
            `🔁 Sending transaction (attempt ${attempt}/3)\n\n` +
            `*Please wait...*`,
            { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
          );
        } catch (_) {}
      }
    });

    // Auto-unwrap WSOL to native SOL if position involves WSOL
    // This returns any unused wrapped SOL back to the user's wallet
    let unwrappedSol = false;
    if (isToken0Sol || isToken1Sol) {
      const unwrapResult = await unwrapWSol(connection, keypair, {
        commitmentLevel: COMMITMENT_LEVEL
      });
      unwrappedSol = unwrapResult.success && unwrapResult.hadAccount;
    }

    // Clear pending operation
    pendingAddPosition.delete(telegramId);
    
    if (!result.success) {
      const rawError = result.error || 'Unknown error occurred';
      // Special-case: insufficient SOL reserve for fees
      if (rawError.includes('Insufficient SOL balance. Need at least')) {
        const required = rawError.match(/at least ([0-9.]+) SOL/)?.[1] || String(DEFAULT_MIN_SOL_RESERVE);
        const currentBalance = await getSolanaBalance(keypair.publicKey.toBase58());
        await bot.editMessageText(
          `❌ *Insufficient SOL for Fees*\n\n` +
          `Your SOL balance of *${currentBalance} SOL* is below the required reserve to open a position.\n\n` +
          `*Required:* ${required} SOL (fee reserve)\n` +
          `*What to do:*\n` +
          `• Top up wallet to ≥ ${required} SOL (recommend +${RECOMMENDED_SOL_BUFFER} SOL buffer)\n` +
          `• Or lower the fee reserve in advanced settings (minSolReserve)\n\n` +
          `After topping up, try again.`,
          {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '↻ Try Again', callback_data: 'addposition' }],
                [{ text: '📊 View Positions', callback_data: 'positions' }]
              ]
            }
          }
        );
        return;
      }

      const errorMsg = formatUserFriendlyError(rawError);
      
      await bot.editMessageText(
        `❌ *Position Creation Failed*\n\n` +
        `${errorMsg}\n\n` +
        `💡 *Try:*\n` +
        `• Lower amount\n` +
        `• Different price range\n` +
        `• Wait and retry\n\n` +
        `Need help? Contact support.`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '↻ Retry with same settings', callback_data: 'addposition_retry' }],
              [{ text: '📊 View Positions', callback_data: 'positions' }],
              [{ text: '❓ Help', callback_data: 'help' }]
            ]
          }
        }
      );
      return;
    }
    
    // Auto-track the position in database for alerts and monitoring
    try {
      // Capture SOL price for P/L tracking
      let solPriceAtOpen = null;
      try {
        const solInfo = await getTokenInfo(KNOWN_TOKENS.SOL.mint);
        solPriceAtOpen = solInfo.price;
      } catch (priceErr) {
        console.warn('Failed to capture SOL price for P/L tracking:', priceErr.message);
      }
      
      await upsertPosition({
        wallet_id: wallet.id,
        nft_mint: result.positionNftMint,
        pool_address: poolPk.toBase58(),
        token0_mint: finalPoolInfo.mint0.toBase58(),
        token1_mint: finalPoolInfo.mint1.toBase58(),
        token0_symbol: finalPoolInfo.token0Symbol,
        token1_symbol: finalPoolInfo.token1Symbol,
        fee_tier: null,
        lower_price: result.priceRange.lower,
        upper_price: result.priceRange.upper,
        current_price: result.priceRange.current,
        liquidity_value_usd: result.estimatedUsd,
        range_percent: rangePercent,
        status: 'active'
      }, { sol_price_at_open: solPriceAtOpen });
      if (process.env.LOG_LEVEL === 'debug') {
        console.log(`✅ Position ${result.positionNftMint} auto-tracked in database`);
      }
    } catch (dbError) {
      // Don't fail the whole operation if DB save fails - user can still see position via /positions
      console.warn('Failed to auto-track position in database:', dbError.message);
    }
    
    // Build swap transactions note
    let swapTransactionsText = '';
    if (swapResults && swapResults.length > 0) {
      swapTransactionsText = `\n*Swaps Executed:*\n`;
      for (const swap of swapResults) {
        const swapAmount = swap.amountIn ? formatTokenAmount(swap.amountIn) : '';
        swapTransactionsText += `• ${swap.from} → ${swap.to}${swapAmount ? ` (${swapAmount})` : ''}\n`;
        if (swap.signature) {
          swapTransactionsText += `  🔗 [View swap](https://solscan.io/tx/${swap.signature})\n`;
        }
      }
      swapTransactionsText += `\n`;
    }

    // Show success message
    await bot.editMessageText(
      `✅ *Position Created Successfully!*\n\n` +
      `💧 *Pool:* ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}\n` +
      `*Position NFT:* \`${formatShortAddress(result.positionNftMint)}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `*Price Range:*\n` +
      `• Lower: ${result.priceRange.lower.toFixed(4)} ${poolInfo.token1Symbol}\n` +
      `• Current: ${result.priceRange.current.toFixed(4)} ${poolInfo.token1Symbol}\n` +
      `• Upper: ${result.priceRange.upper.toFixed(4)} ${poolInfo.token1Symbol}\n` +
      `• Range: ±${rangePercent}%\n\n` +
      `*Value:*\n` +
      `• Deposited: ${formatCurrency(result.estimatedUsd)}\n` +
      `• Liquidity: ${result.liquidityAdded}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${swapTransactionsText}` +
      `*Position Transaction:*\n` +
      `🔗 [View on Solscan](${result.explorer})\n\n` +
      `Your position is now active and earning fees! 🎉`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 View All Positions', callback_data: 'positions' }],
            [{ text: '💰 Check Rewards', callback_data: 'rewards' }],
            [{ text: '➕ Add Another Position', callback_data: 'addposition' }]
          ]
        }
      }
    );
    
    // Send the persistent reply keyboard with pool buttons
    try {
      await updatePoolsReplyKeyboard(bot, chatId, wallet.wallet_address);
    } catch (keyboardError) {
      console.warn('Failed to send reply keyboard:', keyboardError.message);
    }
    
    // Clear saved settings on success
    try { lastAddPositionSettings.delete(telegramId); } catch (_) {}
    
  } catch (error) {
    console.error('Error creating position:', error);
    
    // Clear pending operation
    pendingAddPosition.delete(telegramId);
    
    const errorMsg = formatUserFriendlyError(error.message || 'Unknown error occurred');
    
    await bot.editMessageText(
      `❌ *Error Creating Position*\n\n` +
      `${errorMsg}\n\n` +
      `Please try again or contact support if the issue persists.`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '↻ Retry with same settings', callback_data: 'addposition_retry' }],
            [{ text: '❓ Help', callback_data: 'help' }]
          ]
        }
      }
    );
  }
}

/**
 * Check if user has pending add position operation
 * 
 * @param {number} telegramId - Telegram user ID
 * @returns {boolean} True if pending operation exists
 */
export function hasPendingAddPosition(telegramId) {
  return pendingAddPosition.has(telegramId);
}

/**
 * Cancel pending add position operation
 * 
 * @param {number} telegramId - Telegram user ID
 */
export function cancelPendingAddPosition(telegramId) {
  pendingAddPosition.delete(telegramId);
}

/**
 * Handle addposition callback (from inline button)
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleAddPositionCallback(bot, callbackQuery) {
  await bot.answerCallbackQuery(callbackQuery.id, {
    text: '➕ Starting add position...'
  });
  
  // Create synthetic message
  const syntheticMsg = {
    chat: { id: callbackQuery.message.chat.id },
    from: { id: callbackQuery.from.id }
  };
  
  await handleAddPosition(bot, syntheticMsg);
}

/**
 * Handle retry button for addposition (reuse last saved settings)
 */
export async function handleAddPositionRetry(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;
  
  try {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '↻ Retrying...' });
    // Immediately minimize the current message to keep UX clean
    try {
      await bot.editMessageText(
        '⏳ Preparing...',
        {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [] }
        }
      );
    } catch (_) {
      try { await bot.deleteMessage(chatId, callbackQuery.message.message_id); } catch (_) {}
    }
    const last = lastAddPositionSettings.get(telegramId);
    if (!last || !last.poolPk || !last.usdAmount || !last.rangePercent) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ No saved settings. Starting over.', show_alert: true });
      const syntheticMsg = { chat: { id: chatId }, from: { id: telegramId } };
      await handleAddPosition(bot, syntheticMsg);
      return;
    }
    
    // Rehydrate minimal pending state with fresh pool info
    const connection = new Connection(process.env.SOLANA_RPC_URL, COMMITMENT_LEVEL);
    const wallet = await getActiveWalletWithEncryption(telegramId);
    const walletPk = new PublicKey(wallet.wallet_address);
    const poolPk = new PublicKey(last.poolPk);
    const poolInfo = await fetchPoolInfo(connection, poolPk, walletPk);
    
    const pending = { step: 'range', chatId, data: { poolPk: last.poolPk, usdAmount: last.usdAmount, poolInfo } };
    pendingAddPosition.set(telegramId, pending);
    
    const syntheticMsg = { chat: { id: chatId }, from: { id: telegramId } };
    await handleRangePercent(bot, syntheticMsg, String(last.rangePercent), pending);
  } catch (err) {
    console.error('Error in handleAddPositionRetry:', err);
    await bot.answerCallbackQuery(callbackQuery.id, { text: `❌ ${err?.message || 'Error'}`, show_alert: true });
  }
}

/**
 * Handle quick-select pool buttons for Step 1
 */
export async function handleAddPositionPoolSelect(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;

  try {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '🔄 Fetching pool info...' });

    let pending = pendingAddPosition.get(telegramId);
    if (!pending) {
      pending = { step: 'pool', chatId, data: {} };
      pendingAddPosition.set(telegramId, pending);
    }

    const poolAddress = callbackQuery.data.replace('addposition_pool_', '');
    const syntheticMsg = { chat: { id: chatId }, from: { id: telegramId } };

    await handlePoolAddress(bot, syntheticMsg, poolAddress, pending);
  } catch (err) {
    console.error('Error in handleAddPositionPoolSelect:', err);
    await bot.answerCallbackQuery(callbackQuery.id, { text: `❌ ${err?.message || 'Error'}`, show_alert: true });
  }
}

/**
 * Handle cancel button for addposition flow
 */
export async function handleAddPositionCancel(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const telegramId = callbackQuery.from.id;

  try {
    pendingAddPosition.delete(telegramId);
    try { lastAddPositionSettings.delete(telegramId); } catch (_) {}
    await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Cancelled' });
    try {
      await bot.editMessageText(
        '✅ Operation cancelled.',
        {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          parse_mode: 'Markdown'
        }
      );
    } catch (_) {}
  } catch (err) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: `❌ ${err?.message || 'Error'}`, show_alert: true });
  }
}

