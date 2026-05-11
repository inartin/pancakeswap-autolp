/**
 * Open Position Utility - Create new PancakeSwap CLMM positions
 * 
 * This utility creates concentrated liquidity positions in PancakeSwap V3 pools on Solana.
 * It handles all the complexity of CLMM math, token wrapping, and PDA derivation.
 * 
 * Features:
 * - Automatic price range calculation (symmetric ±% from current price)
 * - Exact ratio calculation using CLMM formulas
 * - Automatic WSOL wrapping/unwrapping
 * - Token account creation (ATA)
 * - Position NFT minting (Token-2022)
 * - Balance-aware liquidity calculation
 * - Comprehensive USD value tracking
 * 
 * @module open_position.util
 */

import { 
    Connection, 
    PublicKey, 
    Transaction, 
    Keypair, 
    SystemProgram,
    SYSVAR_RENT_PUBKEY,
    ComputeBudgetProgram
  } from "@solana/web3.js";
  import { BorshCoder } from "@coral-xyz/anchor";
  import { 
    getAssociatedTokenAddress, 
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    NATIVE_MINT
  } from "@solana/spl-token";
  import { getTokenInfo } from "./token.util.js";
  import { KNOWN_TOKENS, LAMPORTS_PER_SOL,MAX_PRIORITY_FEE_LAMPORTS, DEFAULT_PRIORITY_FEE_LAMPORTS,FINALIZATION_DELAY_MS, DEFAULT_OPEN_POSITION_SLIPPAGE_BPS, DEFAULT_COMPUTE_UNITS, MIN_RETRY_SLIPPAGE_BPS, RETRY_SLIPPAGE_INCREMENT_BPS, MAX_RETRY_SLIPPAGE_BPS, SOL_RESERVE_BUFFER, COMMITMENT_LEVEL, DEFAULT_SWAP_SLIPPAGE_BPS } from "../config/constants.js";
  import { formatDecimal, formatCurrency, formatPercentage } from "./format.util.js";
  import { sendAndConfirmTransactionWithRetry } from "./transaction.util.js";
  import { getMintTokenProgram, unwrapWSol, getMintDecimals, toRawAmount } from "./token.util.js";
  import { swapTokensUltra } from "./jupiter-ultra.util.js";
  
  // Global log level gating for this module
  const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
  const isDebug = LOG_LEVEL === 'debug';
  
  const TOKEN_PROGRAM_LEGACY = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const TOKEN_PROGRAM_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  
  // Known token addresses
  const WSOL = "So11111111111111111111111111111111111111112";
  
  // (Removed) local getMintDecimals helper – use cached util version
  
  // Helper to get token account balance
  async function getTokenBalance(connection, tokenAccount) {
    try {
      const accountInfo = await connection.getTokenAccountBalance(tokenAccount);
      return accountInfo?.value?.uiAmount || 0;
    } catch {
      return 0;
    }
  }
  
  // Helper to calculate tick from price
  function priceToTick(price) {
    // tick = log(price) / log(1.0001)
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }
  
  // Helper to round tick to spacing
  function roundTickToSpacing(tick, tickSpacing) {
    const rounded = Math.round(tick / tickSpacing) * tickSpacing;
    return rounded;
  }
  
  // Helper to get tick array start index
  function getTickArrayStartIndex(tickIndex, tickSpacing) {
    const ticksInArray = tickSpacing * 60;
    const realIndex = Math.floor(tickIndex / ticksInArray);
    return realIndex * ticksInArray;
  }
  
  /**
   * Open a new concentrated liquidity position in PancakeSwap CLMM pool
   * 
   * This function creates a new position with a specified price range, automatically
   * calculating the optimal token amounts based on available balances and CLMM math.
   * It handles the entire flow from balance checking to transaction submission.
   * 
   * **How it works:**
   * 1. Fetches pool state and current price from sqrt_price_x64
   * 2. Checks wallet balances (SOL and token1, e.g., USDC)
   * 3. Calculates symmetric price range (±rangePercent% from current price)
   * 4. Converts prices to ticks and rounds to tick spacing
   * 5. Calculates exact token ratio needed using CLMM formulas
   * 6. Determines how much of each token to use (balance-aware)
   * 7. Wraps SOL to WSOL if needed
   * 8. Creates token accounts (ATAs) if needed
   * 9. Generates position NFT mint keypair (Token-2022)
   * 10. Derives all required PDAs (position, tick arrays)
   * 11. Builds and sends open_position_with_token22_nft instruction
   * 12. Confirms transaction and fetches position data
   * 
   * **Token Program Support:**
   * - Token Program (Legacy) for most tokens
   * - Token-2022 for position NFTs
   * - Automatic detection and handling
   * 
   * **Price Range Calculation:**
   * - Symmetric range: [currentPrice * (1 - range%), currentPrice * (1 + range%)]
   * - Ticks rounded to pool's tick spacing
   * - Ensures tickLower < tickUpper
   * 
   * **Liquidity Calculation:**
   * - Uses CLMM formula: amount0/amount1 = (sqrtPriceUpper - sqrtPriceCurrent) / (sqrtPriceCurrent * sqrtPriceUpper * (sqrtPriceCurrent - sqrtPriceLower))
   * - Adjusts for token decimals
   * - Determines limiting factor (SOL or token1)
   * - Maximizes liquidity within available balance
   * 
   * @param {Connection} connection - Solana RPC connection
   * @param {Keypair} wallet - Wallet keypair with sufficient balance for liquidity + fees
   * @param {PublicKey} poolPk - PancakeSwap CLMM pool address
   * @param {Object} idl - PancakeSwap CLMM program IDL (from pancakeswap-idl.json)
   * @param {Object} [options={}] - Position configuration options
   * @param {number} [options.rangePercent=3] - Symmetric price range percentage (±% from current price)
   * @param {number} [options.slippageBps=200] - Slippage tolerance in basis points (default: DEFAULT_OPEN_POSITION_SLIPPAGE_BPS = 200 = 2%, conservative)
   * @param {number} [options.minSolReserve=0.05] - Minimum SOL to reserve for transaction fees
   * @param {number} [options.priorityFeeLamports] - Priority fee in microlamports (default: from config, for faster execution)
   * @param {number} [options.maxToken0ToUse] - Optional maximum token0 amount to use (UI units)
   * @param {number} [options.maxToken1ToUse] - Optional maximum token1 amount to use (UI units)
   * @param {Object} [options.tokenInfo] - Optional token metadata for accurate display and calculations
   * @param {string} [options.tokenInfo.token0Symbol] - Token0 symbol (e.g., "SOL", "BONK")
   * @param {string} [options.tokenInfo.token1Symbol] - Token1 symbol (e.g., "USDC", "TROLL")
   * @param {number} [options.tokenInfo.token0Price] - Token0 USD price
   * @param {number} [options.tokenInfo.token1Price] - Token1 USD price
   * 
   * @returns {Promise<Object>} Position creation result
   * @returns {boolean} return.success - Whether position was created successfully
   * @returns {string} [return.error] - Error message if failed
   * @returns {string} [return.signature] - Transaction signature (if successful)
   * @returns {string} [return.explorer] - Solscan explorer URL (if successful)
   * @returns {string} [return.positionNftMint] - Position NFT mint address
   * @returns {string} [return.positionAccount] - Personal position PDA address
   * @returns {string} [return.liquidityAdded] - Amount of liquidity added (as string)
   * @returns {number} [return.tickLower] - Lower tick boundary
   * @returns {number} [return.tickUpper] - Upper tick boundary
   * @returns {number} [return.currentTick] - Pool's current tick at position creation
   * @returns {Object} [return.priceRange] - Price range details
   * @returns {number} [return.priceRange.lower] - Lower price boundary
   * @returns {number} [return.priceRange.current] - Current pool price
   * @returns {number} [return.priceRange.upper] - Upper price boundary
   * @returns {number} [return.estimatedUsd] - Estimated USD value of deposited liquidity
   * 
   * @example
   * import { openPosition } from './utils/open_position.util.js';
   * import { Connection, Keypair } from '@solana/web3.js';
   * import { PANCAKESWAP_IDL } from '../config/constants.js';
   * 
   * const connection = new Connection(RPC_URL);
   * const wallet = Keypair.fromSecretKey(...);
   * const poolAddress = new PublicKey("...");
   * 
   * // Open position with default settings (±3% range, 2% slippage)
   * const result = await openPosition(connection, wallet, poolAddress, PANCAKESWAP_IDL);
   * 
   * // Open position with custom range and priority fees
   * const result = await openPosition(connection, wallet, poolAddress, PANCAKESWAP_IDL, {
   *   rangePercent: 5,            // ±5% price range (wider range)
   *   slippageBps: 200,           // 2% slippage tolerance (conservative)
   *   minSolReserve: 0.1,         // Keep 0.1 SOL for fees
   *   priorityFeeLamports: 20000  // Higher priority for faster execution
   * });
   * 
   * if (result.success) {
   *   console.log(`Position NFT: ${result.positionNftMint}`);
   *   console.log(`Liquidity: ${result.liquidityAdded}`);
   *   console.log(`Range: ${result.priceRange.lower} - ${result.priceRange.upper}`);
   *   console.log(`Explorer: ${result.explorer}`);
   * } else {
   *   console.error(`Failed: ${result.error}`);
   * }
   * 
   * @throws {Error} If pool account not found
   * @throws {Error} If insufficient SOL balance for fees
   * @throws {Error} If no tokens available for liquidity
   * @throws {Error} If invalid tick range calculated
   * @throws {Error} If transaction fails
   */
  export async function openPosition(connection, wallet, poolPk, idl, options = {}) {
    const {
      rangePercent = 3,  // ±3% price range
      slippageBps = DEFAULT_OPEN_POSITION_SLIPPAGE_BPS,
      minSolReserve = 0.05,  // Minimum SOL to keep for fees
      priorityFeeLamports = DEFAULT_PRIORITY_FEE_LAMPORTS,  // Priority fee for faster execution
      maxToken0ToUse = null,  // Optional: limit token0 amount (UI units)
      maxToken1ToUse = null,   // Optional: limit token1 amount (UI units)
      tokenInfo = null  // Optional: token metadata for accurate display
    } = options;
  
    const coder = new BorshCoder(idl);
    const programId = new PublicKey(idl.address);
  
    try {
      if (isDebug) {
        console.log("\n" + "=".repeat(60));
        console.log("🚀 OPENING NEW POSITION");
        console.log("=".repeat(60));
      }
  
      // 1. Fetch pool state
      if (isDebug) {
        console.log("📊 Fetching pool state...");
      }
      const poolAi = await connection.getAccountInfo(poolPk);
      if (!poolAi) throw new Error("Pool account not found");
  
      const pool = coder.accounts.decode("PoolState", poolAi.data);
      const mint0 = new PublicKey(pool.token_mint_0);
      const mint1 = new PublicKey(pool.token_mint_1);
      const vault0 = new PublicKey(pool.token_vault_0);
      const vault1 = new PublicKey(pool.token_vault_1);
      const tickSpacing = pool.tick_spacing;
      let sqrtPriceX64 = pool.sqrt_price_x64; // mutable for retry updates
      let tickCurrent = pool.tick_current; // mutable for retry updates
  
      if (isDebug) {
        console.log(`Current tick: ${tickCurrent}`);
        console.log(`Tick spacing: ${tickSpacing}`);
      }
  
      // Get token decimals (parallel with cache-backed util)
      const [dec0Raw, dec1Raw] = await Promise.all([
        getMintDecimals(connection, mint0),
        getMintDecimals(connection, mint1)
      ]);
      const dec0 = dec0Raw || 9;
      const dec1 = dec1Raw || 6;
  
      // Calculate current price from sqrt_price_x64
      const Q64 = 2n ** 64n;
      const sqrtPrice = Number(sqrtPriceX64) / Number(Q64);
      const priceRaw = sqrtPrice * sqrtPrice;
      
      // Adjust for decimals: human price = raw_price * 10^(dec0 - dec1)
      const priceAdjFactor = Math.pow(10, dec0 - dec1);
      let currentPrice = priceRaw * priceAdjFactor; // mutable for retry updates
      
      // Use tokenInfo if provided, otherwise fallback to detection
      const token0Symbol = tokenInfo?.token0Symbol || (mint0.toBase58() === WSOL ? 'SOL' : 'Token0');
      const token1Symbol = tokenInfo?.token1Symbol || (mint1.toBase58() === KNOWN_TOKENS.USDC.mint ? 'USDC' : 'Token1');

      if (isDebug) {
        console.log(`Current price: ${currentPrice.toFixed(4)} ${token1Symbol} per ${token0Symbol}`);
      }
  
      // 2. Check wallet balances
      if (isDebug) {
        console.log("\n💰 Checking wallet balances...");
      }
      
      // Get SOL balance
      const solBalance = await connection.getBalance(wallet.publicKey);
      const solBalanceUi = solBalance / LAMPORTS_PER_SOL;
      if (isDebug) {
        console.log(`SOL balance: ${solBalanceUi.toFixed(6)} SOL`);
      }
  
      // SOL Reserve Check & Auto Top-Up
      // Need SOL for: (1) current tx fees, (2) future operations
      const targetReserve = minSolReserve; // e.g., 0.05 SOL
      const ESTIMATED_TX_COST = 0.02; // Typical tx cost
      const ABSOLUTE_MINIMUM = targetReserve + ESTIMATED_TX_COST; // e.g., 0.07 SOL needed
      
      if (solBalanceUi < ABSOLUTE_MINIMUM) {
        const solNeeded = ABSOLUTE_MINIMUM - solBalanceUi;
        if (isDebug) console.log(`⚠️  Low SOL (${solBalanceUi.toFixed(4)} < ${ABSOLUTE_MINIMUM.toFixed(2)}). Need ${solNeeded.toFixed(3)} more SOL.`);
        
        // Try to auto-swap from token1 (usually stablecoin) to get SOL
        if (!isMint1Wsol && token1Balance > 0) {
          try {
            const solInfo = await getTokenInfo(KNOWN_TOKENS.SOL.mint);
            const solPrice = solInfo.price || 200; // Fallback $200
            const usdNeeded = solNeeded * solPrice * 1.05; // 5% buffer for slippage
            const token1Decimals = await getMintDecimals(connection, mint1);
            const token1ToSwap = Math.min(usdNeeded, token1Balance * 0.5); // Max 50% of token1
            
            if (isDebug) console.log(`🔄 Auto-swapping ${token1ToSwap.toFixed(4)} token1 → SOL...`);
            
            const swapResult = await swapTokensUltra({
              connection,
              wallet,
              inputMint: mint1.toBase58(),
              outputMint: WSOL,
              amount: toRawAmount(token1ToSwap, token1Decimals),
              slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
              waitForConfirmation: true
            });
            
            if (swapResult.success) {
              // Unwrap WSOL to native SOL
              await unwrapWSol(connection, wallet, { commitmentLevel: COMMITMENT_LEVEL });
              
              // Update balances after swap
              solBalanceUi = (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
              const token1Program = await getMintTokenProgram(connection, mint1);
              const token1Ata = await getAssociatedTokenAddress(mint1, wallet.publicKey, false, token1Program);
              token1Balance = await getTokenBalance(connection, token1Ata);
              
              if (isDebug) console.log(`✅ Auto-swap successful. New balances: ${solBalanceUi.toFixed(4)} SOL, ${token1Balance.toFixed(4)} token1`);
            } else {
              throw new Error(`Swap failed: ${swapResult.error}`);
            }
          } catch (swapError) {
            throw new Error(
              `Insufficient SOL (${solBalanceUi.toFixed(4)} < ${ABSOLUTE_MINIMUM.toFixed(2)}). ` +
              `Auto-swap failed: ${swapError.message}. ` +
              `Top up ${solNeeded.toFixed(3)} SOL manually.`
            );
          }
        } else {
          throw new Error(
            `Insufficient SOL (${solBalanceUi.toFixed(4)} < ${ABSOLUTE_MINIMUM.toFixed(2)}). ` +
            `No tokens available to swap. Top up ${solNeeded.toFixed(3)} SOL.`
          );
        }
      }
      
      // Calculate available SOL for position (only for SOL pools)
      let availableSol = Math.max(0, solBalanceUi - targetReserve);
      
      if (isDebug) {
        console.log(`💰 SOL allocation: ${availableSol.toFixed(4)} for position, ${targetReserve} reserved`);
      }
      
      // Apply maxToken0ToUse cap if specified
      if (maxToken0ToUse !== null && mint0.toBase58() === WSOL) {
        availableSol = Math.min(availableSol, maxToken0ToUse);
      }
      
      if (isDebug) {
        console.log(`Available SOL (after ${minSolReserve} SOL reserve): ${availableSol.toFixed(6)} SOL`);
      }

      // Detect and derive token accounts for token0 and token1 (legacy vs Token-2022)
      const isMint0Wsol = mint0.toBase58() === WSOL;
      const isMint1Wsol = mint1.toBase64?.() ? (mint1.toBase58() === WSOL) : (mint1.toBase58() === WSOL);

      // token0
      let token0Balance = 0;
      let token0Account;
      let token0AtaProgram = isMint0Wsol ? TOKEN_PROGRAM_LEGACY : await getMintTokenProgram(connection, mint0);
      try {
        token0Account = await getAssociatedTokenAddress(
          mint0,
          wallet.publicKey,
          false,
          token0AtaProgram
        );
        let info0 = await connection.getAccountInfo(token0Account);
        if (!info0) {
          const altProgram0 = token0AtaProgram.equals(TOKEN_PROGRAM_2022) ? TOKEN_PROGRAM_LEGACY : TOKEN_PROGRAM_2022;
          const altAta0 = await getAssociatedTokenAddress(mint0, wallet.publicKey, false, altProgram0);
          const altInfo0 = await connection.getAccountInfo(altAta0);
          if (altInfo0) {
            token0Account = altAta0;
            token0AtaProgram = altProgram0;
            info0 = altInfo0;
            if (isDebug) {
              console.log(`[openPosition] token0 ATA fallback used: ${altAta0.toBase58()}`);
            }
          }
        }
        if (info0) {
          token0Balance = await getTokenBalance(connection, token0Account);
        } else {
          if (isDebug) {
            console.log("Token0 account not found, balance = 0");
          }
        }
      } catch (e) {
        if (isDebug) {
          console.log("Token0 ATA detection failed, balance = 0", e?.message || e);
        }
      }

      // token1
      let token1Balance = 0;
      let token1Account;
      let token1AtaProgram = isMint1Wsol ? TOKEN_PROGRAM_LEGACY : await getMintTokenProgram(connection, mint1);
      try {
        token1Account = await getAssociatedTokenAddress(
          mint1,
          wallet.publicKey,
          false,
          token1AtaProgram
        );
        let info1 = await connection.getAccountInfo(token1Account);
        if (!info1) {
          // Fallback: try alternate program (in case of mismatched ATA derivation)
          const altProgram1 = token1AtaProgram.equals(TOKEN_PROGRAM_2022) ? TOKEN_PROGRAM_LEGACY : TOKEN_PROGRAM_2022;
          const altAta1 = await getAssociatedTokenAddress(mint1, wallet.publicKey, false, altProgram1);
          const altInfo1 = await connection.getAccountInfo(altAta1);
          if (altInfo1) {
            token1Account = altAta1;
            token1AtaProgram = altProgram1;
            info1 = altInfo1;
            if (isDebug) {
              console.log(`[openPosition] token1 ATA fallback used: ${altAta1.toBase58()}`);
            }
          }
        }
        if (info1) {
          token1Balance = await getTokenBalance(connection, token1Account);
        } else {
          if (isDebug) {
            console.log("Token1 account not found, balance = 0");
          }
        }
      } catch (e) {
        if (isDebug) {
          console.log("Token1 ATA detection failed, balance = 0", e?.message || e);
        }
      }
      
      // Apply maxToken1ToUse cap if specified
      if (maxToken1ToUse !== null) {
        token1Balance = Math.min(token1Balance, maxToken1ToUse);
      }

      if (isDebug) {
        console.log(`Token1 balance: ${formatDecimal(token1Balance, 6)} ${token1Symbol}`);
      }

      if (availableSol <= 0 && token1Balance <= 0) {
        throw new Error("No tokens available to add liquidity. Both balances are zero or insufficient.");
      }
  
      // 3. Calculate price range (symmetric ±rangePercent%)
      // We need to do this BEFORE calculating amounts, because the ratio depends on the range
      if (isDebug) {
        console.log(`\n📈 Calculating ±${rangePercent}% price range...`);
      }
      
      let lowerPrice = currentPrice * (1 - rangePercent / 100);
      let upperPrice = currentPrice * (1 + rangePercent / 100);
       
      if (isDebug) {
        console.log(`Lower price: ${lowerPrice.toFixed(4)}`);
        console.log(`Upper price: ${upperPrice.toFixed(4)}`);
      }
  
      // Calculate initial ticks from prices
      const lowerPriceRaw = lowerPrice / priceAdjFactor;
      const upperPriceRaw = upperPrice / priceAdjFactor;
      let tickLower = priceToTick(lowerPriceRaw);
      let tickUpper = priceToTick(upperPriceRaw);
      tickLower = roundTickToSpacing(tickLower, tickSpacing);
      tickUpper = roundTickToSpacing(tickUpper, tickSpacing);
      
      if (isDebug) {
        console.log(`Tick lower: ${tickLower}`);
        console.log(`Tick upper: ${tickUpper}`);
      }
  
      // Validate tick range
      if (tickLower >= tickUpper) {
        throw new Error("Invalid tick range: tickLower must be less than tickUpper");
      }
  
      // Calculate tick array indices (will be recalculated on retry)
      let tickArrayLowerStartIndex = getTickArrayStartIndex(tickLower, tickSpacing);
      let tickArrayUpperStartIndex = getTickArrayStartIndex(tickUpper, tickSpacing);
  
      if (isDebug) {
        console.log(`Tick array lower start: ${tickArrayLowerStartIndex}`);
        console.log(`Tick array upper start: ${tickArrayUpperStartIndex}`);
      }
  
      // 4. Calculate EXACT ratio needed for this price range using CLMM math
      if (isDebug) {
        console.log(`\n⚖️  Calculating exact token ratio for price range...`);
      }
      
      // Helper to calculate sqrt price from tick
      const getSqrtPriceFromTick = (tick) => {
        return Math.sqrt(Math.pow(1.0001, tick));
      };
      
      const sqrtPriceCurrent = Number(sqrtPriceX64) / Math.pow(2, 64);
      const sqrtPriceLower = getSqrtPriceFromTick(tickLower);
      const sqrtPriceUpper = getSqrtPriceFromTick(tickUpper);
      
      // For a position at current price, the ratio of token amounts is:
      // amount0 / amount1 = (sqrtPriceUpper - sqrtPriceCurrent) / (sqrtPriceCurrent * sqrtPriceUpper * (sqrtPriceCurrent - sqrtPriceLower))
      // Simplified: amount0 / amount1 ratio in terms of sqrt prices
      
      // Since current tick is inside the range, we need both tokens
      // Calculate the ratio: for every 1 unit of token1, how much token0 is needed?
      const numerator = sqrtPriceUpper - sqrtPriceCurrent;
      const denominator = sqrtPriceCurrent * sqrtPriceUpper * (sqrtPriceCurrent - sqrtPriceLower);
      const token0PerToken1Raw = numerator / denominator;
      
      // Adjust for decimals: token0 has 9 decimals (SOL), token1 has 6 decimals (USDC)
      const token0PerToken1 = token0PerToken1Raw * Math.pow(10, dec1 - dec0);

      if (isDebug) {
        console.log(`Ratio: ${formatDecimal(token0PerToken1, 9)} ${token0Symbol} per ${token1Symbol} needed for this range`);
      }

      // Get token prices for USD calculations
      const token0Price = tokenInfo?.token0Price || currentPrice;  // Fallback to current price for token0
      const token1Price = tokenInfo?.token1Price || 1;  // Fallback to $1 for token1

      // Now calculate balanced amounts based on what we have (generic token0/token1)
      // Important: If token is WSOL, include available native SOL in planning balance so we don't plan 0
      const effectiveToken0Balance = isMint0Wsol ? (token0Balance + availableSol) : token0Balance;
      const effectiveToken1Balance = isMint1Wsol ? (token1Balance + availableSol) : token1Balance;

      const token0UsdValue = effectiveToken0Balance * token0Price;
      const token1UsdValue = effectiveToken1Balance * token1Price;
      
    if (isDebug) {
      console.log(`Available: ${formatDecimal(effectiveToken0Balance, 6)} ${token0Symbol} (${formatCurrency(token0UsdValue)}) | ${formatDecimal(effectiveToken1Balance, 6)} ${token1Symbol} (${formatCurrency(token1UsdValue)})`);
    }

    // Calculate how much we can actually use based on the exact ratio
    // Do NOT apply slippage yet - we need to calculate exact ratio first
    let token0ToUse, token1ToUse;

    // Check which token is the limiting factor
    const token0NeededForAllToken1 = effectiveToken1Balance * token0PerToken1;
    const token1NeededForAllToken0 = effectiveToken0Balance / token0PerToken1;

    if (token0NeededForAllToken1 <= effectiveToken0Balance) {
      // We have enough token0 for all token1 - token1 is limiting
      token1ToUse = effectiveToken1Balance;
      token0ToUse = token0NeededForAllToken1;
      if (isDebug) console.log(`💡 ${token1Symbol} is limiting factor`);
    } else {
      // token0 is limiting
      token0ToUse = effectiveToken0Balance;
      token1ToUse = token1NeededForAllToken0;
      if (isDebug) console.log(`💡 ${token0Symbol} is limiting factor`);
    }

    // Apply max limits if provided
    if (maxToken0ToUse !== null) token0ToUse = Math.min(token0ToUse, maxToken0ToUse);
    if (maxToken1ToUse !== null) token1ToUse = Math.min(token1ToUse, maxToken1ToUse);

    const token0Limiting = token0NeededForAllToken1 > effectiveToken0Balance;

    const totalDepositValue = (token0ToUse * token0Price) + (token1ToUse * token1Price);
    if (isDebug) console.log(`Balanced amounts: ${formatDecimal(token0ToUse, 6)} ${token0Symbol} + ${formatDecimal(token1ToUse, 6)} ${token1Symbol} = ${formatCurrency(totalDepositValue)}`);
  
      // 5. Prepare common values and helper for attempts
      // Convert balanced amounts to raw units (base amounts before slippage buffer)
      const token0ToUseRawBase = BigInt(Math.floor(token0ToUse * Math.pow(10, dec0)));
      const token1ToUseRawBase = BigInt(Math.floor(token1ToUse * Math.pow(10, dec1)));
      const token0PlanningBalanceRaw = BigInt(Math.floor(effectiveToken0Balance * Math.pow(10, dec0)));
      const token1PlanningBalanceRaw = BigInt(Math.floor(effectiveToken1Balance * Math.pow(10, dec1)));

    // Attempt open with up to 2 tries: initial slippage, then increased slippage (capped at MAX_RETRY_SLIPPAGE_BPS)
    let lastError = null;
    
    for (let attempt = 1; attempt <= 2; attempt++) {
      // Refetch pool state on retry to get fresh price (critical for slippage errors)
      if (attempt > 1) {
        if (isDebug) console.log(`🔄 Refetching pool state for fresh price...`);
        const freshPoolAi = await connection.getAccountInfo(poolPk);
        if (freshPoolAi) {
          const freshPool = coder.accounts.decode("PoolState", freshPoolAi.data);
          sqrtPriceX64 = freshPool.sqrt_price_x64;
          tickCurrent = freshPool.tick_current;
          
          // Recalculate current price
          const Q64 = 2n ** 64n;
          const sqrtPrice = Number(sqrtPriceX64) / Number(Q64);
          const priceRaw = sqrtPrice * sqrtPrice;
          const priceAdjFactor = Math.pow(10, dec0 - dec1);
          currentPrice = priceRaw * priceAdjFactor;
          
          // Recalculate price range based on fresh price
          const lowerPrice = currentPrice * (1 - rangePercent / 100);
          const upperPrice = currentPrice * (1 + rangePercent / 100);
          const lowerPriceRaw = lowerPrice / priceAdjFactor;
          const upperPriceRaw = upperPrice / priceAdjFactor;
          tickLower = roundTickToSpacing(priceToTick(lowerPriceRaw), tickSpacing);
          tickUpper = roundTickToSpacing(priceToTick(upperPriceRaw), tickSpacing);
          
          // Recalculate tick array indices with fresh ticks
          tickArrayLowerStartIndex = getTickArrayStartIndex(tickLower, tickSpacing);
          tickArrayUpperStartIndex = getTickArrayStartIndex(tickUpper, tickSpacing);
          
          if (isDebug) {
            console.log(`📊 Fresh pool price: ${currentPrice.toFixed(4)} ${token1Symbol}/${token0Symbol}`);
            console.log(`📊 Recalculated ticks: ${tickLower} - ${tickUpper}`);
            console.log(`📊 Recalculated range: ${lowerPrice.toFixed(4)} - ${upperPrice.toFixed(4)}`);
          }
        }
      }
      
      // Be more aggressive on the second attempt: increase slippage but cap at MAX_RETRY_SLIPPAGE_BPS
      const attemptSlippageBps = attempt === 1 
        ? slippageBps 
        : Math.min(MAX_RETRY_SLIPPAGE_BPS, Math.max(MIN_RETRY_SLIPPAGE_BPS, slippageBps + RETRY_SLIPPAGE_INCREMENT_BPS));

      if (isDebug) {
        console.log(`\n💵 Calculating max amounts (attempt ${attempt}, slippage=${attemptSlippageBps}bps):`);
      }
      
      // Step 1: Start with exact balanced amounts (no slippage yet)
      let amount0MaxUi = Number(token0ToUseRawBase) / Math.pow(10, dec0);
      let amount1MaxUi = Number(token1ToUseRawBase) / Math.pow(10, dec1);
      
      if (isDebug) {
        console.log(`  1️⃣ Base amounts: ${formatDecimal(amount0MaxUi, 6)} ${token0Symbol}, ${formatDecimal(amount1MaxUi, 6)} ${token1Symbol}`);
      }

      // Step 2: Apply ratio-based clamping FIRST to ensure exact ratio
      // This ensures the amounts maintain the correct proportion for the position range
      const required0From1Ui = amount1MaxUi * token0PerToken1;
      const required1From0Ui = amount0MaxUi / token0PerToken1;

      if (amount0MaxUi > required0From1Ui) {
        amount0MaxUi = required0From1Ui;
        if (isDebug) {
          console.log(`  2️⃣ Ratio clamp: Reduced token0 to ${formatDecimal(amount0MaxUi, 6)} ${token0Symbol} (ratio-balanced)`);
        }
      } else if (amount1MaxUi > required1From0Ui) {
        amount1MaxUi = required1From0Ui;
        if (isDebug) {
          console.log(`  2️⃣ Ratio clamp: Reduced token1 to ${formatDecimal(amount1MaxUi, 6)} ${token1Symbol} (ratio-balanced)`);
        }
      } else {
        if (isDebug) {
          console.log(`  2️⃣ Ratio check: Already balanced`);
        }
      }

      // Step 3: NOW apply slippage buffer to the ratio-balanced amounts
      const slippageMultiplier = (10000 + attemptSlippageBps) / 10000;
      let amount0MaxWithSlippage = amount0MaxUi * slippageMultiplier;
      let amount1MaxWithSlippage = amount1MaxUi * slippageMultiplier;
      
      if (isDebug) {
        console.log(`  3️⃣ After slippage (+${attemptSlippageBps}bps): ${formatDecimal(amount0MaxWithSlippage, 6)} ${token0Symbol}, ${formatDecimal(amount1MaxWithSlippage, 6)} ${token1Symbol}`);
      }

      // Step 4: Clamp to absolute maximum balance (cannot exceed what we have)
      const token0PlanningBalanceUi = Number(token0PlanningBalanceRaw) / Math.pow(10, dec0);
      const token1PlanningBalanceUi = Number(token1PlanningBalanceRaw) / Math.pow(10, dec1);
      
      let balanceClamped = false;
      if (amount0MaxWithSlippage > token0PlanningBalanceUi) {
        amount0MaxWithSlippage = token0PlanningBalanceUi;
        balanceClamped = true;
      }
      if (amount1MaxWithSlippage > token1PlanningBalanceUi) {
        amount1MaxWithSlippage = token1PlanningBalanceUi;
        balanceClamped = true;
      }
      
      if (balanceClamped) {
        if (isDebug) {
          console.log(`  4️⃣ Balance clamp: Limited to available balance`);
        }
      }

      // Convert final amounts to raw BigInt
      let amount0Max = BigInt(Math.floor(amount0MaxWithSlippage * Math.pow(10, dec0)));
      let amount1Max = BigInt(Math.floor(amount1MaxWithSlippage * Math.pow(10, dec1)));

      // If both max amounts are zero, abort early to avoid sending a tx that only creates ATAs
      if (amount0Max === 0n && amount1Max === 0n) {
        throw new Error("No tokens available to deposit after accounting for SOL reserve and balances.");
      }

      if (isDebug) {
        console.log(`  ✅ Final max amounts: ${formatDecimal(Number(amount0Max) / Math.pow(10, dec0), 6)} ${token0Symbol} (${amount0Max.toString()} raw), ${formatDecimal(Number(amount1Max) / Math.pow(10, dec1), 6)} ${token1Symbol} (${amount1Max.toString()} raw)`);
      }

        // 6. Build transaction
        const transaction = new Transaction();
  
      // Compute budget (limit + price) will be added dynamically in sendAndConfirmTransactionWithRetry
  
      // Handle WSOL wrapping for either side if needed
        // Always maintain targetReserve in wallet after wrapping
        const reserveLamports = BigInt(Math.floor(targetReserve * LAMPORTS_PER_SOL));
        let walletSolLamports = BigInt(await connection.getBalance(wallet.publicKey));

        if (isMint0Wsol) {
          // Ensure WSOL ATA exists for token0
          const wsol0 = await getAssociatedTokenAddress(new PublicKey(WSOL), wallet.publicKey, false, TOKEN_PROGRAM_LEGACY);
          const wsol0Info = await connection.getAccountInfo(wsol0);
          let willCreateWsol0 = false;
          if (!wsol0Info) {
            if (isDebug) {
              console.log("\n🔄 Creating WSOL account for token0...");
            }
            transaction.add(
              createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                wsol0,
                wallet.publicKey,
                new PublicKey(WSOL),
                TOKEN_PROGRAM_LEGACY
              )
            );
            willCreateWsol0 = true;
          }
          // Wrap amount0Max (clamped by reserve)
          if (amount0Max > 0n) {
            const capacity = walletSolLamports > reserveLamports ? (walletSolLamports - reserveLamports) : 0n;
            // Only wrap the delta beyond existing WSOL
            const existingWsol0 = BigInt(Math.floor(token0Balance * Math.pow(10, dec0)));
            const desiredWrap0 = amount0Max > existingWsol0 ? (amount0Max - existingWsol0) : 0n;
            const wrapLamports0 = desiredWrap0 > capacity ? capacity : desiredWrap0;
            if (isDebug) {
              console.log(`🔄 Wrapping ${formatDecimal(Number(wrapLamports0) / LAMPORTS_PER_SOL, 6)} SOL → WSOL for token0...`);
            }
            if (wrapLamports0 > 0n) {
              transaction.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsol0, lamports: Number(wrapLamports0) }));
              transaction.add(createSyncNativeInstruction(wsol0, TOKEN_PROGRAM_LEGACY));
              walletSolLamports -= wrapLamports0;
              token0Account = wsol0;
            }
          }
          // Prevent duplicate ATA creation later if we already enqueued it
          var _skipCreateToken0Ata = (!wsol0Info);
        }

        if (isMint1Wsol) {
          // Ensure WSOL ATA exists for token1
          const wsol1 = await getAssociatedTokenAddress(new PublicKey(WSOL), wallet.publicKey, false, TOKEN_PROGRAM_LEGACY);
          const wsol1Info = await connection.getAccountInfo(wsol1);
          let willCreateWsol1 = false;
          if (!wsol1Info) {
            if (isDebug) {
              console.log("\n🔄 Creating WSOL account for token1...");
            }
            transaction.add(
              createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                wsol1,
                wallet.publicKey,
                new PublicKey(WSOL),
                TOKEN_PROGRAM_LEGACY
              )
            );
            willCreateWsol1 = true;
          }
          if (amount1Max > 0n) {
            const capacity = walletSolLamports > reserveLamports ? (walletSolLamports - reserveLamports) : 0n;
            const existingWsol1 = BigInt(Math.floor(token1Balance * Math.pow(10, dec1)));
            const desiredWrap1 = amount1Max > existingWsol1 ? (amount1Max - existingWsol1) : 0n;
            const wrapLamports1 = desiredWrap1 > capacity ? capacity : desiredWrap1;
            if (isDebug) {
              console.log(`🔄 Wrapping ${formatDecimal(Number(wrapLamports1) / LAMPORTS_PER_SOL, 6)} SOL → WSOL for token1...`);
            }
            if (wrapLamports1 > 0n) {
              transaction.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsol1, lamports: Number(wrapLamports1) }));
              transaction.add(createSyncNativeInstruction(wsol1, TOKEN_PROGRAM_LEGACY));
              walletSolLamports -= wrapLamports1;
              token1Account = wsol1;
            }
          }
          // Prevent duplicate ATA creation later if we already enqueued it
          var _skipCreateToken1Ata = (!wsol1Info);
        }
  
      // Ensure ATAs exist if not WSOL-wrapped case already handled
        const token0AccountInfo = await connection.getAccountInfo(token0Account);
        if (!token0AccountInfo && !(isMint0Wsol && (typeof _skipCreateToken0Ata !== 'undefined' && _skipCreateToken0Ata))) {
          if (isDebug) {
            console.log("🔄 Creating token0 account...");
          }
          transaction.add(
            createAssociatedTokenAccountInstruction(
              wallet.publicKey,
              token0Account,
              wallet.publicKey,
              mint0,
              token0AtaProgram
            )
          );
        }
        const token1AccountInfo = await connection.getAccountInfo(token1Account);
        if (!token1AccountInfo && !(isMint1Wsol && (typeof _skipCreateToken1Ata !== 'undefined' && _skipCreateToken1Ata))) {
          if (isDebug) {
            console.log("🔄 Creating token1 account...");
          }
          transaction.add(
            createAssociatedTokenAccountInstruction(
              wallet.publicKey,
              token1Account,
              wallet.publicKey,
              mint1,
              token1AtaProgram
            )
          );
        }
  
        // 6. Generate new position NFT mint keypair (per attempt)
        const positionNftMint = Keypair.generate();
        if (isDebug) console.log(`\n🎫 Position NFT mint: ${positionNftMint.publicKey.toBase58()}`);
  
      // Get position NFT token account
      const positionNftAccount = await getAssociatedTokenAddress(
        positionNftMint.publicKey,
        wallet.publicKey,
        false,
        TOKEN_PROGRAM_2022  // Positions use Token-2022
      );
  
      // 7. Derive PDAs
      // Personal position PDA
      const [personalPositionPk] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), positionNftMint.publicKey.toBuffer()],
        programId
      );
  
      // Protocol position PDA
      const tickLowerBytes = Buffer.alloc(4);
      tickLowerBytes.writeInt32BE(tickLower);  // BIG ENDIAN
      const tickUpperBytes = Buffer.alloc(4);
      tickUpperBytes.writeInt32BE(tickUpper);  // BIG ENDIAN
  
      const [protocolPositionPk] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), poolPk.toBuffer(), tickLowerBytes, tickUpperBytes],
        programId
      );
  
      // Tick array PDAs
      const lowerStartBytes = Buffer.alloc(4);
      lowerStartBytes.writeInt32BE(tickArrayLowerStartIndex);
      const upperStartBytes = Buffer.alloc(4);
      upperStartBytes.writeInt32BE(tickArrayUpperStartIndex);
  
      const [tickArrayLowerPk] = PublicKey.findProgramAddressSync(
        [Buffer.from("tick_array"), poolPk.toBuffer(), lowerStartBytes],
        programId
      );
  
      const [tickArrayUpperPk] = PublicKey.findProgramAddressSync(
        [Buffer.from("tick_array"), poolPk.toBuffer(), upperStartBytes],
        programId
      );
      
      // Optional: tick array bitmap extension (required for pools with tight spacing)
      let tickArrayBitmapExtensionPk = null;
      try {
        const [extPk] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool_tick_array_bitmap_extension"), poolPk.toBuffer()],
          programId
        );
        const extInfo = await connection.getAccountInfo(extPk);
        if (extInfo) {
          tickArrayBitmapExtensionPk = extPk;
        }
      } catch {}
  
        // 8. Build open_position_with_token22_nft instruction
        if (isDebug) {
          console.log("\n🔨 Building open position instruction...");
        }
      
      const discriminator = Buffer.from([77, 255, 174, 82, 125, 29, 201, 46]);
      
      // Args: tick_lower_index (i32), tick_upper_index (i32), 
      //       tick_array_lower_start_index (i32), tick_array_upper_start_index (i32),
      //       liquidity (u128), amount_0_max (u64), amount_1_max (u64),
      //       with_metadata (bool), base_flag (Option<bool>)
      
      const args = Buffer.alloc(4 + 4 + 4 + 4 + 16 + 8 + 8 + 1 + 2);
      let offset = 0;
      
      // tick_lower_index (i32, little endian)
      args.writeInt32LE(tickLower, offset);
      offset += 4;
      
      // tick_upper_index (i32, little endian)
      args.writeInt32LE(tickUpper, offset);
      offset += 4;
      
      // tick_array_lower_start_index (i32, little endian)
      args.writeInt32LE(tickArrayLowerStartIndex, offset);
      offset += 4;
      
      // tick_array_upper_start_index (i32, little endian)
      args.writeInt32LE(tickArrayUpperStartIndex, offset);
      offset += 4;
      
      // liquidity (u128) - set to 0 to let protocol calculate
      args.writeBigUInt64LE(0n, offset);
      args.writeBigUInt64LE(0n, offset + 8);
      offset += 16;
      
      // amount_0_max (u64)
      args.writeBigUInt64LE(amount0Max, offset);
      offset += 8;
      
      // amount_1_max (u64)
      args.writeBigUInt64LE(amount1Max, offset);
      offset += 8;
      
      // with_metadata (bool) - false (we don't need metadata)
      args.writeUInt8(0, offset);
      offset += 1;
      
      // base_flag (Option<bool>) - Some(true) if token0 is limiting, else Some(false)
      args.writeUInt8(1, offset);  // Some
      args.writeUInt8(token0Limiting ? 1 : 0, offset + 1);
      offset += 2;
  
      const data = Buffer.concat([discriminator, args]);
  
      const accounts = [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },  // payer
        { pubkey: wallet.publicKey, isSigner: false, isWritable: false },  // position_nft_owner
        { pubkey: positionNftMint.publicKey, isSigner: true, isWritable: true },  // position_nft_mint
        { pubkey: positionNftAccount, isSigner: false, isWritable: true },  // position_nft_account
        { pubkey: poolPk, isSigner: false, isWritable: true },  // pool_state
        { pubkey: protocolPositionPk, isSigner: false, isWritable: true },  // protocol_position
        { pubkey: tickArrayLowerPk, isSigner: false, isWritable: true },  // tick_array_lower
        { pubkey: tickArrayUpperPk, isSigner: false, isWritable: true },  // tick_array_upper
        { pubkey: personalPositionPk, isSigner: false, isWritable: true },  // personal_position
        { pubkey: token0Account, isSigner: false, isWritable: true },  // token_account_0
        { pubkey: token1Account, isSigner: false, isWritable: true },  // token_account_1
        { pubkey: vault0, isSigner: false, isWritable: true },  // token_vault_0
        { pubkey: vault1, isSigner: false, isWritable: true },  // token_vault_1
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },  // rent
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },  // system_program
        { pubkey: TOKEN_PROGRAM_LEGACY, isSigner: false, isWritable: false },  // token_program
        { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },  // associated_token_program
        { pubkey: TOKEN_PROGRAM_2022, isSigner: false, isWritable: false },  // token_program_2022
        { pubkey: mint0, isSigner: false, isWritable: false },  // vault_0_mint
        { pubkey: mint1, isSigner: false, isWritable: false },  // vault_1_mint
      ];

      if (tickArrayBitmapExtensionPk) {
        accounts.push({ pubkey: tickArrayBitmapExtensionPk, isSigner: false, isWritable: true });
      }
  
      const instruction = {
        programId,
        keys: accounts,
        data
      };
  
        transaction.add(instruction);
        transaction.feePayer = wallet.publicKey;

        // 9. Send transaction through helper (with simulation and retries)
        if (isDebug) {
          console.log("\n📤 Sending transaction...");
          console.log(`   Range: Tick ${tickLower} to ${tickUpper} (±${rangePercent}%)`);
          console.log(`   Max amounts in transaction:`);
          console.log(`     Token0: ${formatDecimal(Number(amount0Max) / Math.pow(10, dec0), 6)} ${token0Symbol}`);
          console.log(`     Token1: ${formatDecimal(Number(amount1Max) / Math.pow(10, dec1), 6)} ${token1Symbol}`);
          console.log(`   Slippage tolerance: ${attemptSlippageBps} bps (${(attemptSlippageBps / 100).toFixed(1)}%)`);
          console.log(`   Base flag: ${token0Limiting ? 'token0-based' : 'token1-based'}`);
        }
        const sendResult = await sendAndConfirmTransactionWithRetry(
          connection,
          transaction,
          [wallet, positionNftMint],
          { skipPreflight: true, maxRetries: 3, skipSimulation: true }
        );

        if (!sendResult.success) {
          const errMsg = sendResult.error || 'Unknown error';
          console.error(`❌ Send failed: ${errMsg}`);
          // Retry on slippage-specific errors with fresh pool state
          if (attempt < 2 && (errMsg.includes('6021') || errMsg.includes('Price slippage') || errMsg.includes('0x1785'))) {
            if (isDebug) console.log('   ⚠️  Price slippage detected. Retrying with fresh pool price...');
            lastError = new Error(errMsg);
            continue;
          }
          
          // All attempts failed - unwrap any WSOL before returning error
          if (isDebug) {
            console.log('❌ All attempts failed. Unwrapping any WSOL to native SOL...');
          }
          try {
            const isMint0Wsol = mint0.toBase58() === WSOL;
            const isMint1Wsol = mint1.toBase58() === WSOL;
            if (isMint0Wsol || isMint1Wsol) {
              await unwrapWSol(connection, wallet, { commitmentLevel: COMMITMENT_LEVEL });
              if (isDebug) {
                console.log('✅ WSOL unwrapped successfully');
              }
            }
          } catch (unwrapError) {
            if (isDebug) {
              console.warn('⚠️  WSOL unwrap failed:', unwrapError.message);
            }
          }
          
          throw new Error(errMsg);
        }

        const signature = sendResult.signature;
        if (isDebug) {
          console.log("✅ Transaction confirmed!");
        }

      // 10. Fetch position to get actual liquidity added
      await new Promise(resolve => setTimeout(resolve, FINALIZATION_DELAY_MS));  // Wait for state to update
      
      const positionAi = await connection.getAccountInfo(personalPositionPk);
      let liquidityAdded = "0";
      if (positionAi) {
        const position = coder.accounts.decode("PersonalPositionState", positionAi.data);
        liquidityAdded = position.liquidity?.toString() || "0";
      }
  
      // Calculate USD value using actual token prices from tokenInfo
      // token0Price and token1Price were already set earlier
      const token0Value = token0ToUse * token0Price;
      const token1Value = token1ToUse * token1Price;
      const totalUsd = token0Value + token1Value;
  
      // Log results
      if (isDebug) {
        console.log("\n" + "=".repeat(60));
        console.log("🎉 POSITION OPENED SUCCESSFULLY");
        console.log("=".repeat(60));
        console.log(`🎫 Position NFT Mint: ${positionNftMint.publicKey.toBase58()}`);
        console.log(`📍 Position Account: ${personalPositionPk.toBase58()}`);
        console.log(`💧 Liquidity Added: ${liquidityAdded}`);
        console.log("-".repeat(60));
        console.log(`📊 Price Range:`);
        console.log(`   Lower: ${formatDecimal(lowerPrice, 4)} ${token1Symbol} per ${token0Symbol} (tick ${tickLower})`);
        console.log(`   Current: ${formatDecimal(currentPrice, 4)} ${token1Symbol} per ${token0Symbol}`);
        console.log(`   Upper: ${formatDecimal(upperPrice, 4)} ${token1Symbol} per ${token0Symbol} (tick ${tickUpper})`);
        console.log("-".repeat(60));
        console.log(`💰 Estimated Value: ${formatCurrency(totalUsd)}`);
        console.log(`🔗 Transaction: https://solscan.io/tx/${signature}`);
        console.log("=".repeat(60) + "\n");
      }
  
      return {
        success: true,
        signature,
        explorer: `https://solscan.io/tx/${signature}`,
        positionNftMint: positionNftMint.publicKey.toBase58(),
        positionAccount: personalPositionPk.toBase58(),
        liquidityAdded,
        tickLower,
        tickUpper,
        currentTick: tickCurrent,
        priceRange: {
          lower: lowerPrice,
          current: currentPrice,
          upper: upperPrice
        },
        estimatedUsd: totalUsd,
        rangePercent
      };
      }
  
    } catch (error) {
      console.error("❌ Error opening position:", error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  