import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, KNOWN_TOKENS, SPLIT_CLAIM_PERCENT, SPLIT_KEEP_PERCENT } from '../../config/constants.js';
import { sendTransaction } from '../../utils/swqos.util.js';

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
 * @param {Function} send - Transaction sender (defaults to existing Solana routing)
 * @returns {Promise<Object>} Result with transfer details
 * @returns {boolean} return.transferred - Whether transfer was successful
 * @returns {number} [return.solFeeReserved] - Amount of SOL kept in wallet for fees (0 or 0.01)
 */
export async function transferToClaimAddress(connection, wallet, claimAddress, claimedTokens, unwrappedSol = false, splitStrategy = false, send = sendTransaction) {
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
    
    const result = await send(connection, transaction, [wallet], {
      maxRetries: 3
    });
    
    if (!result.success) {
      return { transferred: false, error: result.error, signature: result.signature, uncertain: result.uncertain };
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

