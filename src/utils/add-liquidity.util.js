/**
 * Add Liquidity Utility
 * 
 * Pure utility function for adding liquidity to existing PancakeSwap CLMM positions.
 * This module handles the increase_liquidity_v2 instruction, allowing users to add
 * more tokens to their existing positions.
 * 
 * Features:
 * - Add liquidity to existing positions
 * - Support specifying exact liquidity amount OR token amounts
 * - Automatic calculation based on current pool price
 * - Slippage protection
 * - Support both Token Program and Token-2022
 * - Calculate USD value of added liquidity
 * 
 * @module add-liquidity.util
 */

import { Connection, PublicKey, Transaction, Keypair, SystemProgram } from "@solana/web3.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import {
  PROGRAM_ID,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  PANCAKESWAP_IDL,
  TICKS_IN_ARRAY,
  KNOWN_TOKENS,
  LAMPORTS_PER_SOL,
  DEFAULT_MIN_SOL_RESERVE,
  DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS,
  COMMITMENT_LEVEL,
  PREFLIGHT_COMMITMENT
} from '../config/constants.js';
import { getMintDecimals, getMintTokenProgram, getBalanceChange, getTokenInfo, unwrapWSol } from './token.util.js';
import { derivePersonalPosition } from './accounts.util.js';
import { sendTransaction } from './swqos.util.js';

/**
 * Calculate tick array start index
 * 
 * @param {number} tickIndex - Tick index
 * @param {number} tickSpacing - Tick spacing from pool
 * @returns {number} Start index for tick array
 */
function getTickArrayStartIndex(tickIndex, tickSpacing) {
  const ticksInArray = tickSpacing * TICKS_IN_ARRAY;
  const realIndex = Math.floor(tickIndex / ticksInArray);
  return realIndex * ticksInArray;
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
 * Calculate CLMM liquidity from token amounts
 * 
 * This is a simplified calculation. For production, use exact CLMM math.
 * Formula approximation based on current position range and pool price.
 * 
 * @param {bigint} amount0 - Token 0 amount (raw)
 * @param {bigint} amount1 - Token 1 amount (raw)
 * @param {bigint} sqrtPriceX64 - Current sqrt price from pool
 * @param {number} tickLower - Lower tick bound
 * @param {number} tickUpper - Upper tick bound
 * @param {number} tickCurrent - Current tick
 * @param {number} decimals0 - Token 0 decimals
 * @param {number} decimals1 - Token 1 decimals
 * @returns {bigint} Estimated liquidity
 */
function estimateLiquidityFromAmounts(
  amount0,
  amount1,
  sqrtPriceX64,
  tickLower,
  tickUpper,
  tickCurrent,
  decimals0,
  decimals1
) {
  // Simplified estimation
  // For production, implement full CLMM math with sqrt price calculations
  
  // Convert amounts to comparable scale
  const amount0Normalized = Number(amount0) / (10 ** decimals0);
  const amount1Normalized = Number(amount1) / (10 ** decimals1);
  
  // Rough estimation: liquidity ≈ sqrt(amount0 * amount1) * scale_factor
  const product = amount0Normalized * amount1Normalized;
  const sqrtProduct = Math.sqrt(product);
  
  // Scale to liquidity units (typical range: 1e6 to 1e12)
  const estimatedLiquidity = BigInt(Math.floor(sqrtProduct * 1e8));
  
  return estimatedLiquidity > 0n ? estimatedLiquidity : 1000000n; // Minimum 1M liquidity
}

/**
 * Add liquidity to an existing PancakeSwap CLMM position
 * 
 * This function increases the liquidity in an existing position by depositing
 * more tokens. You can specify either:
 * 1. Exact liquidity amount (let protocol calculate token amounts)
 * 2. Token amounts (protocol calculates liquidity based on current price)
 * 
 * **Position Requirements:**
 * - Position must already exist and be initialized
 * - Protocol position must exist on-chain
 * - Position tick arrays must be initialized
 * 
 * **Token Handling:**
 * - Supports both Token Program (legacy) and Token-2022
 * - Automatically creates token accounts if needed
 * - Deducts tokens from user's wallet
 * - Slippage protection via max amounts
 * 
 * **Calculation Modes:**
 * 1. **Liquidity-based**: Specify `liquidity`, protocol calculates needed tokens
 * 2. **Amount-based**: Specify `amount0` or `amount1`, protocol calculates liquidity
 *    - Use `baseFlag: true` to calculate from amount0
 *    - Use `baseFlag: false` to calculate from amount1
 * 
 * @param {Connection} connection - Solana connection
 * @param {Keypair} wallet - Wallet keypair (owner of position)
 * @param {PublicKey} positionMintPk - Position NFT mint address
 * @param {Object} options - Configuration options
 * @param {number} [options.liquidity] - Exact liquidity to add (if specified, amounts become max limits)
 * @param {number} [options.amount0] - Token 0 amount to deposit (human-readable)
 * @param {number} [options.amount1] - Token 1 amount to deposit (human-readable)
 * @param {number} [options.slippageBps=100] - Slippage tolerance in basis points (default: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS = 100 = 1%)
 * @param {boolean} [options.baseFlag] - If liquidity=0: true=calculate from amount0, false=calculate from amount1
 * @returns {Promise<Object>} Result with transaction details and amounts
 * @returns {boolean} return.success - Whether the operation was successful
 * @returns {string} [return.signature] - Transaction signature
 * @returns {string} [return.explorer] - Solscan explorer URL
 * @returns {string} [return.liquidityAdded] - Liquidity amount added
 * @returns {Array<Object>} [return.tokensDeposited] - Tokens deposited into position
 * @returns {number} [return.totalUsd] - Total USD value of deposited tokens
 * @returns {boolean} [return.unwrappedSol] - Whether WSOL was unwrapped to native SOL
 * @returns {string} [return.error] - Error message if failed
 * 
 * @example
 * // Add liquidity by specifying token amounts
 * const result = await addLiquidity(connection, wallet, positionMint, {
 *   amount0: 0.1,  // 0.1 SOL
 *   amount1: 150,  // 150 USDC
 *   slippageBps: 200
 * });
 * 
 * @example
 * // Add liquidity by specifying exact liquidity amount
 * const result = await addLiquidity(connection, wallet, positionMint, {
 *   liquidity: 1000000000,
 *   amount0: 0.2,  // Max 0.2 SOL
 *   amount1: 200,  // Max 200 USDC
 * });
 */
export async function addLiquidity(connection, wallet, positionMintPk, options = {}) {
  const {
    liquidity,
    amount0,
    amount1,
    slippageBps = DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS,
    baseFlag = true,   // Default: calculate from amount0
    minSolReserve = DEFAULT_MIN_SOL_RESERVE // Keep ~0.05 SOL for fees by default
  } = options;

  const coder = new BorshCoder(PANCAKESWAP_IDL);
  const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
  const isDebug = LOG_LEVEL === 'debug';

  try {
    // Validate inputs
    if (!liquidity && !amount0 && !amount1) {
      throw new Error("Must specify either liquidity OR token amounts (amount0/amount1)");
    }

    // 1. Derive personal_position PDA from NFT mint
    const personalPositionPk = await derivePersonalPosition(positionMintPk);

    // 2. Fetch position account to get pool, tick range, etc.
    const positionAi = await connection.getAccountInfo(personalPositionPk);
    if (!positionAi) throw new Error("Position account not found");

    const position = coder.accounts.decode("PersonalPositionState", positionAi.data);
    const poolPk = new PublicKey(position.pool_id);
    const tickLower = position.tick_lower_index;
    const tickUpper = position.tick_upper_index;

    // 3. Fetch pool account
    const poolAi = await connection.getAccountInfo(poolPk);
    if (!poolAi) throw new Error("Pool account not found");

    const pool = coder.accounts.decode("PoolState", poolAi.data);
    const mint0 = new PublicKey(pool.token_mint_0);
    const mint1 = new PublicKey(pool.token_mint_1);
    const vault0 = new PublicKey(pool.token_vault_0);
    const vault1 = new PublicKey(pool.token_vault_1);
    const tickSpacing = pool.tick_spacing;
    const sqrtPriceX64 = pool.sqrt_price_x64;
    const tickCurrent = pool.tick_current;

    // 4. Get token decimals (parallel)
    const [decimals0, decimals1] = await Promise.all([
      getMintDecimals(connection, mint0),
      getMintDecimals(connection, mint1)
    ]);

    if (decimals0 === null || decimals1 === null) {
      throw new Error("Failed to fetch token decimals");
    }

    // 5. Calculate liquidity and max amounts based on input mode
    let liquidityToAdd;
    let amount0Max;
    let amount1Max;
    let baseFlagValue = null; // null = not used, true/false = used for calculation

    if (liquidity) {
      // Mode 1: Exact liquidity specified
      liquidityToAdd = BigInt(liquidity);
      
      // Use provided amounts as max limits (with slippage buffer)
      const slippageMultiplier = 1 + (slippageBps / 10000);
      amount0Max = amount0 ? toRawAmount(amount0 * slippageMultiplier, decimals0) : BigInt(Number.MAX_SAFE_INTEGER);
      amount1Max = amount1 ? toRawAmount(amount1 * slippageMultiplier, decimals1) : BigInt(Number.MAX_SAFE_INTEGER);
      
    } else {
      // Mode 2: Calculate liquidity from amounts
      liquidityToAdd = 0n; // Let protocol calculate
      baseFlagValue = baseFlag;
      
      // Convert amounts to raw and apply slippage buffer for max limits
      const slippageMultiplier = 1 + (slippageBps / 10000);
      
      if (amount0 !== undefined) {
        const rawAmount0 = toRawAmount(amount0, decimals0);
        amount0Max = BigInt(Math.floor(Number(rawAmount0) * slippageMultiplier));
      } else {
        // If baseFlag=false (USDC is base), do not cap SOL here
        amount0Max = baseFlag ? 0n : 18446744073709551615n; // u64::MAX
      }
      
      if (amount1 !== undefined) {
        const rawAmount1 = toRawAmount(amount1, decimals1);
        amount1Max = BigInt(Math.floor(Number(rawAmount1) * slippageMultiplier));
      } else {
        // If baseFlag=true (SOL is base), do not cap USDC here
        amount1Max = baseFlag ? 18446744073709551615n : 0n; // u64::MAX
      }

      // Estimate liquidity for return data (approximation)
      if (amount0 && amount1) {
        liquidityToAdd = estimateLiquidityFromAmounts(
          toRawAmount(amount0, decimals0),
          toRawAmount(amount1, decimals1),
          sqrtPriceX64,
          tickLower,
          tickUpper,
          tickCurrent,
          decimals0,
          decimals1
        );
      }
    }

    // 6. Derive protocol_position PDA
    const tickLowerBytes = Buffer.alloc(4);
    tickLowerBytes.writeInt32BE(tickLower);
    const tickUpperBytes = Buffer.alloc(4);
    tickUpperBytes.writeInt32BE(tickUpper);

    const [protocolPositionPk] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), poolPk.toBuffer(), tickLowerBytes, tickUpperBytes],
      PROGRAM_ID
    );

    // Check if protocol_position exists
    const protocolPositionAi = await connection.getAccountInfo(protocolPositionPk);
    if (!protocolPositionAi) {
      throw new Error(
        "Protocol position not initialized. Cannot add liquidity to this position.\n" +
        `Check at: https://solscan.io/account/${personalPositionPk.toBase58()}`
      );
    }

    // 7. Derive tick array PDAs
    const lowerStartIndex = getTickArrayStartIndex(tickLower, tickSpacing);
    const upperStartIndex = getTickArrayStartIndex(tickUpper, tickSpacing);

    const lowerStartBytes = Buffer.alloc(4);
    lowerStartBytes.writeInt32BE(lowerStartIndex);
    const upperStartBytes = Buffer.alloc(4);
    upperStartBytes.writeInt32BE(upperStartIndex);

    const [tickArrayLowerPk] = PublicKey.findProgramAddressSync(
      [Buffer.from("tick_array"), poolPk.toBuffer(), lowerStartBytes],
      PROGRAM_ID
    );

    const [tickArrayUpperPk] = PublicKey.findProgramAddressSync(
      [Buffer.from("tick_array"), poolPk.toBuffer(), upperStartBytes],
      PROGRAM_ID
    );

    // 8. Get NFT token account (owner's ATA for the position NFT mint)
    const nftAccount = await getAssociatedTokenAddress(
      positionMintPk,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM
    );

    // 9. Determine token programs for each mint
    const mint0IsToken2022 = (await getMintTokenProgram(connection, mint0)).equals(TOKEN_2022_PROGRAM);
    const mint1IsToken2022 = (await getMintTokenProgram(connection, mint1)).equals(TOKEN_2022_PROGRAM);

    // 10. Get user's token accounts
    const tokenAccount0 = await getAssociatedTokenAddress(
      mint0,
      wallet.publicKey,
      false,
      mint0IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
    );

    const tokenAccount1 = await getAssociatedTokenAddress(
      mint1,
      wallet.publicKey,
      false,
      mint1IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
    );

    const accounts = [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false }, // nft_owner
      { pubkey: nftAccount, isSigner: false, isWritable: false }, // nft_account
      { pubkey: poolPk, isSigner: false, isWritable: true }, // pool_state
      { pubkey: protocolPositionPk, isSigner: false, isWritable: true }, // protocol_position
      { pubkey: personalPositionPk, isSigner: false, isWritable: true }, // personal_position
      { pubkey: tickArrayLowerPk, isSigner: false, isWritable: true }, // tick_array_lower
      { pubkey: tickArrayUpperPk, isSigner: false, isWritable: true }, // tick_array_upper
      { pubkey: tokenAccount0, isSigner: false, isWritable: true }, // token_account_0
      { pubkey: tokenAccount1, isSigner: false, isWritable: true }, // token_account_1
      { pubkey: vault0, isSigner: false, isWritable: true }, // token_vault_0
      { pubkey: vault1, isSigner: false, isWritable: true }, // token_vault_1
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }, // token_program
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false }, // token_program_2022
      { pubkey: mint0, isSigner: false, isWritable: false }, // vault_0_mint
      { pubkey: mint1, isSigner: false, isWritable: false }, // vault_1_mint
    ];

    // Add tick array bitmap extension if it exists (optional, required for pools with tight tick spacing)
    try {
      const [tickArrayBitmapExtension] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_tick_array_bitmap_extension"), poolPk.toBuffer()],
        PROGRAM_ID
      );
      
      const bitmapExtensionInfo = await connection.getAccountInfo(tickArrayBitmapExtension);
      if (bitmapExtensionInfo) {
        accounts.push({
          pubkey: tickArrayBitmapExtension,
          isSigner: false,
          isWritable: true
        });
      }
    } catch (error) {
      // Bitmap extension is optional, continue without it
    }

    // 12. Build transaction with ATA creation if needed
    const transaction = new Transaction();

    // Check and create token accounts if needed (batch fetch for speed)
    const [account0Info, account1Info] = await connection.getMultipleAccountsInfo([tokenAccount0, tokenAccount1]);
    if (!account0Info) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          tokenAccount0,
          wallet.publicKey,
          mint0,
          mint0IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
        )
      );
    }

    if (!account1Info) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          tokenAccount1,
          wallet.publicKey,
          mint1,
          mint1IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
        )
      );
    }

    // 12.1 Handle WSOL wrapping and clamp max amounts to actual balances
    const wsolMint = new PublicKey(KNOWN_TOKENS.SOL.mint);
    const isToken0Wsol = mint0.equals(wsolMint);
    const isToken1Wsol = mint1.equals(wsolMint);

    // Helper to fetch raw token account balance (BigInt)
    const getTokenRawBalance = async (tokenAccountPubkey) => {
      try {
        const bal = await connection.getTokenAccountBalance(tokenAccountPubkey);
        const amountStr = bal?.value?.amount || "0";
        return BigInt(amountStr);
      } catch {
        return 0n;
      }
    };

    // Fetch current raw balances
    let token0RawBal = await getTokenRawBalance(tokenAccount0);
    let token1RawBal = await getTokenRawBalance(tokenAccount1);

    // Keep a small SOL reserve for fees
    let solLamports = BigInt(await connection.getBalance(wallet.publicKey));
    const reserveLamports = BigInt(Math.floor(minSolReserve * LAMPORTS_PER_SOL));

    const wrapToCapacity = (accountPubkey, neededDeficit) => {
      // Wrap up to available capacity (wallet SOL - reserve), not exceeding deficit
      const capacity = solLamports > reserveLamports ? (solLamports - reserveLamports) : 0n;
      const wrapLamports = neededDeficit > capacity ? capacity : neededDeficit;
      if (wrapLamports > 0n) {
        transaction.add(SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: accountPubkey,
          lamports: Number(wrapLamports)
        }));
        return wrapLamports;
      }
      return 0n;
    };

    // If token0 is WSOL
    if (isToken0Wsol) {
      const explicitSolCap = amount0 !== undefined; // user specified amount0
      if (!explicitSolCap) {
        // Pre-fund up to capacity to avoid SOL being the limiting side when base is token1
        const topUp = wrapToCapacity(tokenAccount0, 18446744073709551615n);
        if (topUp > 0n) {
          transaction.add(createSyncNativeInstruction(tokenAccount0));
          token0RawBal += topUp;
          solLamports -= topUp;
        }
      } else if (amount0Max > token0RawBal) {
        const deficit = amount0Max - token0RawBal;
        const wrapped = wrapToCapacity(tokenAccount0, deficit);
        if (wrapped < deficit) {
          throw new Error('Insufficient SOL to wrap WSOL for token0 while keeping reserve');
        }
        transaction.add(createSyncNativeInstruction(tokenAccount0));
        token0RawBal += wrapped;
        solLamports -= wrapped;
      }
    }

    // If token1 is WSOL
    if (isToken1Wsol) {
      const explicitSolCap = amount1 !== undefined; // only relevant if token1 is SOL in pool configs
      if (!explicitSolCap) {
        const topUp = wrapToCapacity(tokenAccount1, 18446744073709551615n);
        if (topUp > 0n) {
          transaction.add(createSyncNativeInstruction(tokenAccount1));
          token1RawBal += topUp;
          solLamports -= topUp;
        }
      } else if (amount1Max > token1RawBal) {
        const deficit = amount1Max - token1RawBal;
        const wrapped = wrapToCapacity(tokenAccount1, deficit);
        if (wrapped < deficit) {
          throw new Error('Insufficient SOL to wrap WSOL for token1 while keeping reserve');
        }
        transaction.add(createSyncNativeInstruction(tokenAccount1));
        token1RawBal += wrapped;
        solLamports -= wrapped;
      }
    }

    // Clamp max amounts to actual token account balances
    amount0Max = amount0Max > token0RawBal ? token0RawBal : amount0Max;
    amount1Max = amount1Max > token1RawBal ? token1RawBal : amount1Max;

    // Now build increase_liquidity_v2 instruction (after wrapping/clamping)
    const discriminator = Buffer.from([133, 29, 89, 223, 69, 238, 176, 10]);
    const liquidityBytes = Buffer.alloc(16);
    liquidityBytes.writeBigUInt64LE(liquidityToAdd & 0xFFFFFFFFFFFFFFFFn, 0);
    liquidityBytes.writeBigUInt64LE(liquidityToAdd >> 64n, 8);
    const amount0MaxBytes = Buffer.alloc(8);
    amount0MaxBytes.writeBigUInt64LE(amount0Max, 0);
    const amount1MaxBytes = Buffer.alloc(8);
    amount1MaxBytes.writeBigUInt64LE(amount1Max, 0);
    let baseFlagBytes;
    if (baseFlagValue === null) {
      baseFlagBytes = Buffer.from([0]);
    } else {
      baseFlagBytes = Buffer.from([1, baseFlagValue ? 1 : 0]);
    }
    const data = Buffer.concat([
      discriminator,
      liquidityBytes,
      amount0MaxBytes,
      amount1MaxBytes,
      baseFlagBytes
    ]);
    const instruction = {
      programId: PROGRAM_ID,
      keys: accounts,
      data
    };

    // Add the main increase_liquidity_v2 instruction after wrapping
    transaction.add(instruction);
    transaction.feePayer = wallet.publicKey;

    // 13. Send transaction via SWQOS (or standard RPC if disabled)
    const txResult = await sendTransaction(connection, transaction, [wallet], {
      maxRetries: 3
    });

    if (!txResult.success) {
      throw new Error(`Transaction failed: ${txResult.error}`);
    }

    const signature = txResult.signature;

    // 13.1 Auto-unwrap WSOL to native SOL if WSOL was deposited
    let unwrappedSol = false;
    if (isToken0Wsol || isToken1Wsol) {
      const wsolAccount = isToken0Wsol ? tokenAccount0 : tokenAccount1;
      const unwrapResult = await unwrapWSol(connection, wallet, {
        wsolAccount,
        commitmentLevel: COMMITMENT_LEVEL
      });
      unwrappedSol = unwrapResult.success && unwrapResult.hadAccount;
    }

    // 14. Parse transaction results to get actual deposited amounts and extract fee
    const txDetails = await connection.getTransaction(signature, {
      commitment: COMMITMENT_LEVEL,
      maxSupportedTransactionVersion: 0
    });

    // Extract transaction fee
    let transactionFee = 0; // Fee in lamports
    let transactionFeeSol = 0; // Fee in SOL
    if (txDetails?.meta?.fee) {
      transactionFee = txDetails.meta.fee;
      transactionFeeSol = transactionFee / 1_000_000_000;
      // console.log(`💎 Add liquidity transaction fee: ${transactionFeeSol.toFixed(6)} SOL (${transactionFee.toLocaleString()} lamports)`);
    }

    const preBalances = txDetails?.meta?.preTokenBalances || [];
    const postBalances = txDetails?.meta?.postTokenBalances || [];

    if (isDebug) {
      console.log(`\n[DEBUG] === TRANSACTION BALANCE ANALYSIS ===`);
      console.log(`[DEBUG] Pre-balances: ${preBalances.length}`);
      console.log(`[DEBUG] Post-balances: ${postBalances.length}`);
      console.log(`[DEBUG] Looking for mint0: ${mint0.toBase58().slice(0, 8)}...`);
      console.log(`[DEBUG] Looking for mint1: ${mint1.toBase58().slice(0, 8)}...`);
    }

    const deposited = [];
    let totalUsd = 0;

    // Helper to find vault balance increase (tokens deposited into pool)
    const getVaultIncrease = (mintPk) => {
      const mintStr = mintPk.toBase58();
      const ownerStr = wallet.publicKey.toBase58();
      
      if (isDebug) {
        console.log(`\n[DEBUG] Checking for deposited ${mintStr.slice(0, 8)}...`);
        console.log(`[DEBUG] User wallet: ${ownerStr.slice(0, 8)}...`);
        console.log(`[DEBUG] All token balances:`);
      }
      
      // Look for any account with this mint that has a POSITIVE change
      // and is NOT owned by the user (i.e., it's the vault)
      for (const post of postBalances) {
        if (post.mint === mintStr) {
          const pre = preBalances.find(
            (p) => p.accountIndex === post.accountIndex
          );
          const preAmount = pre?.uiTokenAmount?.amount || "0";
          const postAmount = post.uiTokenAmount?.amount || "0";
          const change = BigInt(postAmount) - BigInt(preAmount);
          
          if (isDebug) {
            console.log(`   Index ${post.accountIndex}: owner=${post.owner.slice(0,8)}..., change=${change.toString()}`);
          }
          
          // Vault will show POSITIVE change (received tokens)
          // User wallet will show NEGATIVE change (sent tokens)
          if (change > 0n && post.owner !== ownerStr) {
            const result = {
              amount: change,
              decimals: post.uiTokenAmount.decimals,
              uiAmount: Number(post.uiTokenAmount.uiAmount) - Number(pre?.uiTokenAmount?.uiAmount || 0)
            };
            if (isDebug) {
              console.log(`[DEBUG] ✅ Found vault deposit: ${result.uiAmount}`);
            }
            return result;
          }
        }
      }
      if (isDebug) {
        console.log(`[DEBUG] ❌ No vault deposit found`);
      }
      return null;
    };

    // Check deposited token 0 (vault increase)
    const token0Increase = getVaultIncrease(mint0);
    if (token0Increase) {
      const mint0Str = mint0.toBase58();
      const { price: price0Usd, ticker: ticker0 } = await getTokenInfo(mint0Str);
      const usdValue = price0Usd ? token0Increase.uiAmount * price0Usd : null;
      if (usdValue) totalUsd += usdValue;

      deposited.push({
        mint: mint0Str,
        amount: token0Increase.amount.toString(),
        uiAmount: token0Increase.uiAmount,
        decimals: token0Increase.decimals,
        usdValue,
        symbol: ticker0
      });
    }

    // Check deposited token 1 (vault increase)
    const token1Increase = getVaultIncrease(mint1);
    if (token1Increase) {
      const mint1Str = mint1.toBase58();
      const { price: price1Usd, ticker: ticker1 } = await getTokenInfo(mint1Str);
      const usdValue = price1Usd ? token1Increase.uiAmount * price1Usd : null;
      if (usdValue) totalUsd += usdValue;

      deposited.push({
        mint: mint1Str,
        amount: token1Increase.amount.toString(),
        uiAmount: token1Increase.uiAmount,
        decimals: token1Increase.decimals,
        usdValue,
        symbol: ticker1
      });
    }

    // Fetch updated position to get actual liquidity added
    const updatedPositionAi = await connection.getAccountInfo(personalPositionPk);
    const updatedPosition = coder.accounts.decode("PersonalPositionState", updatedPositionAi.data);
    const actualLiquidityAdded = BigInt(updatedPosition.liquidity.toString()) - BigInt(position.liquidity.toString());

    return {
      success: true,
      signature,
      explorer: `https://solscan.io/tx/${signature}`,
      liquidityAdded: actualLiquidityAdded.toString(),
      tokensDeposited: deposited,
      totalUsd,
      unwrappedSol,
      transactionFee: transactionFeeSol, // Fee in SOL
      transactionFeeLamports: transactionFee, // Fee in lamports
      metadata: {
        previousLiquidity: position.liquidity.toString(),
        newLiquidity: updatedPosition.liquidity.toString(),
        slippageBps,
        calculationMode: liquidity ? "liquidity-based" : "amount-based"
      }
    };

  } catch (error) {
    let errorMsg = error?.message || 'Transaction failed.';
    if (error?.logs && Array.isArray(error.logs)) {
      // try {
      //   errorMsg += ` Logs: ${JSON.stringify(error.logs)}`;
      // } catch {}
    } else if (error?.toString) {
      errorMsg += ` (${error.toString()})`;
    }
    return {
      success: false,
      error: errorMsg
    };
  }
}

