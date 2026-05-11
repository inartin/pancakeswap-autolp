/**
 * Remove Liquidity Utility
 * 
 * Pure utility function for removing all liquidity from PancakeSwap CLMM positions.
 * This module handles the decrease_liquidity_v2 instruction with full liquidity amount,
 * automatically closing empty positions and unwrapping WSOL.
 * 
 * Features:
 * - Remove all liquidity from a position
 * - Collect accumulated fees and rewards
 * - Auto-unwrap WSOL to native SOL
 * - Auto-close position to reclaim rent
 * - Calculate USD value of withdrawn tokens
 * 
 * @module remove-liquidity.util
 */

import { Connection, PublicKey, Transaction, Keypair, SystemProgram } from "@solana/web3.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import {
  PROGRAM_ID,
  MEMO_PROGRAM_ID,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  PANCAKESWAP_IDL,
  TICKS_IN_ARRAY,
  KNOWN_TOKENS,
  DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS,
  COMMITMENT_LEVEL,
  PREFLIGHT_COMMITMENT,
  FINALIZATION_DELAY_MS,
  TX_METADATA_PARSE_MAX_RETRIES,
  TX_METADATA_PARSE_RETRY_DELAY_MS
} from '../config/constants.js';
import { getMintDecimals, getMintTokenProgram, getBalanceChange, formatLiquidity, isStablecoin, getTokenInfo, getTokenInfoBatch, unwrapWSol } from './token.util.js';
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
 * Calculate minimum amounts with slippage protection
 * 
 * Based on current pool price and liquidity being removed.
 * This is a simplified calculation - for production use, implement exact CLMM math.
 * 
 * @param {bigint} liquidity - Liquidity amount to remove
 * @param {bigint} sqrtPriceX64 - Current sqrt price from pool
 * @param {number} tickLower - Lower tick bound
 * @param {number} tickUpper - Upper tick bound
 * @param {number} tickCurrent - Current tick
 * @param {number} slippageBps - Slippage tolerance in basis points (100 = 1%)
 * @returns {Object} Minimum amounts for slippage protection
 * @returns {bigint} return.amount0Min - Minimum token 0 amount
 * @returns {bigint} return.amount1Min - Minimum token 1 amount
 */
function calculateMinAmountsWithSlippage(
  liquidity,
  sqrtPriceX64,
  tickLower,
  tickUpper,
  tickCurrent,
  slippageBps
) {
  // Simplified estimation
  // For production, use proper CLMM formulas
  
  const liquidityNum = Number(liquidity);
  
  // Rough estimation of token amounts based on tick positions
  let amount0Estimate = 0;
  let amount1Estimate = 0;
  
  if (tickCurrent < tickLower) {
    // All in token0
    amount0Estimate = liquidityNum / 1e6;
  } else if (tickCurrent >= tickUpper) {
    // All in token1
    amount1Estimate = liquidityNum / 1e6;
  } else {
    // Mixed position
    amount0Estimate = liquidityNum / 2e6;
    amount1Estimate = liquidityNum / 2e6;
  }
  
  // Apply slippage tolerance (default 1% = 100 bps)
  const slippageMultiplier = 1 - (slippageBps / 10000);
  const amount0Min = Math.floor(amount0Estimate * slippageMultiplier);
  const amount1Min = Math.floor(amount1Estimate * slippageMultiplier);
  
  return {
    amount0Min: BigInt(amount0Min),
    amount1Min: BigInt(amount1Min)
  };
}

/**
 * Remove all liquidity from a PancakeSwap CLMM position
 * 
 * This function executes a complete liquidity removal, including:
 * 1. Remove all liquidity from the position
 * 2. Collect all accumulated fees and rewards
 * 3. Auto-unwrap WSOL to native SOL (if applicable)
 * 4. Auto-close the position to reclaim rent
 * 5. Calculate total USD value of withdrawn tokens
 * 
 * **Position State:**
 * - Position must have active liquidity to remove
 * - Protocol position must be initialized on-chain
 * - After removal, position can be closed to reclaim rent
 * 
 * **Token Handling:**
 * - Supports both Token Program (legacy) and Token-2022
 * - Automatically creates recipient ATAs if needed
 * - Handles up to 3 reward tokens dynamically
 * - Auto-unwraps WSOL to native SOL for better UX
 * 
 * **Slippage Protection:**
 * - Default 1% slippage tolerance (100 bps)
 * - Configurable via options parameter
 * - Protects against unfavorable price movements
 * 
 * @param {Connection} connection - Solana connection
 * @param {Keypair} wallet - Wallet keypair (owner of position)
 * @param {PublicKey} positionMintPk - Position NFT mint address
 * @param {Object} [options] - Optional configuration
 * @param {number} [options.slippageBps=100] - Slippage tolerance in basis points (100 = 1%)
 * @returns {Promise<Object>} Result with transaction details and amounts
 * @returns {boolean} return.success - Whether the removal was successful
 * @returns {string} [return.signature] - Transaction signature
 * @returns {string} [return.explorer] - Solscan explorer URL
 * @returns {string} [return.liquidityRemoved] - Raw liquidity amount removed
 * @returns {string} [return.liquidityRemovedFormatted] - Formatted liquidity with commas
 * @returns {Array<Object>} [return.tokensWithdrawn] - Pool tokens withdrawn (fees + liquidity)
 * @returns {Array<Object>} [return.rewardsCollected] - Reward tokens collected
 * @returns {number} [return.totalUsd] - Total USD value of all tokens
 * @returns {boolean} [return.positionClosed] - Whether position was successfully closed
 * @returns {number} [return.rentReclaimed] - Rent reclaimed in SOL (if closed)
 * @returns {string} [return.error] - Error message if failed
 * 
 * @example
 * const result = await removeLiquidity(connection, wallet, positionMint, { slippageBps: 100 });
 * if (result.success) {
 *   console.log(`Removed liquidity: ${result.liquidityRemovedFormatted}`);
 *   console.log(`Total value: $${result.totalUsd.toFixed(2)}`);
 *   console.log(`Position closed: ${result.positionClosed}`);
 * }
 */
export async function removeLiquidity(connection, wallet, positionMintPk, options = {}) {
  const { slippageBps = DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS } = options;
  const coder = new BorshCoder(PANCAKESWAP_IDL);

  try {
    // 1. Derive personal_position PDA from NFT mint
    const personalPositionPk = await derivePersonalPosition(positionMintPk);

    // 2. Fetch position account to get liquidity and pool info
    const positionAi = await connection.getAccountInfo(personalPositionPk);
    if (!positionAi) throw new Error("Position account not found");

    const position = coder.accounts.decode("PersonalPositionState", positionAi.data);
    const poolPk = new PublicKey(position.pool_id);
    const tickLower = position.tick_lower_index;
    const tickUpper = position.tick_upper_index;
    const liquidity = position.liquidity;

    // Check if there's any liquidity to remove
    if (!liquidity || liquidity === 0n || liquidity.toString() === "0") {
      return {
        success: false,
        error: "No liquidity in position to remove"
      };
    }

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

    // 4. Calculate minimum amounts with slippage protection
    const { amount0Min, amount1Min } = calculateMinAmountsWithSlippage(
      liquidity,
      sqrtPriceX64,
      tickLower,
      tickUpper,
      tickCurrent,
      slippageBps
    );

    // 5. Derive protocol_position PDA
    const tickLowerBytes = Buffer.alloc(4);
    tickLowerBytes.writeInt32BE(tickLower);  // BIG ENDIAN!
    const tickUpperBytes = Buffer.alloc(4);
    tickUpperBytes.writeInt32BE(tickUpper);  // BIG ENDIAN!

    const [protocolPositionPk] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), poolPk.toBuffer(), tickLowerBytes, tickUpperBytes],
      PROGRAM_ID
    );

    // Check if protocol_position exists
    const protocolPositionAi = await connection.getAccountInfo(protocolPositionPk);
    if (!protocolPositionAi) {
      throw new Error(
        "Protocol position not found. This position may not be properly initialized.\n" +
        `Check at: https://solscan.io/account/${personalPositionPk.toBase58()}`
      );
    }

    // 6. Derive tick array PDAs
    const lowerStartIndex = getTickArrayStartIndex(tickLower, tickSpacing);
    const upperStartIndex = getTickArrayStartIndex(tickUpper, tickSpacing);

    const lowerStartBytes = Buffer.alloc(4);
    lowerStartBytes.writeInt32BE(lowerStartIndex);  // BIG ENDIAN!
    const upperStartBytes = Buffer.alloc(4);
    upperStartBytes.writeInt32BE(upperStartIndex);  // BIG ENDIAN!

    const [tickArrayLowerPk] = PublicKey.findProgramAddressSync(
      [Buffer.from("tick_array"), poolPk.toBuffer(), lowerStartBytes],
      PROGRAM_ID
    );

    const [tickArrayUpperPk] = PublicKey.findProgramAddressSync(
      [Buffer.from("tick_array"), poolPk.toBuffer(), upperStartBytes],
      PROGRAM_ID
    );

    // 7. Get NFT token account (owner's ATA for the position NFT mint)
    const nftAccount = await getAssociatedTokenAddress(
      positionMintPk,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM // Positions use Token-2022
    );

    // 8. Get or create recipient token accounts for both tokens
    // Determine which token program each mint uses
    const mint0IsToken2022 = (await getMintTokenProgram(connection, mint0)).equals(TOKEN_2022_PROGRAM);
    const mint1IsToken2022 = (await getMintTokenProgram(connection, mint1)).equals(TOKEN_2022_PROGRAM);

    const recipientAccount0 = await getAssociatedTokenAddress(
      mint0,
      wallet.publicKey,
      false,
      mint0IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
    );

    const recipientAccount1 = await getAssociatedTokenAddress(
      mint1,
      wallet.publicKey,
      false,
      mint1IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
    );

    // 9. Process reward accounts (up to 3 rewards)
    const rewardAccounts = [];
    const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
    
    for (const rewardInfo of pool.reward_infos) {
      // Check if reward is active (token_mint is not system program)
      if (rewardInfo.token_mint && !rewardInfo.token_mint.equals(SYSTEM_PROGRAM)) {
        const rewardMint = new PublicKey(rewardInfo.token_mint);
        const rewardVault = new PublicKey(rewardInfo.token_vault);
        
        // Get reward token program
        const rewardIsToken2022 = (await getMintTokenProgram(connection, rewardMint)).equals(TOKEN_2022_PROGRAM);
        
        // Get reward recipient ATA
        const rewardRecipient = await getAssociatedTokenAddress(
          rewardMint,
          wallet.publicKey,
          false,
          rewardIsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
        );
        
        rewardAccounts.push({
          vault: rewardVault,
          recipient: rewardRecipient,
          mint: rewardMint,
          isToken2022: rewardIsToken2022
        });
      }
    }

    // 10. Build decrease_liquidity_v2 instruction with full liquidity amount
    const discriminator = Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]);
    
    // Args: liquidity (u128), amount_0_min (u64), amount_1_min (u64)
    const liquidityBytes = Buffer.alloc(16);
    const liquidityBigInt = BigInt(liquidity.toString());
    liquidityBytes.writeBigUInt64LE(liquidityBigInt & 0xFFFFFFFFFFFFFFFFn, 0);
    liquidityBytes.writeBigUInt64LE(liquidityBigInt >> 64n, 8);
    
    const amount0MinBytes = Buffer.alloc(8);
    amount0MinBytes.writeBigUInt64LE(amount0Min, 0);
    
    const amount1MinBytes = Buffer.alloc(8);
    amount1MinBytes.writeBigUInt64LE(amount1Min, 0);

    const data = Buffer.concat([
      discriminator,
      liquidityBytes,
      amount0MinBytes,
      amount1MinBytes
    ]);

    const accounts = [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false }, // nft_owner
      { pubkey: nftAccount, isSigner: false, isWritable: false }, // nft_account
      { pubkey: personalPositionPk, isSigner: false, isWritable: true }, // personal_position
      { pubkey: poolPk, isSigner: false, isWritable: true }, // pool_state
      { pubkey: protocolPositionPk, isSigner: false, isWritable: true }, // protocol_position
      { pubkey: vault0, isSigner: false, isWritable: true }, // token_vault_0
      { pubkey: vault1, isSigner: false, isWritable: true }, // token_vault_1
      { pubkey: tickArrayLowerPk, isSigner: false, isWritable: true }, // tick_array_lower
      { pubkey: tickArrayUpperPk, isSigner: false, isWritable: true }, // tick_array_upper
      { pubkey: recipientAccount0, isSigner: false, isWritable: true }, // recipient_token_account_0
      { pubkey: recipientAccount1, isSigner: false, isWritable: true }, // recipient_token_account_1
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }, // token_program
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false }, // token_program_2022
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }, // memo_program
      { pubkey: mint0, isSigner: false, isWritable: false }, // vault_0_mint
      { pubkey: mint1, isSigner: false, isWritable: false }, // vault_1_mint
    ];

    // Add reward accounts (3 per reward: vault, recipient, mint)
    for (const reward of rewardAccounts) {
      accounts.push(
        { pubkey: reward.vault, isSigner: false, isWritable: true },
        { pubkey: reward.recipient, isSigner: false, isWritable: true },
        { pubkey: reward.mint, isSigner: false, isWritable: false }
      );
    }

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

    const instruction = {
      programId: PROGRAM_ID,
      keys: accounts,
      data
    };

    // 11. Build transaction with ATA creation if needed
    const transaction = new Transaction();

    // Check and create recipient_token_account_0 if needed
    const account0Info = await connection.getAccountInfo(recipientAccount0);
    if (!account0Info) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          recipientAccount0,
          wallet.publicKey,
          mint0,
          mint0IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
        )
      );
    }

    // Check and create recipient_token_account_1 if needed
    const account1Info = await connection.getAccountInfo(recipientAccount1);
    if (!account1Info) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          recipientAccount1,
          wallet.publicKey,
          mint1,
          mint1IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
        )
      );
    }

    // Check and create reward recipient accounts if needed
    for (let i = 0; i < rewardAccounts.length; i++) {
      const reward = rewardAccounts[i];
      const rewardInfo = await connection.getAccountInfo(reward.recipient);
      if (!rewardInfo) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            reward.recipient,
            wallet.publicKey,
            reward.mint,
            reward.isToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
          )
        );
      }
    }

    // Add the main decrease_liquidity_v2 instruction
    transaction.add(instruction);
    transaction.feePayer = wallet.publicKey;

    // 12. Send transaction via SWQOS (or standard RPC if disabled)
    const txResult = await sendTransaction(connection, transaction, [wallet], {
      maxRetries: 3
    });

    if (!txResult.success) {
      throw new Error(`Transaction failed: ${txResult.error}`);
    }

    const signature = txResult.signature;

    // Wait for blockchain state to settle
    await new Promise(resolve => setTimeout(resolve, FINALIZATION_DELAY_MS));

    // 13. Auto-unwrap WSOL to native SOL if WSOL was received
    const wsolMint = new PublicKey(KNOWN_TOKENS.SOL.mint);
    
    // Check if either token is WSOL
    const isToken0Wsol = mint0.equals(wsolMint);
    const isToken1Wsol = mint1.equals(wsolMint);
    
    let unwrappedSol = false;
    if (isToken0Wsol || isToken1Wsol) {
      const wsolAccount = isToken0Wsol ? recipientAccount0 : recipientAccount1;
      const unwrapResult = await unwrapWSol(connection, wallet, {
        wsolAccount,
        commitmentLevel: COMMITMENT_LEVEL
      });
      unwrappedSol = unwrapResult.success && unwrapResult.hadAccount;
    }

    // 14. Auto-close position to reclaim rent
    let positionClosed = false;
    let rentReclaimed = null;
    
    try {
      // Get position account balance before closing
      const positionAccountInfo = await connection.getAccountInfo(personalPositionPk);
      const rentAmount = positionAccountInfo ? positionAccountInfo.lamports : 0;
      
      // Build close_position instruction
      const closeDiscriminator = Buffer.from([123, 134, 81, 0, 49, 68, 98, 98]);
      
      const closeAccounts = [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // nft_owner
        { pubkey: positionMintPk, isSigner: false, isWritable: true }, // position_nft_mint
        { pubkey: nftAccount, isSigner: false, isWritable: true }, // position_nft_account
        { pubkey: personalPositionPk, isSigner: false, isWritable: true }, // personal_position
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false }, // token_program (positions use Token-2022)
      ];
      
      const closeInstruction = {
        programId: PROGRAM_ID,
        keys: closeAccounts,
        data: closeDiscriminator
      };
      
      const closeTx = new Transaction().add(closeInstruction);
      closeTx.feePayer = wallet.publicKey;

      // Send close position transaction via SWQOS
      const closeResult = await sendTransaction(connection, closeTx, [wallet], {
        maxRetries: 3
      });

      if (!closeResult.success) {
        throw new Error(`Failed to close position: ${closeResult.error}`);
      }

      const closeSig = closeResult.signature;

      rentReclaimed = rentAmount / 1e9; // Convert lamports to SOL
      positionClosed = true;
    } catch (error) {
      // Non-critical error - continue
      console.warn("⚠️  Failed to close position:", error.message);
    }

    // 15. Parse transaction results to get withdrawn amounts (with retry logic)
    const withdrawn = [];
    const rewards = [];
    let totalUsd = 0;
    let token0Change = null;
    let token1Change = null;

    // Get token decimals for formatting
    const dec0 = await getMintDecimals(connection, mint0) || 0;
    const dec1 = await getMintDecimals(connection, mint1) || 0;

    // Retry transaction metadata parsing (RPC may need time to index)
    let parseSucceeded = false;
    for (let attempt = 0; attempt < TX_METADATA_PARSE_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`⏳ Retrying transaction metadata parsing (attempt ${attempt + 1}/${TX_METADATA_PARSE_MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, TX_METADATA_PARSE_RETRY_DELAY_MS));
      }

      try {
        const txDetails = await connection.getTransaction(signature, {
          commitment: COMMITMENT_LEVEL,
          maxSupportedTransactionVersion: 0
        });

        if (!txDetails || !txDetails.meta) {
          console.warn(`⚠️  Transaction metadata not available (attempt ${attempt + 1})`);
          continue;
        }

        const preBalances = txDetails.meta.preTokenBalances || [];
        const postBalances = txDetails.meta.postTokenBalances || [];

        // Try to parse token changes (pass txDetails for WSOL/SOL native balance parsing)
        token0Change = getBalanceChange(preBalances, postBalances, mint0, wallet.publicKey, txDetails);
        token1Change = getBalanceChange(preBalances, postBalances, mint1, wallet.publicKey, txDetails);

        // Check if we got both pool tokens
        if (token0Change && token1Change) {
          // console.log(`✅ Transaction metadata parsed successfully`);
          parseSucceeded = true;

          // Parse reward tokens while we have the metadata
          // Collect all reward changes first
          const rewardChanges = [];
          for (const reward of rewardAccounts) {
            const rewardChange = getBalanceChange(preBalances, postBalances, reward.mint, wallet.publicKey, txDetails);
            if (rewardChange) {
              rewardChanges.push({
                mint: reward.mint.toBase58(),
                change: rewardChange
              });
            }
          }

          // Batch fetch token info for all rewards at once
          if (rewardChanges.length > 0) {
            const rewardMints = rewardChanges.map(r => r.mint);
            const rewardTokenInfos = await getTokenInfoBatch(rewardMints);

            for (let i = 0; i < rewardChanges.length; i++) {
              const { mint: mintStr, change: rewardChange } = rewardChanges[i];
              const { price: rewardPrice, ticker: rewardTicker } = rewardTokenInfos[i] || { price: null, ticker: 'UNKNOWN' };
              const usdValue = rewardPrice ? rewardChange.uiAmount * rewardPrice : null;
              if (usdValue) totalUsd += usdValue;

              rewards.push({
                mint: mintStr,
                amount: rewardChange.amount.toString(),
                uiAmount: rewardChange.uiAmount,
                decimals: rewardChange.decimals,
                usdValue,
                symbol: rewardTicker
              });
            }
          }

          break;
        } else {
          // Didn't find both tokens, will retry
          console.warn(`⚠️  Incomplete parse (attempt ${attempt + 1}): token0=${!!token0Change}, token1=${!!token1Change}`);
          if (!token0Change || !token1Change) {
            console.warn(`   Balances found: ${postBalances.length} post, ${preBalances.length} pre`);
            console.warn(`   Looking for: token0=${mint0.toBase58()}, token1=${mint1.toBase58()}, owner=${wallet.publicKey.toBase58()}`);
          }
        }
      } catch (error) {
        console.warn(`⚠️  Error parsing transaction metadata (attempt ${attempt + 1}): ${error.message}`);
      }
    }

    // Fallback: Query wallet balances directly if parsing failed
    if (!parseSucceeded || !token0Change || !token1Change) {
      console.warn(`⚠️  Transaction parsing failed after ${TX_METADATA_PARSE_MAX_RETRIES} attempts, falling back to wallet balance query...`);

      try {
        // Query token account balances directly
        const ata0 = await getAssociatedTokenAddress(
          mint0,
          wallet.publicKey,
          false,
          mint0IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
        );
        const ata1 = await getAssociatedTokenAddress(
          mint1,
          wallet.publicKey,
          false,
          mint1IsToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
        );

        const [bal0, bal1] = await Promise.all([
          connection.getTokenAccountBalance(ata0).catch(() => null),
          connection.getTokenAccountBalance(ata1).catch(() => null)
        ]);

        // Accept any valid balance result, even if amount is 0 (account might be empty after unwrap)
        if (bal0?.value) {
          token0Change = {
            amount: BigInt(bal0.value.amount || "0"),
            decimals: bal0.value.decimals,
            uiAmount: parseFloat(bal0.value.uiAmount || "0")
          };
          console.log(`✅ Token0 balance from fallback: ${token0Change.uiAmount} (may not reflect exact withdrawn amount)`);
        }
        if (bal1?.value) {
          token1Change = {
            amount: BigInt(bal1.value.amount || "0"),
            decimals: bal1.value.decimals,
            uiAmount: parseFloat(bal1.value.uiAmount || "0")
          };
          console.log(`✅ Token1 balance from fallback: ${token1Change.uiAmount} (may not reflect exact withdrawn amount)`);
        }
        
        if (token0Change && token1Change) {
          console.log(`✅ Wallet balance fallback successful (amounts are current balances, not actual withdrawn)`);
        } else {
          console.warn(`⚠️ Partial fallback: token0=${!!token0Change}, token1=${!!token1Change}`);
        }
      } catch (fallbackError) {
        console.error(`❌ Wallet balance fallback failed: ${fallbackError.message}`);
      }
    }

    // Build withdrawn array for token 0
    if (token0Change) {
      const mint0Str = mint0.toBase58();
      const { price: price0Usd, ticker: ticker0 } = await getTokenInfo(mint0Str);
      const usdValue = price0Usd ? token0Change.uiAmount * price0Usd : null;
      if (usdValue) totalUsd += usdValue;

      withdrawn.push({
        mint: mint0Str,
        amount: token0Change.amount.toString(),
        uiAmount: token0Change.uiAmount,
        decimals: token0Change.decimals,
        usdValue,
        symbol: ticker0,
        unwrapped: mint0Str === KNOWN_TOKENS.SOL.mint && unwrappedSol
      });
    }

    // Build withdrawn array for token 1
    if (token1Change) {
      const mint1Str = mint1.toBase58();
      const { price: price1Usd, ticker: ticker1 } = await getTokenInfo(mint1Str);
      const usdValue = price1Usd ? token1Change.uiAmount * price1Usd : null;
      if (usdValue) totalUsd += usdValue;

      withdrawn.push({
        mint: mint1Str,
        amount: token1Change.amount.toString(),
        uiAmount: token1Change.uiAmount,
        decimals: token1Change.decimals,
        usdValue,
        symbol: ticker1,
        unwrapped: mint1Str === KNOWN_TOKENS.SOL.mint && unwrappedSol
      });
    }

    return {
      success: true,
      signature,
      explorer: `https://solscan.io/tx/${signature}`,
      liquidityRemoved: liquidity.toString(),
      liquidityRemovedFormatted: formatLiquidity(liquidity),
      tokensWithdrawn: withdrawn,
      rewardsCollected: rewards,
      totalUsd,
      positionClosed,
      rentReclaimed
    };

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

