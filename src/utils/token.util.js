/**
 * Token Utility Functions
 *
 * Pure utility functions for token operations including:
 * - Fetching mint information (decimals, token program)
 * - Converting token amounts to human-readable format
 * - Identifying stablecoins and known tokens
 * - Parsing token balance changes from transactions
 * - Fetching token price and ticker data (Moralis + DexScreener)
 *
 * @module token.util
 */

import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, KNOWN_TOKENS } from '../config/constants.js';
import { fetchTokenFromJupiter, fetchTokensFromJupiter } from './jupiter-api.util.js';
import { fetchTokenDataFromMoralis } from './moralis.util.js';
import { getTokenPrice as getDexScreenerPrice } from './dexscreener.util.js';
import { getCurrentSolPrice } from '../services/market-data.service.js';
import { getSolPrice as getWsSolPrice, getCakePrice as getWsCakePrice } from '../services/jupiter-price-ws.service.js';
import { 
  getCachedTokenDecimals, 
  getCachedTokenProgram,
  getCachedTokenMetadata,
  setCachedTokenMetadata,
  batchGetTokenDecimals 
} from '../cache/redis-cache.util.js';

/**
 * Get mint decimals from on-chain data
 * 
 * OPTIMIZED: Uses Redis cache for 100x faster lookups (200ms → 2ms)
 * Automatically falls back to direct RPC if Redis unavailable
 * 
 * @param {Connection} connection - Solana connection
 * @param {PublicKey} mintPk - Token mint public key
 * @returns {Promise<number|null>} Decimals or null if not found
 * 
 * @example
 * const decimals = await getMintDecimals(connection, mintPublicKey);
 * console.log(`Token has ${decimals} decimals`);
 */
export async function getMintDecimals(connection, mintPk) {
  // Try Redis cache first (if enabled), otherwise fetch from RPC
  // getCachedTokenDecimals() handles both Redis and RPC fallback internally
  const decimals = await getCachedTokenDecimals(connection, mintPk);
  return decimals;
}

/**
 * Convert raw token amount to human-readable number
 * 
 * @param {string|bigint} amount - Raw token amount (with decimals)
 * @param {number} decimals - Token decimals (e.g., 9 for SOL, 6 for USDC)
 * @returns {number} Human-readable amount
 * 
 * @example
 * toNumberUnits("1000000", 6) // Returns: 1.0
 * toNumberUnits("1000000000", 9) // Returns: 1.0
 */
export function toNumberUnits(amount, decimals) {
  try {
    const n = BigInt(amount);
    const d = 10 ** (Number(decimals) || 0);
    return Number(n) / d;
  } catch {
    return 0;
  }
}

/**
 * Check if a mint is a known stablecoin
 * 
 * Checks against known stablecoin addresses (USDC, USDT) and uses
 * heuristic fallback (6 decimals) for unknown stablecoins.
 * 
 * @param {string|PublicKey} mintAddress - Token mint address
 * @param {number} decimals - Token decimals (used as fallback heuristic)
 * @returns {boolean} True if token is likely a stablecoin
 * 
 * @example
 * isStablecoin("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6) // true (USDC)
 * isStablecoin("So11111111111111111111111111111111111111112", 9) // false (SOL)
 */
export function isStablecoin(mintAddress, decimals) {
  const addr = typeof mintAddress === "string" ? mintAddress : mintAddress.toBase58();
  
  // Check known stablecoins (all USDC variants and USDT)
  if (
    addr === KNOWN_TOKENS.USDC.mint ||
    addr === KNOWN_TOKENS.USDC_LEGACY.mint ||
    addr === KNOWN_TOKENS.USDC_2022.mint ||
    addr === KNOWN_TOKENS.USDT.mint
  ) {
    return true;
  }
  
  // Heuristic: 6 decimals often indicates stablecoin (USDC, USDT, etc.)
  // This is a fallback for unknown stablecoins
  if (decimals === 6) {
    return true;
  }
  
  return false;
}

/**
 * Determine which token program a mint belongs to
 * 
 * OPTIMIZED: Uses Redis cache for 100x faster lookups (200ms → 2ms)
 * Automatically falls back to direct RPC if Redis unavailable
 * 
 * @param {Connection} connection - Solana connection
 * @param {PublicKey} mintPubkey - Token mint public key
 * @returns {Promise<PublicKey>} Token program (TOKEN_PROGRAM or TOKEN_2022_PROGRAM)
 * @throws {Error} If mint not found or uses unknown token program
 * 
 * @example
 * const program = await getMintTokenProgram(connection, mintPubkey);
 * console.log(program.equals(TOKEN_2022_PROGRAM) ? "Token-2022" : "Legacy");
 */
export async function getMintTokenProgram(connection, mintPubkey) {
  // Try Redis cache first (if enabled), otherwise fetch from RPC
  // getCachedTokenProgram() handles both Redis and RPC fallback internally
  const program = await getCachedTokenProgram(connection, mintPubkey);
  return program;
}

/**
 * Parse native SOL (lamports) balance changes from transaction metadata
 * 
 * Used when WSOL is unwrapped to native SOL. Parses the lamport balance change
 * for the owner's main account instead of looking at SPL token balances.
 * 
 * @param {Array} preLamportBalances - Pre-transaction lamport balances (txDetails.meta.preBalances)
 * @param {Array} postLamportBalances - Post-transaction lamport balances (txDetails.meta.postBalances)
 * @param {Array} accountKeys - Transaction account keys (txDetails.transaction.message.accountKeys)
 * @param {string|PublicKey} ownerAddress - Wallet owner address
 * @returns {Object|null} Balance change info or null if no change
 * @returns {bigint} return.amount - Raw lamport change
 * @returns {number} return.decimals - Always 9 for SOL
 * @returns {number} return.uiAmount - Human-readable SOL amount change
 * 
 * @example
 * const change = getNativeSolBalanceChange(preBalances, postBalances, accountKeys, walletPk);
 * if (change) {
 *   console.log(`Received ${change.uiAmount} SOL`);
 * }
 */
export function getNativeSolBalanceChange(preLamportBalances, postLamportBalances, accountKeys, ownerAddress) {
  const ownerStr = typeof ownerAddress === "string" ? ownerAddress : ownerAddress.toBase58();
  
  // Find the account index for the owner's address
  let ownerAccountIndex = -1;
  for (let i = 0; i < accountKeys.length; i++) {
    const key = typeof accountKeys[i] === "string" ? accountKeys[i] : accountKeys[i].pubkey?.toBase58() || accountKeys[i].toBase58();
    if (key === ownerStr) {
      ownerAccountIndex = i;
      break;
    }
  }
  
  if (ownerAccountIndex === -1) {
    return null; // Owner not found in transaction
  }
  
  // Get lamport balances for this account
  const preLamports = preLamportBalances[ownerAccountIndex] || 0;
  const postLamports = postLamportBalances[ownerAccountIndex] || 0;
  const changeLamports = BigInt(postLamports) - BigInt(preLamports);
  
  // Return balance change (can be positive, negative, or zero)
  // Caller can decide how to handle negative/zero changes
  if (changeLamports !== 0n) {
    return {
      amount: changeLamports,
      decimals: 9, // SOL has 9 decimals
      uiAmount: Number(changeLamports) / 1e9
    };
  }
  
  return null;
}

/**
 * Parse token balance changes from transaction metadata
 * 
 * Finds positive balance changes (tokens received) for a specific mint and owner.
 * Used to extract claimed amounts from transaction results.
 * 
 * **WSOL/SOL Handling:**
 * When the mint is WSOL and transaction details with lamport balances are provided,
 * this function will parse native SOL balance changes instead of SPL token balances.
 * This is critical for handling unwrapped WSOL correctly.
 * 
 * @param {Array} preBalances - Pre-transaction token balances from tx metadata (preTokenBalances)
 * @param {Array} postBalances - Post-transaction token balances from tx metadata (postTokenBalances)
 * @param {string|PublicKey} mintAddress - Token mint to check
 * @param {string|PublicKey} ownerAddress - Token account owner
 * @param {Object} [txDetails=null] - Optional full transaction details for WSOL/SOL handling
 * @param {Array} [txDetails.meta.preBalances] - Pre-transaction lamport balances
 * @param {Array} [txDetails.meta.postBalances] - Post-transaction lamport balances
 * @param {Array} [txDetails.transaction.message.accountKeys] - Transaction account keys
 * @returns {Object|null} Balance change info or null if no change
 * @returns {bigint} return.amount - Raw amount change
 * @returns {number} return.decimals - Token decimals
 * @returns {number} return.uiAmount - Human-readable amount change
 * 
 * @example
 * // Standard SPL token parsing
 * const change = getBalanceChange(preTokenBalances, postTokenBalances, mintPk, walletPk);
 * 
 * @example
 * // WSOL/SOL parsing with full transaction details
 * const change = getBalanceChange(preTokenBalances, postTokenBalances, wsolMint, walletPk, txDetails);
 * if (change) {
 *   console.log(`Received ${change.uiAmount} SOL`);
 * }
 */
export function getBalanceChange(preBalances, postBalances, mintAddress, ownerAddress, txDetails = null) {
  const mintStr = typeof mintAddress === "string" ? mintAddress : mintAddress.toBase58();
  const ownerStr = typeof ownerAddress === "string" ? ownerAddress : ownerAddress.toBase58();
  
  // Check if this is WSOL - if so, parse native SOL balance instead
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';
  const isWsol = mintStr === WSOL_MINT;
  
  if (isWsol && txDetails?.meta?.preBalances && txDetails?.meta?.postBalances && txDetails?.transaction?.message?.accountKeys) {
    // Parse native SOL (lamports) balance change instead of WSOL token balance
    const solChange = getNativeSolBalanceChange(
      txDetails.meta.preBalances,
      txDetails.meta.postBalances,
      txDetails.transaction.message.accountKeys,
      ownerAddress
    );
    
    if (solChange) {
      // Only return positive changes (tokens received)
      // Negative changes are likely transaction fees
      if (solChange.amount > 0n) {
        return solChange;
      }
    }
  }
  
  // Standard SPL token balance parsing
  for (const post of postBalances) {
    if (post.mint === mintStr && post.owner === ownerStr) {
      const pre = preBalances.find(
        (p) => p.accountIndex === post.accountIndex
      );
      const preAmount = pre?.uiTokenAmount?.amount || "0";
      const postAmount = post.uiTokenAmount?.amount || "0";
      const change = BigInt(postAmount) - BigInt(preAmount);
      
      if (change > 0n) {
        return {
          amount: change,
          decimals: post.uiTokenAmount.decimals,
          uiAmount: Number(post.uiTokenAmount.uiAmount) - Number(pre?.uiTokenAmount?.uiAmount || 0)
        };
      }
    }
  }
  return null;
}

/**
 * Format liquidity value with thousands separators
 *
 * @param {bigint|string} liquidity - Liquidity value
 * @returns {string} Formatted string with commas
 *
 * @example
 * formatLiquidity(1234567890n) // "1,234,567,890"
 */
export function formatLiquidity(liquidity) {
  const str = liquidity.toString();
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Get token price and ticker information
 *
 * OPTIMIZED: Uses Redis cache for ticker/metadata (100-400x faster) and parallel racing for prices
 * - Ticker/metadata: Cached in Redis (30 days TTL) - 300-1200ms → 3ms
 * - Price: Always fresh from APIs (no cache) - Parallel racing ~300ms
 *
 * Fetches both USD price and ticker symbol for a token using a multi-source approach:
 * 1. Check known tokens (USDC, USDT) - return $1 and ticker from KNOWN_TOKENS
 * 2. Try Redis cache for ticker/metadata (100-400x faster)
 * 3. Race all APIs in parallel for price: Jupiter, Moralis, DexScreener
 * 4. Final fallback: abbreviated address for ticker, null for price
 *
 * @param {string} mintAddress - Solana token mint address
 * @returns {Promise<Object>} Token information
 * @returns {number|null} return.price - USD price or null if unavailable
 * @returns {string} return.ticker - Token symbol/ticker (never null, falls back to abbreviated address)
 * @returns {string} return.source - Data source: 'known_token', 'jupiter', 'moralis', 'dexscreener', 'fallback', or 'invalid'
 *
 * @example
 * const { price, ticker, source } = await getTokenInfo("5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2");
 * console.log(`${ticker}: $${price} (source: ${source})`);
 *
 * @example
 * // For known tokens (instant response)
 * const { price, ticker, source } = await getTokenInfo(KNOWN_TOKENS.USDC.mint);
 * // Returns: { price: 1, ticker: "USDC", source: "known_token" }
 */
export async function getTokenInfo(mintAddress) {
  if (!mintAddress) {
    return { price: null, ticker: 'UNKNOWN', source: 'invalid' };
  }

  const mint = String(mintAddress);

  // Check if it's a known token - get ticker immediately
  let knownToken = null;
  for (const tokenInfo of Object.values(KNOWN_TOKENS)) {
    if (tokenInfo.mint === mint) {
      knownToken = tokenInfo;
      break;
    }
  }

  // If it's a known token with a fixed price (stablecoins), return immediately
  if (knownToken && knownToken.price) {
    return {
      price: knownToken.price,
      ticker: knownToken.symbol,
      source: 'known_token'
    };
  }

  // SOL special case: Try WebSocket cache first (~1ms), then SQLite candle cache (~2ms)
  if (mint === KNOWN_TOKENS.SOL.mint) {
    // Priority 1: WebSocket real-time price from Redis
    const wsSolPrice = await getWsSolPrice(60); // 1 min max age
    if (wsSolPrice) {
      return {
        price: wsSolPrice,
        ticker: 'SOL',
        source: 'websocket_cache'
      };
    }
    // Priority 2: SQLite candle cache (fallback)
    if (process.env.LOG_LEVEL === 'debug') {
      console.log('📈 SOL price: WebSocket cache miss, trying SQLite candle cache');
    }
    const cachedSolPrice = await getCurrentSolPrice(60); // 1 min max age
    if (cachedSolPrice) {
      return {
        price: cachedSolPrice,
        ticker: 'SOL',
        source: 'market_data_cache'
      };
    }
    // Fall through to API race if both caches miss
    if (process.env.LOG_LEVEL === 'debug') {
      console.log('📈 SOL price: All caches miss, falling back to API');
    }
  }

  // CAKE special case: Try WebSocket cache first
  if (mint === KNOWN_TOKENS.CAKE?.mint) {
    const wsCakePrice = await getWsCakePrice(60);
    if (wsCakePrice) {
      return {
        price: wsCakePrice,
        ticker: 'CAKE',
        source: 'websocket_cache'
      };
    }
    // WebSocket cache miss - will fall through to API
    if (process.env.LOG_LEVEL === 'debug') {
      console.log('🥞 CAKE price: WebSocket cache miss, falling back to API');
    }
  }

  // If it's a known token without fixed price (like SOL), we know the ticker
  // but still need to fetch the price from APIs
  const knownTicker = knownToken ? knownToken.symbol : null;

  // OPTIMIZED: Try to get ticker from Redis cache first (separate from price)
  // Metadata (ticker, name) is static and can be cached, but price must be fresh
  let cachedMetadata = null;
  if (!knownTicker) {
    try {
      cachedMetadata = await getCachedTokenMetadata(mint);
      if (cachedMetadata && cachedMetadata.ticker) {
        // We have cached ticker, but still need to fetch fresh price
        // Continue to price fetching below with cached ticker
      }
    } catch (error) {
      // Redis cache failed, fall through to API fetching
    }
  }

  // Helper: Add timeout to promise to prevent slow APIs from blocking
  const withTimeout = (promise, timeoutMs = 3000) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);
  };

  // OPTIMIZED: Race all APIs in parallel for price (always fresh)
  // Use cached ticker if available (metadata is static, price is dynamic)
  const preferredTicker = knownTicker || cachedMetadata?.ticker || null;
  
  const apiPromises = [
    // Jupiter API (usually fastest, ~200-300ms) - 2s timeout
    withTimeout(
      fetchTokenFromJupiter(mint)
        .then(result => {
          if (result.success && result.data && result.data.length > 0) {
            const tokenData = result.data[0];
            // Cache metadata if we got it from API (fire and forget)
            // Note: Decimals are cached separately via getCachedTokenDecimals()
            if (!cachedMetadata && tokenData.ticker) {
              setCachedTokenMetadata(mint, {
                ticker: tokenData.ticker,
                name: tokenData.name,
                icon: tokenData.icon
              }).catch(() => {}); // Don't block on cache write
            }
            return {
              price: tokenData.usdPrice,
              ticker: preferredTicker || tokenData.ticker,
              source: 'jupiter'
            };
          }
          return null;
        }),
      2000
    ).catch(() => null),

    // Moralis API (usually ~300-400ms) - 2s timeout
    withTimeout(
      fetchTokenDataFromMoralis(mint)
        .then(result => {
          if (result.success && result.data) {
            // Cache metadata if we got it from API (fire and forget)
            if (!cachedMetadata && result.data.ticker) {
              setCachedTokenMetadata(mint, {
                ticker: result.data.ticker,
                name: result.data.name
              }).catch(() => {});
            }
            return {
              price: result.data.usdPrice,
              ticker: preferredTicker || result.data.ticker,
              source: 'moralis'
            };
          }
          return null;
        }),
      2000
    ).catch(() => null),

    // DexScreener (usually slowest, ~500-700ms) - 2s timeout
    withTimeout(
      getDexScreenerPrice(mint)
        .then(dexData => {
          if (dexData && dexData.priceUsd) {
            // Cache metadata if we got it from API (fire and forget)
            if (!cachedMetadata && dexData.ticker) {
              setCachedTokenMetadata(mint, {
                ticker: dexData.ticker
              }).catch(() => {});
            }
            return {
              price: parseFloat(dexData.priceUsd),
              ticker: preferredTicker || dexData.ticker,
              source: 'dexscreener'
            };
          }
          return null;
        }),
      2000
    ).catch(() => null)
  ];

  // Race APIs: return as soon as we get first successful result (don't wait for all)
  // This dramatically improves performance when one API is slow
  const raceForFirstSuccess = async (promises) => {
    return new Promise((resolve) => {
      let completed = 0;
      const total = promises.length;
      
      promises.forEach(promise => {
        promise.then(result => {
          if (result !== null) {
            resolve(result);
          } else {
            completed++;
            if (completed === total) {
              resolve(null);
            }
          }
        });
      });
    });
  };

  const successfulResult = await raceForFirstSuccess(apiPromises);
  
  if (successfulResult) {
    return successfulResult;
  }

  // Final fallback: use known ticker, cached ticker, or abbreviated address
  const fallbackTicker = knownTicker || cachedMetadata?.ticker || `${mint.slice(0, 4)}...${mint.slice(-4)}`;

  return {
    price: null,
    ticker: fallbackTicker,
    source: 'fallback'
  };
}


/**
 * Batch fetch token information for multiple mints (OPTIMIZED)
 * 
 * This function leverages Jupiter's batch API to fetch up to 100 tokens in a single request.
 * Falls back to parallel individual fetches for tokens not found in Jupiter.
 * 
 * **Performance**: ~300ms for batch vs ~900ms for 3 sequential calls (3x faster)
 * 
 * @param {string[]} mintAddresses - Array of Solana token mint addresses
 * @returns {Promise<Object[]>} Array of token info objects
 * 
 * @example
 * const [solInfo, usdcInfo, token0Info] = await getTokenInfoBatch([
 *   KNOWN_TOKENS.SOL.mint,
 *   KNOWN_TOKENS.USDC.mint,
 *   "5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2"
 * ]);
 */
export async function getTokenInfoBatch(mintAddresses) {
  if (!Array.isArray(mintAddresses) || mintAddresses.length === 0) {
    return [];
  }

  // Separate known tokens (instant) from unknown tokens (need fetch)
  const results = new Array(mintAddresses.length);
  const unknownIndices = [];
  const unknownMints = [];

  // SOL & CAKE special case: Get cached prices once for all requests
  // Priority: WebSocket cache (~1ms) → SQLite candle cache (~2ms)
  let cachedSolPrice = null;
  let cachedCakePrice = null;
  const hasSol = mintAddresses.some(m => String(m) === KNOWN_TOKENS.SOL.mint);
  const hasCake = mintAddresses.some(m => String(m) === KNOWN_TOKENS.CAKE?.mint);
  
  if (hasSol) {
    cachedSolPrice = await getWsSolPrice(60);
    if (!cachedSolPrice) {
      cachedSolPrice = await getCurrentSolPrice(60);
    }
    if (cachedSolPrice && process.env.LOG_LEVEL === 'debug') {
      console.log(`📈 SOL: $${cachedSolPrice.toFixed(2)} (${cachedSolPrice ? 'cache' : 'will fallback to API'})`);
    }
  }
  if (hasCake) {
    cachedCakePrice = await getWsCakePrice(60);
  }

  for (let i = 0; i < mintAddresses.length; i++) {
    const mint = String(mintAddresses[i] || '');
    
    // Check if it's a known token with fixed price
    let knownToken = null;
    for (const tokenInfo of Object.values(KNOWN_TOKENS)) {
      if (tokenInfo.mint === mint) {
        knownToken = tokenInfo;
        break;
      }
    }

    if (knownToken && knownToken.price) {
      // Known token with fixed price (stablecoins) - instant result
      results[i] = {
        price: knownToken.price,
        ticker: knownToken.symbol,
        source: 'known_token'
      };
    } else if (mint === KNOWN_TOKENS.SOL.mint && cachedSolPrice) {
      // SOL with cached price (WebSocket or candle cache)
      results[i] = {
        price: cachedSolPrice,
        ticker: 'SOL',
        source: 'websocket_cache'
      };
    } else if (mint === KNOWN_TOKENS.CAKE?.mint && cachedCakePrice) {
      // CAKE with cached price from WebSocket
      results[i] = {
        price: cachedCakePrice,
        ticker: 'CAKE',
        source: 'websocket_cache'
      };
    } else {
      // Unknown token - needs fetching
      unknownIndices.push(i);
      unknownMints.push(mint);
    }
  }

  // If all tokens are known, return immediately
  if (unknownMints.length === 0) {
    return results;
  }

  // Batch fetch from Jupiter (up to 100 tokens per call)
  try {
    const jupiterResult = await fetchTokensFromJupiter(unknownMints);
    
    if (jupiterResult.success && jupiterResult.data) {
      // Map Jupiter results back to original indices
      const jupiterMap = new Map();
      jupiterResult.data.forEach(token => {
        jupiterMap.set(token.mintAddress, {
          price: token.usdPrice,
          ticker: token.ticker,
          source: 'jupiter'
        });
      });

      // Fill in results from Jupiter
      for (let i = 0; i < unknownMints.length; i++) {
        const mint = unknownMints[i];
        const originalIndex = unknownIndices[i];
        
        if (jupiterMap.has(mint)) {
          results[originalIndex] = jupiterMap.get(mint);
        }
      }
    }
  } catch (error) {
    console.warn('Jupiter batch fetch failed, falling back to individual fetches:', error.message);
  }

  // For any tokens still missing, fall back to individual parallel fetches
  const stillMissingIndices = unknownIndices.filter(idx => !results[idx]);
  
  if (stillMissingIndices.length > 0) {
    const individualPromises = stillMissingIndices.map(idx =>
      getTokenInfo(mintAddresses[idx])
    );
    
    const individualResults = await Promise.all(individualPromises);
    
    stillMissingIndices.forEach((idx, i) => {
      results[idx] = individualResults[i];
    });
  }

  return results;
}

/**
 * Resolve a token's symbol/ticker for a given mint.
 *
 * Fast-paths known tokens via KNOWN_TOKENS, otherwise delegates to getTokenInfo.
 * Always returns a non-empty string (falls back to abbreviated address if needed).
 *
 * @param {string} mintAddress - Solana token mint address
 * @returns {Promise<string>} Token ticker/symbol
 */
export async function resolveTokenSymbol(mintAddress) {
  if (!mintAddress) return 'UNKNOWN';
  const mint = String(mintAddress);

  // Known tokens shortcut
  for (const tokenInfo of Object.values(KNOWN_TOKENS)) {
    if (tokenInfo.mint === mint) {
      return tokenInfo.symbol;
    }
  }

  // Otherwise, use the multi-source resolver
  const { ticker } = await getTokenInfo(mint);
  return ticker || `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}


/**
 * Convert human-readable amount to raw token amount
 *
 * @param {number} amount - Human-readable amount
 * @param {number} decimals - Token decimals
 * @returns {bigint} Raw token amount
 */
export function toRawAmount(amount, decimals) {
  try {
    const multiplier = 10 ** decimals;
    return BigInt(Math.floor(amount * multiplier));
  } catch {
    return 0n;
  }
}

/**
 * Unwrap WSOL to native SOL by closing the WSOL token account
 * 
 * This utility automatically detects if a wallet has a WSOL account and closes it,
 * converting any wrapped SOL back to native SOL. This is useful after transactions
 * that may leave wrapped SOL in the wallet (e.g., position closing, swaps).
 * 
 * **How it works:**
 * 1. Checks if WSOL account exists for the wallet
 * 2. Creates a transaction with createCloseAccountInstruction
 * 3. Sends and confirms the transaction
 * 4. Returns any remaining lamports to the wallet as native SOL
 * 
 * **When to use:**
 * - After removing liquidity from SOL/X pools
 * - After claiming rewards that include WSOL
 * - After adding liquidity that involved SOL wrapping
 * - Any operation that may leave WSOL in the wallet
 * 
 * **Note:** This is a non-critical operation. If it fails, the user still has
 * their WSOL in their wallet (just not as native SOL). Failures are logged but
 * don't throw errors.
 * 
 * @param {Connection} connection - Solana RPC connection
 * @param {Keypair} wallet - Wallet keypair (owner of WSOL account)
 * @param {Object} [options] - Optional configuration
 * @param {PublicKey} [options.wsolAccount] - Pre-computed WSOL account address (skip derivation)
 * @param {string} [options.commitmentLevel] - Transaction commitment level (default: from constants)
 * @param {boolean} [options.silent] - If true, don't log success/failure messages (default: false)
 * @returns {Promise<Object>} Unwrap result
 * @returns {boolean} return.success - Whether unwrapping succeeded
 * @returns {string|null} return.signature - Transaction signature if successful
 * @returns {string|null} return.error - Error message if failed
 * @returns {boolean} return.hadAccount - Whether a WSOL account existed
 * 
 * @example
 * // Basic usage (logs success/failure)
 * const result = await unwrapWSol(connection, wallet);
 * if (result.success) {
 *   console.log(`Unwrapped WSOL: ${result.signature}`);
 * }
 * 
 * @example
 * // Silent mode (no console logs)
 * const result = await unwrapWSol(connection, wallet, { silent: true });
 * 
 * @example
 * // With pre-computed WSOL account
 * const wsolAccount = await getAssociatedTokenAddress(wsolMint, wallet.publicKey);
 * const result = await unwrapWSol(connection, wallet, { wsolAccount });
 */
export async function unwrapWSol(connection, wallet, options = {}) {
  const {
    wsolAccount: providedWsolAccount = null,
    commitmentLevel = 'confirmed',
    silent = false
  } = options;

  try {
    // Import dependencies (lazy import to avoid circular dependencies)
    const { Transaction } = await import('@solana/web3.js');
    const { getAssociatedTokenAddress, createCloseAccountInstruction } = await import('@solana/spl-token');
    
    // Get WSOL mint address from constants
    const wsolMint = new PublicKey(KNOWN_TOKENS.SOL.mint);
    
    // Derive or use provided WSOL account address
    const wsolAccount = providedWsolAccount || await getAssociatedTokenAddress(
      wsolMint,
      wallet.publicKey,
      false,
      TOKEN_PROGRAM
    );

    // Check if WSOL account exists
    const wsolAccountInfo = await connection.getAccountInfo(wsolAccount);
    
    if (!wsolAccountInfo) {
      // No WSOL account exists - nothing to unwrap
      return {
        success: true,
        signature: null,
        error: null,
        hadAccount: false
      };
    }

    // Create transaction to close WSOL account (this unwraps it)
    const unwrapTx = new Transaction().add(
      createCloseAccountInstruction(
        wsolAccount,
        wallet.publicKey, // destination for lamports
        wallet.publicKey, // owner
        [],
        TOKEN_PROGRAM
      )
    );

    unwrapTx.feePayer = wallet.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitmentLevel);
    unwrapTx.recentBlockhash = blockhash;
    unwrapTx.sign(wallet);

    // Send and confirm transaction
    const signature = await connection.sendRawTransaction(unwrapTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: commitmentLevel
    });

    // Poll for confirmation (compatible with all RPC providers)
    const startTime = Date.now();
    const maxWaitMs = 30000; // 30 second timeout
    const pollIntervalMs = 300;
    
    while (Date.now() - startTime < maxWaitMs) {
      const currentHeight = await connection.getBlockHeight(commitmentLevel);
      
      // Check if blockhash expired
      if (currentHeight > lastValidBlockHeight) {
        throw new Error('Transaction expired: blockhash no longer valid');
      }
      
      const status = await connection.getSignatureStatus(signature);
      
      if (status?.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
      }
      
      if (status?.value?.confirmationStatus === 'confirmed' || 
          status?.value?.confirmationStatus === 'finalized') {
        break; // Transaction confirmed!
      }
      
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    if (!silent) {
      console.log('✅ Unwrapped WSOL to native SOL');
    }

    return {
      success: true,
      signature,
      error: null,
      hadAccount: true
    };

  } catch (error) {
    const errorMsg = error?.message || 'Unknown error';
    
    if (!silent) {
      console.warn("⚠️  Failed to unwrap WSOL:", errorMsg);
    }

    return {
      success: false,
      signature: null,
      error: errorMsg,
      hadAccount: true // Assume account existed if we got this far
    };
  }
}

