/**
 * Claim Rewards Utility
 * 
 * Pure utility functions for claiming rewards and fees from PancakeSwap CLMM positions.
 * This module handles the transaction building and execution for the decrease_liquidity_v2
 * instruction with liquidity = 0 (collect fees/rewards only).
 * 
 * @module claim.util
 */

import { Connection, PublicKey, Transaction, Keypair, SystemProgram } from "@solana/web3.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createCloseAccountInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import {
  PROGRAM_ID,
  MEMO_PROGRAM_ID,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  PANCAKESWAP_IDL,
  TICKS_IN_ARRAY,
  KNOWN_TOKENS,
  COMMITMENT_LEVEL,
  PREFLIGHT_COMMITMENT,
  SPLIT_CLAIM_PERCENT,
  SPLIT_KEEP_PERCENT
} from '../config/constants.js';
import { getTokenInfo, getTokenInfoBatch, unwrapWSol, getMintDecimals, getBalanceChange } from './token.util.js';
import { derivePersonalPosition } from './accounts.util.js';
import { sendTransaction } from './swqos.util.js';

// Debug logging flag
const isDebug = process.env.LOG_LEVEL === 'debug';

/**
 * Transfer claimed tokens to claim address
 * 
 * Transfers all claimed tokens (excluding dust < $0.10) to the specified claim address.
 * Creates destination token accounts if needed.
 * Handles native SOL transfers separately from token transfers.
 * 
 * For SOL transfers: If claimed amount > 0.01 SOL, deducts 0.01 SOL and keeps it in 
 * the wallet for transaction fees. If claimed amount <= 0.01 SOL, transfers the full amount.
 * 
 * **Split Strategy Feature:**
 * If splitStrategy is enabled, only transfers SPLIT_CLAIM_PERCENT (default 75%) to claimAddress.
 * The remaining portion (25%) stays in the current wallet untouched.
 * 
 * @param {Connection} connection - Solana connection
 * @param {Keypair} wallet - User wallet keypair (source)
 * @param {string} claimAddress - Destination address for claimed tokens
 * @param {Array<Object>} claimedTokens - Array of claimed tokens from claimRewards
 * @param {boolean} unwrappedSol - Whether WSOL was unwrapped to native SOL
 * @param {boolean} splitStrategy - Whether to only transfer partial amount (SPLIT_CLAIM_PERCENT)
 * @returns {Promise<Object>} Result with transfer details
 * @returns {boolean} return.transferred - Whether transfer was successful
 * @returns {number} [return.solFeeReserved] - Amount of SOL kept in wallet for fees (0 or 0.01)
 */
export async function transferToClaimAddress(connection, wallet, claimAddress, claimedTokens, unwrappedSol = false, splitStrategy = false) {
  const DUST_THRESHOLD_USD = 0.10; // Skip tokens worth less than $0.10
  const claimPubkey = new PublicKey(claimAddress);
  const wsolMint = KNOWN_TOKENS.SOL.mint;
  
  try {
    // Filter out dust
    const tokensToTransfer = claimedTokens.filter(token => {
      const usdValue = token.usdValue || 0;
      return usdValue >= DUST_THRESHOLD_USD;
    });
    
    if (tokensToTransfer.length === 0) {
      return {
        transferred: false,
        reason: 'all_dust',
        skippedDust: claimedTokens.length
      };
    }
    
    const transaction = new Transaction();
    const transferred = [];
    const skipped = [];
    
    // Build transfer instructions for each token
    for (const token of claimedTokens) {
      const usdValue = token.usdValue || 0;
      
      // Skip dust
      if (usdValue < DUST_THRESHOLD_USD) {
        skipped.push({
          mint: token.mint,
          symbol: token.symbol,
          uiAmount: token.uiAmount,
          usdValue,
          reason: 'dust'
        });
        continue;
      }
      
      try {
        // Handle WSOL that was unwrapped to native SOL
        if (unwrappedSol && token.mint === wsolMint) {
          // Transfer native SOL using SystemProgram
          const SOL_FEE_RESERVE = 10_000_000n; // 0.01 SOL in lamports
          const lamports = BigInt(token.amount);
          
          // If we have more than 0.01 SOL, deduct it for fees
          const feeReserveKept = lamports > SOL_FEE_RESERVE;
          const totalTransferAmount = feeReserveKept 
            ? lamports - SOL_FEE_RESERVE 
            : lamports;
          
          if (splitStrategy) {
            // Split: only transfer SPLIT_CLAIM_PERCENT to claim address, keep rest in wallet
            const claimAmount = BigInt(Math.floor(Number(totalTransferAmount) * SPLIT_CLAIM_PERCENT));
            const keptAmount = totalTransferAmount - claimAmount;
            
            // Transfer only claim portion to claim address (rest stays in wallet)
            transaction.add(
              SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: claimPubkey,
                lamports: claimAmount
              })
            );
            
            transferred.push({
              mint: token.mint,
              symbol: 'SOL',
              type: token.type,
              uiAmount: Number(claimAmount) / 1e9,
              usdValue: (Number(claimAmount) / Number(lamports)) * usdValue,
              amount: claimAmount.toString(),
              native: true,
              feeReserveKept: feeReserveKept ? 0.01 : 0,
              splitTransfer: true,
              claimAmount: Number(claimAmount) / 1e9,
              keptAmount: Number(keptAmount) / 1e9,
              claimPercent: SPLIT_CLAIM_PERCENT,
              keepPercent: SPLIT_KEEP_PERCENT
            });
          } else {
            // Transfer 100% to claim address (existing behavior)
            transaction.add(
              SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: claimPubkey,
                lamports: totalTransferAmount
              })
            );
            
            transferred.push({
              mint: token.mint,
              symbol: 'SOL',
              type: token.type,
              uiAmount: Number(totalTransferAmount) / 1e9,
              usdValue: (Number(totalTransferAmount) / Number(lamports)) * usdValue,
              amount: totalTransferAmount.toString(),
              native: true,
              feeReserveKept: feeReserveKept ? 0.01 : 0
            });
          }
          continue;
        }
        
        // Handle regular token transfers
        const mintPk = new PublicKey(token.mint);
        
        // Get source account (user's ATA) with both token programs to find which one exists
        let sourceAccount;
        let tokenProgram;
        let sourceAccountInfo;
        
        // Try Token-2022 first
        const sourceAccountToken2022 = await getAssociatedTokenAddress(
          mintPk,
          wallet.publicKey,
          false,
          TOKEN_2022_PROGRAM
        );
        sourceAccountInfo = await connection.getAccountInfo(sourceAccountToken2022);
        
        if (sourceAccountInfo) {
          sourceAccount = sourceAccountToken2022;
          tokenProgram = TOKEN_2022_PROGRAM;
        } else {
          // Try legacy Token Program
          const sourceAccountTokenProgram = await getAssociatedTokenAddress(
            mintPk,
            wallet.publicKey,
            false,
            TOKEN_PROGRAM
          );
          sourceAccountInfo = await connection.getAccountInfo(sourceAccountTokenProgram);
          
          if (sourceAccountInfo) {
            sourceAccount = sourceAccountTokenProgram;
            tokenProgram = TOKEN_PROGRAM;
          } else {
            // Source account doesn't exist - skip this token
            throw new Error('Source token account not found');
          }
        }
        
        // Parse source account to verify it has balance
        const parsedSource = await connection.getParsedAccountInfo(sourceAccount);
        const sourceBalance = parsedSource?.value?.data?.parsed?.info?.tokenAmount?.amount;
        if (!sourceBalance || BigInt(sourceBalance) === 0n) {
          throw new Error('Source account has zero balance');
        }
        
        const totalAmount = BigInt(token.amount);
        
        if (splitStrategy) {
          // Split: only transfer SPLIT_CLAIM_PERCENT to claim address, keep rest in wallet
          const claimAmount = BigInt(Math.floor(Number(totalAmount) * SPLIT_CLAIM_PERCENT));
          const keptAmount = totalAmount - claimAmount;
          
          // Get destination account for claim address
          const claimDestAccount = await getAssociatedTokenAddress(
            mintPk,
            claimPubkey,
            false,
            tokenProgram
          );
          
          // Check if claim destination account exists, create if not
          const claimDestAccountInfo = await connection.getAccountInfo(claimDestAccount);
          if (!claimDestAccountInfo) {
            transaction.add(
              createAssociatedTokenAccountInstruction(
                wallet.publicKey, // payer
                claimDestAccount,
                claimPubkey, // owner
                mintPk,
                tokenProgram
              )
            );
          }
          
          // Add transfer instruction for claim portion only (rest stays in wallet)
          transaction.add(
            createTransferCheckedInstruction(
              sourceAccount,
              mintPk,
              claimDestAccount,
              wallet.publicKey,
              claimAmount,
              token.decimals,
              [],
              tokenProgram
            )
          );
          
          transferred.push({
            mint: token.mint,
            symbol: token.symbol,
            type: token.type,
            uiAmount: Number(claimAmount) / (10 ** token.decimals),
            usdValue: usdValue * SPLIT_CLAIM_PERCENT,
            amount: claimAmount.toString(),
            splitTransfer: true,
            claimAmount: Number(claimAmount) / (10 ** token.decimals),
            keptAmount: Number(keptAmount) / (10 ** token.decimals),
            claimPercent: SPLIT_CLAIM_PERCENT,
            keepPercent: SPLIT_KEEP_PERCENT
          });
        } else {
          // Transfer 100% to claim address (existing behavior)
          const destinationAccount = await getAssociatedTokenAddress(
            mintPk,
            claimPubkey,
            false,
            tokenProgram
          );
          
          // Check if destination account exists, create if not
          const destAccountInfo = await connection.getAccountInfo(destinationAccount);
          if (!destAccountInfo) {
            transaction.add(
              createAssociatedTokenAccountInstruction(
                wallet.publicKey, // payer
                destinationAccount,
                claimPubkey, // owner
                mintPk,
                tokenProgram
              )
            );
          }
          
          // Add transfer instruction
          transaction.add(
            createTransferCheckedInstruction(
              sourceAccount,
              mintPk,
              destinationAccount,
              wallet.publicKey,
              totalAmount,
              token.decimals,
              [],
              tokenProgram
            )
          );
          
          transferred.push({
            mint: token.mint,
            symbol: token.symbol,
            type: token.type,
            uiAmount: token.uiAmount,
            usdValue,
            amount: token.amount
          });
        }
        
      } catch (error) {
        skipped.push({
          mint: token.mint,
          symbol: token.symbol,
          uiAmount: token.uiAmount,
          usdValue,
          reason: error.message
        });
      }
    }
    
    if (transferred.length === 0) {
      return {
        transferred: false,
        reason: 'no_valid_tokens',
        skipped
      };
    }
    
    // Send transaction via SWQOS (or standard RPC if disabled)
    transaction.feePayer = wallet.publicKey;
    
    const result = await sendTransaction(connection, transaction, [wallet], {
      maxRetries: 3
    });
    
    if (!result.success) {
      throw new Error(`Transfer failed: ${result.error}`);
    }
    
    const signature = result.signature;
    
    const totalTransferredUsd = transferred.reduce((sum, t) => sum + (t.usdValue || 0), 0);
    const solFeeReserved = transferred.find(t => t.native && t.feeReserveKept)?.feeReserveKept || 0;
    
    return {
      transferred: true,
      signature,
      explorer: `https://solscan.io/tx/${signature}`,
      claimAddress,
      tokens: transferred,
      totalUsd: totalTransferredUsd,
      skipped,
      tokenCount: transferred.length,
      solFeeReserved, // Amount of SOL kept in wallet for fees (0 or 0.01)
      splitStrategy // Whether split strategy was used (partial transfer, rest kept in wallet)
    };
    
  } catch (error) {
    return {
      transferred: false,
      error: error.message
    };
  }
}

// REMOVED: Duplicate getMintDecimals() function
// Now using Redis-cached version from token.util.js (100x faster: 200ms → 2ms)

/**
 * Convert token amount to human-readable number
 * 
 * @param {string|bigint} amount - Raw token amount
 * @param {number} decimals - Token decimals
 * @returns {number} Human-readable amount
 */
function toNumberUnits(amount, decimals) {
  try {
    const n = BigInt(amount);
    const d = 10 ** (Number(decimals) || 0);
    return Number(n) / d;
  } catch {
    return 0;
  }
}

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
 * Claim all rewards and fees from a PancakeSwap CLMM position
 * 
 * This function executes a decrease_liquidity_v2 instruction with liquidity = 0,
 * which collects all accumulated fees and rewards without closing the position.
 * 
 * **Universal Reward Handling:**
 * - Automatically detects 0-3 active reward tokens from the pool
 * - Validates each reward (mint, vault, on-chain existence)
 * - Dynamically builds transaction accounts based on active rewards
 * - Handles both Token Program (legacy) and Token-2022 for all tokens
 * - Parses actual claimed amounts from transaction balance changes
 * 
 * **Claimed Token Types:**
 * 1. Fee Token 0 - Trading fees in first pool token
 * 2. Fee Token 1 - Trading fees in second pool token
 * 3. Reward Tokens - Up to 3 additional reward tokens (variable)
 * 
 * **Claim Address Feature:**
 * - If claimAddress is provided, automatically transfers all claimed tokens to that address
 * - Skips dust transfers (tokens worth less than $0.10)
 * - Creates destination token accounts as needed
 * - For SOL: If amount > 0.01 SOL, keeps 0.01 SOL in wallet for fees
 * 
 * **Split Strategy Feature:**
 * - If splitStrategy is enabled, only SPLIT_CLAIM_PERCENT (default 75%) is transferred to claimAddress
 * - Remaining tokens stay in the current wallet untouched
 * 
 * @param {Connection} connection - Solana connection
 * @param {Keypair} wallet - Wallet keypair (owner of position)
 * @param {PublicKey} positionMintPk - Position NFT mint address
 * @param {string|null} [claimAddress=null] - Optional destination address for claimed tokens
 * @param {boolean} [splitStrategy=false] - Whether to only transfer partial amount (SPLIT_CLAIM_PERCENT)
 * @returns {Promise<Object>} Result with transaction signature and claimed amounts
 * @returns {boolean} return.success - Whether the claim was successful
 * @returns {string} [return.signature] - Transaction signature
 * @returns {string} [return.explorer] - Solscan explorer URL
 * @returns {Array<Object>} [return.claimed] - Array of claimed tokens (fees + rewards)
 * @returns {number} [return.totalUsd] - Total USD value of claimed tokens
 * @returns {boolean} [return.unwrappedSol] - Whether WSOL was unwrapped to native SOL
 * @returns {number} [return.transactionFee] - Transaction fee in SOL
 * @returns {number} [return.transactionFeeLamports] - Transaction fee in lamports
 * @returns {Object} [return.transfer] - Transfer details if claimAddress was used
 * @returns {number} [return.transfer.solFeeReserved] - Amount of SOL kept for fees (0 or 0.01)
 * @returns {string} [return.error] - Error message if failed
 * 
 * @example
 * // Claim to wallet
 * const result = await claimRewards(connection, wallet, positionMint);
 * 
 * @example
 * // Claim and transfer to another address
 * const result = await claimRewards(connection, wallet, positionMint, 'DestinationAddress...');
 * if (result.success && result.transfer?.transferred) {
 *   console.log(`Transferred ${result.transfer.tokenCount} tokens to claim address`);
 * }
 * 
 * @example
 * // Claim with split strategy (75% transferred, 25% kept in wallet)
 * const result = await claimRewards(connection, wallet, positionMint, 'ClaimAddress...', true);
 * if (result.success && result.transfer?.splitStrategy) {
 *   console.log(`Partial transfer: 75% sent, 25% kept in wallet`);
 * }
 */
export async function claimRewards(connection, wallet, positionMintPk, claimAddress = null, splitStrategy = false) {
  const coder = new BorshCoder(PANCAKESWAP_IDL);

  try {
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

    // 4. Derive protocol_position PDA
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
        "Protocol position not initialized. This can happen if:\n" +
        "1. Position has zero liquidity (never added any)\n" +
        "2. Position was closed\n" +
        "3. This is a new position that hasn't been used yet\n\n" +
        `Check your position at: https://solscan.io/account/${personalPositionPk.toBase58()}`
      );
    }

    // 5. Derive tick array PDAs
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

    // 6. Get NFT token account (owner's ATA for the position NFT mint)
    const nftAccount = await getAssociatedTokenAddress(
      positionMintPk,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM
    );

    // 7. Determine token programs for each mint
    const mint0Info = await connection.getParsedAccountInfo(mint0);
    const mint1Info = await connection.getParsedAccountInfo(mint1);
    
    const mint0IsToken2022 = mint0Info.value?.owner.equals(TOKEN_2022_PROGRAM);
    const mint1IsToken2022 = mint1Info.value?.owner.equals(TOKEN_2022_PROGRAM);

    // 8. Get recipient token accounts for both tokens
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

    // 9. Process reward accounts (up to 3 rewards from pool)
    const rewardAccounts = [];
    const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
    
    // Pool has reward_infos array (max 3 rewards)
    if (pool.reward_infos && Array.isArray(pool.reward_infos)) {
      for (let i = 0; i < pool.reward_infos.length; i++) {
        const rewardInfo = pool.reward_infos[i];
        
        // Check if reward is active:
        // 1. token_mint must exist and not be system program
        // 2. token_vault must exist and not be system program
        // 3. reward_state should indicate active (non-zero)
        const hasValidMint = rewardInfo.token_mint && 
                            !rewardInfo.token_mint.equals(SYSTEM_PROGRAM);
        const hasValidVault = rewardInfo.token_vault && 
                             !rewardInfo.token_vault.equals(SYSTEM_PROGRAM);
        
        if (!hasValidMint || !hasValidVault) {
          continue; // Skip inactive reward slot
        }
        
        try {
          const rewardMint = new PublicKey(rewardInfo.token_mint);
          const rewardVault = new PublicKey(rewardInfo.token_vault);
          
          // Verify reward vault exists on-chain
          const vaultInfo = await connection.getAccountInfo(rewardVault);
          if (!vaultInfo) {
            continue; // Skip if vault doesn't exist
          }
          
          // Get reward token program (legacy or Token-2022)
          const rewardMintInfo = await connection.getParsedAccountInfo(rewardMint);
          if (!rewardMintInfo?.value) {
            continue; // Skip if mint doesn't exist
          }
          
          const rewardIsToken2022 = rewardMintInfo.value.owner.equals(TOKEN_2022_PROGRAM);
          
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
            isToken2022: rewardIsToken2022,
            index: i
          });
        } catch (error) {
          // Skip this reward if there's any error processing it
          continue;
        }
      }
    }

    // 10. Build decrease_liquidity_v2 instruction with liquidity = 0 (just collect fees/rewards)
    const discriminator = Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]);
    
    // Args: liquidity (u128), amount_0_min (u64), amount_1_min (u64)
    const liquidityBytes = Buffer.alloc(16);
    liquidityBytes.writeBigUInt64LE(0n, 0);
    liquidityBytes.writeBigUInt64LE(0n, 8);
    
    const amount0MinBytes = Buffer.alloc(8);
    amount0MinBytes.writeBigUInt64LE(0n, 0);
    
    const amount1MinBytes = Buffer.alloc(8);
    amount1MinBytes.writeBigUInt64LE(0n, 0);

    const data = Buffer.concat([
      discriminator,
      liquidityBytes,
      amount0MinBytes,
      amount1MinBytes
    ]);

    const accounts = [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: nftAccount, isSigner: false, isWritable: false },
      { pubkey: personalPositionPk, isSigner: false, isWritable: true },
      { pubkey: poolPk, isSigner: false, isWritable: true },
      { pubkey: protocolPositionPk, isSigner: false, isWritable: true },
      { pubkey: vault0, isSigner: false, isWritable: true },
      { pubkey: vault1, isSigner: false, isWritable: true },
      { pubkey: tickArrayLowerPk, isSigner: false, isWritable: true },
      { pubkey: tickArrayUpperPk, isSigner: false, isWritable: true },
      { pubkey: recipientAccount0, isSigner: false, isWritable: true },
      { pubkey: recipientAccount1, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: mint0, isSigner: false, isWritable: false },
      { pubkey: mint1, isSigner: false, isWritable: false },
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
    for (const reward of rewardAccounts) {
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

    // 12.1 Extract transaction fee
    let transactionFee = 0; // Fee in lamports
    let transactionFeeSol = 0; // Fee in SOL
    try {
      const txFeeDetails = await connection.getTransaction(signature, {
        commitment: COMMITMENT_LEVEL,
        maxSupportedTransactionVersion: 0
      });
      if (txFeeDetails?.meta?.fee) {
        transactionFee = txFeeDetails.meta.fee;
        transactionFeeSol = transactionFee / 1_000_000_000; // Convert lamports to SOL
        if (isDebug) console.log(`💎 Transaction fee: ${transactionFeeSol.toFixed(6)} SOL (${transactionFee.toLocaleString()} lamports)`);
      }
    } catch (feeError) {
      console.warn(`⚠️  Could not fetch transaction fee: ${feeError.message}`);
      // Non-fatal - continue without fee data
    }

    // 12.2 Auto-unwrap WSOL to native SOL if WSOL was claimed
    const wsolMint = new PublicKey(KNOWN_TOKENS.SOL.mint);
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

    // 13. Parse transaction results
    // Parse token balance changes to determine what was actually claimed
    const txDetails = await connection.getTransaction(signature, {
      commitment: COMMITMENT_LEVEL,
      maxSupportedTransactionVersion: 0
    });

    const preBalances = txDetails?.meta?.preTokenBalances || [];
    const postBalances = txDetails?.meta?.postTokenBalances || [];

    const claimed = [];
    let totalUsd = 0;

    // Collect all balance changes first (fees + rewards)
    const allChanges = [];
    
    // Process fee token 0 (pass txDetails for WSOL/SOL native balance parsing)
    const fee0Change = getBalanceChange(preBalances, postBalances, mint0, wallet.publicKey, txDetails);
    if (fee0Change) {
      allChanges.push({
        type: "Fee",
        mint: mint0.toBase58(),
        change: fee0Change
      });
    }

    // Process fee token 1 (pass txDetails for WSOL/SOL native balance parsing)
    const fee1Change = getBalanceChange(preBalances, postBalances, mint1, wallet.publicKey, txDetails);
    if (fee1Change) {
      allChanges.push({
        type: "Fee",
        mint: mint1.toBase58(),
        change: fee1Change
      });
    }

    // Process reward tokens (0-3 rewards dynamically)
    for (let i = 0; i < rewardAccounts.length; i++) {
      const reward = rewardAccounts[i];
      const rewardChange = getBalanceChange(preBalances, postBalances, reward.mint, wallet.publicKey, txDetails);
      if (rewardChange) {
        allChanges.push({
          type: "Reward",
          mint: reward.mint.toBase58(),
          change: rewardChange,
          rewardIndex: reward.index
        });
      }
    }

    // Batch fetch token info for all claimed tokens at once
    if (allChanges.length > 0) {
      const allMints = allChanges.map(c => c.mint);
      const tokenInfos = await getTokenInfoBatch(allMints);

      for (let i = 0; i < allChanges.length; i++) {
        const { type, mint: mintStr, change, rewardIndex } = allChanges[i];
        const { price, ticker } = tokenInfos[i] || { price: null, ticker: 'UNKNOWN' };
        const usdValue = price ? change.uiAmount * price : null;
        if (usdValue) totalUsd += usdValue;

        const claimedItem = {
          type,
          mint: mintStr,
          amount: change.amount.toString(),
          uiAmount: change.uiAmount,
          decimals: change.decimals,
          usdValue,
          symbol: ticker
        };

        if (type === "Reward") {
          claimedItem.rewardIndex = rewardIndex;
        }

        claimed.push(claimedItem);
      }
    }

    // 14. Transfer to claim address if specified
    let transferResult = null;
    if (claimAddress && claimed.length > 0) {
      if (splitStrategy && isDebug) {
        console.log(`🎯 Transferring claimed tokens with split strategy:`);
        console.log(`   ${(SPLIT_CLAIM_PERCENT * 100).toFixed(0)}% → ${claimAddress}`);
        console.log(`   ${(SPLIT_KEEP_PERCENT * 100).toFixed(0)}% kept in wallet`);
      } else if (isDebug) {
        console.log(`🎯 Transferring claimed tokens to claim address: ${claimAddress}`);
      }
      
      transferResult = await transferToClaimAddress(
        connection, 
        wallet, 
        claimAddress, 
        claimed, 
        unwrappedSol, 
        splitStrategy
      );
      
      if (transferResult.transferred) {
        if (isDebug) {
          console.log(`✅ Transferred ${transferResult.tokenCount} tokens worth $${transferResult.totalUsd.toFixed(2)}`);
          if (transferResult.splitStrategy) {
            console.log(`   ${(SPLIT_CLAIM_PERCENT * 100).toFixed(0)}% transferred, ${(SPLIT_KEEP_PERCENT * 100).toFixed(0)}% kept in wallet`);
          }
          if (transferResult.solFeeReserved > 0) {
            console.log(`💰 Kept ${transferResult.solFeeReserved} SOL in wallet for transaction fees`);
          }
          if (transferResult.skipped?.length > 0) {
            console.log(`⏭️  Skipped ${transferResult.skipped.length} dust tokens (< $0.10)`);
          }
        }
      } else if (transferResult.error) {
        console.warn(`⚠️  Transfer to claim address failed: ${transferResult.error}`);
      } else if (transferResult.reason === 'all_dust' && isDebug) {
        console.log(`⏭️  All claimed tokens are dust (< $0.10), skipped transfer`);
      }
    }

    return {
      success: true,
      signature,
      explorer: `https://solscan.io/tx/${signature}`,
      claimed,
      totalUsd,
      unwrappedSol,
      transfer: transferResult,
      transactionFee: transactionFeeSol, // Fee in SOL
      transactionFeeLamports: transactionFee, // Fee in lamports
      metadata: {
        poolHadRewards: rewardAccounts.length > 0,
        activeRewardCount: rewardAccounts.length,
        feeTokensClaimed: [fee0Change, fee1Change].filter(Boolean).length,
        rewardTokensClaimed: claimed.filter(c => c.type === "Reward").length,
        claimAddressUsed: claimAddress ? true : false,
        tokensTransferred: transferResult?.transferred || false
      }
    };

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

