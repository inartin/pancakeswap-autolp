/**
 * Helius SWQOS (Staked Weighted Quality of Service) Transaction Utility
 * 
 * Reliable, cost-effective transaction delivery for Solana via Helius Sender API.
 * Routes transactions through stake-weighted validators for 95-99% success rates.
 * 
 * **When to use SWQOS:**
 * - Non-MEV transactions (claims, liquidity operations, transfers)
 * - Production environments requiring high reliability
 * - Operations where speed matters but MEV protection isn't critical
 * 
 * **When NOT to use:**
 * - MEV-sensitive operations (large swaps, arbitrage)
 * - Use Jupiter Ultra for swaps instead
 * 
 * **Performance:**
 * - Success rate: 95-99% (vs 40-70% standard RPC)
 * - Confirmation: <1s (vs 2-5s standard RPC)
 * - Cost: ~$0.0008 per tx (~$0.0003 priority fee + ~$0.0005 SWQOS tip)
 * 
 * **Technical Details:**
 * - Sends via https://sender.helius-rpc.com/fast?swqos_only=true
 * - Adds 5,000 lamports (0.000005 SOL) tip to random tip account
 * - Requires skipPreflight: true for Sender API
 * - Keeps dynamic priority fees from Helius API for optimal processing
 * - Maintains retry logic with fresh blockhash on each attempt
 * 
 * @module swqos.util
 */

import { Connection, SystemProgram, Transaction, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import {
  COMMITMENT_LEVEL,
  DEFAULT_COMPUTE_UNITS,
  CONFIRMATION_POLL_INTERVAL_MS,
  LAMPORTS_PER_SOL,
  MICROLAMPORTS_PER_LAMPORT,
  RETRY_DELAY_BASE_MS,
  RETRY_DELAY_MAX_MS,
  SWQOS_CONFIG,
  MAX_PRIORITY_FEE_LAMPORTS
} from '../config/constants.js';
import { estimatePriorityFee, fallbackPriorityForAttempt } from './priority-fee.util.js';
import { confirmTransaction } from './confirmation.util.js';

// Debug logging flag
const isDebug = process.env.LOG_LEVEL === 'debug';

/**
 * Add SWQOS tip to transaction
 * 
 * Adds a transfer instruction to send 5,000 lamports (0.000005 SOL) to a randomly
 * selected tip account. This tip routes the transaction through Helius's staked
 * validator network for improved reliability.
 * 
 * **Important:** This tip is separate from the priority fee. Both are required:
 * - Priority fee: Pays validators to process faster (~0.0003 SOL)
 * - SWQOS tip: Pays Helius routing service (~0.0005 SOL)
 * 
 * @param {Transaction} transaction - Transaction to add tip to
 * @param {PublicKey} fromPubkey - Wallet public key (payer)
 * @returns {Transaction} Transaction with tip added
 */
export function addSWQOSTip(transaction, fromPubkey) {
  // Randomly select tip account for load distribution
  const randomIndex = Math.floor(Math.random() * SWQOS_CONFIG.TIP_ACCOUNTS.length);
  const tipAccount = SWQOS_CONFIG.TIP_ACCOUNTS[randomIndex];

  // Add tip transfer as last instruction
  transaction.add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: new PublicKey(tipAccount),
      lamports: SWQOS_CONFIG.TIP_LAMPORTS
    })
  );

  return transaction;
}

/**
 * Send transaction via Helius SWQOS with retry logic
 * 
 * Sends transactions through Helius Sender API with stake-weighted routing for
 * improved reliability. Includes automatic retry with fresh blockhash on failure.
 * 
 * **Transaction Flow:**
 * 1. Build fresh transaction (removes old compute budget instructions)
 * 2. Add dynamic priority fee (from Helius API or fallback)
 * 3. Add SWQOS tip (5,000 lamports to random tip account)
 * 4. Get fresh blockhash
 * 5. Sign transaction
 * 6. Send via Helius Sender API (not standard RPC)
 * 7. Confirm transaction
 * 8. Retry on failure (up to maxRetries)
 * 
 * **Key Differences from Standard RPC:**
 * - Routes to sender.helius-rpc.com instead of standard RPC
 * - Requires skipPreflight: true
 * - Adds SWQOS tip instruction
 * - Uses fetch() instead of connection.sendRawTransaction()
 * 
 * @param {Connection} connection - Solana connection (used for queries/confirmation)
 * @param {Transaction} transaction - Transaction to send (UNSIGNED)
 * @param {Array<Signer>} signers - Transaction signers (wallet keypairs)
 * @param {Object} [options] - Send options
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @returns {Promise<Object>} Result: { success, signature, error }
 */
export async function sendTransactionSWQOS(connection, transaction, signers, options = {}) {
  const { maxRetries = 3 } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (isDebug) console.log(`🚚 Sending transaction via SWQOS (attempt ${attempt}/${maxRetries})...`);

      // Get fresh blockhash
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(COMMITMENT_LEVEL);

      // Build fresh working copy to avoid instruction accumulation
      const workingTx = new Transaction();

      // Remove old ComputeBudget instructions (from previous retries or external sources)
      const nonBudgetInstructions = transaction.instructions.filter(
        ix => ix.programId.toBase58() !== ComputeBudgetProgram.programId.toBase58()
      );

      // Add fresh compute budget instructions first
      workingTx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS })
      );

      // Get dynamic priority fee from Helius API
      const tempTx = new Transaction();
      nonBudgetInstructions.forEach(ix => tempTx.add(ix));
      tempTx.recentBlockhash = blockhash;
      tempTx.feePayer = signers[0].publicKey;
      const unsignedSerialized = tempTx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      }).toString('base64');

      const accountKeysHint = nonBudgetInstructions
        .map(ix => ix.programId.toBase58())
        .slice(0, 8);
      accountKeysHint.unshift(signers[0].publicKey.toBase58());

      // Get base priority fee from Helius or fallback
      let basePriority = await estimatePriorityFee({
        transactionBase64: unsignedSerialized,
        accountKeys: accountKeysHint,
        priorityLevel: 'VeryHigh'
      });

      const usedSource = basePriority !== null ? 'Helius' : 'fallback';
      if (basePriority === null) {
        basePriority = fallbackPriorityForAttempt(1); // Get base fallback for attempt 1
      }

      // Apply aggressive escalation multiplier on retries (2x, 3x, 4x, 5x)
      // This ensures transactions land during active market conditions
      const escalationMultiplier = attempt;
      let dynamicPriority = Math.floor(basePriority * escalationMultiplier);
      
      // Cap at maximum to prevent excessive fees
      dynamicPriority = Math.min(dynamicPriority, MAX_PRIORITY_FEE_LAMPORTS);

      const extraLamports = Math.floor((DEFAULT_COMPUTE_UNITS * dynamicPriority) / MICROLAMPORTS_PER_LAMPORT);
      const extraSol = extraLamports / LAMPORTS_PER_SOL;
      const escalationNote = attempt > 1 ? ` [${escalationMultiplier}x]` : '';
      // console.log(`💎 Priority fee (${usedSource}, attempt ${attempt}): ${dynamicPriority} µ-lamports/CU (~${extraSol.toFixed(6)} SOL at ${DEFAULT_COMPUTE_UNITS.toLocaleString()} CUs)${escalationNote}`);

      workingTx.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: dynamicPriority })
      );

      // Add the rest of the instructions
      nonBudgetInstructions.forEach(ix => workingTx.add(ix));

      // Add SWQOS tip (MUST be added BEFORE signing)
      addSWQOSTip(workingTx, signers[0].publicKey);
      if (isDebug) console.log(`🎯 SWQOS tip: ${SWQOS_CONFIG.TIP_LAMPORTS} lamports (~${(SWQOS_CONFIG.TIP_LAMPORTS / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);

      // Set transaction metadata
      workingTx.recentBlockhash = blockhash;
      workingTx.feePayer = signers[0].publicKey;

      // Sign transaction
      workingTx.sign(...signers);

      // Send via Helius Sender API (not standard RPC)
      const response = await fetch(SWQOS_CONFIG.SENDER_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now().toString(),
          method: 'sendTransaction',
          params: [
            Buffer.from(workingTx.serialize()).toString('base64'),
            {
              encoding: 'base64',
              skipPreflight: true, // REQUIRED for Sender API
              maxRetries: 0 // We handle retries externally
            }
          ]
        })
      });

      const result = await response.json();

      if (result.error) {
        throw new Error(`Helius Sender error: ${result.error.message}`);
      }

      const signature = result.result;
      // console.log(`📝 Transaction sent: ${signature}`);

      // Confirm transaction using standard confirmation utility
      const confirmResult = await confirmTransaction(connection, signature, {
        lastValidBlockHeight,
        commitment: COMMITMENT_LEVEL,
        pollInterval: CONFIRMATION_POLL_INTERVAL_MS,
        onProgress: (elapsed, currentHeight, targetHeight) => {
          // Log every 5 seconds
          if (elapsed > 0 && elapsed % 5000 < CONFIRMATION_POLL_INTERVAL_MS) {
            if (isDebug) console.log(`   ⏳ Confirming... ${(elapsed / 1000).toFixed(1)}s (block ${currentHeight}/${targetHeight})`);
          }
        }
      });

      if (!confirmResult.success) {
        throw new Error(confirmResult.error || 'Transaction confirmation failed');
      }

      // console.log(`✅ Transaction confirmed via SWQOS: ${signature}`);

      return {
        success: true,
        signature,
        blockhash,
        lastValidBlockHeight
      };

    } catch (error) {
      lastError = error;
      if (isDebug) console.warn(`⚠️  SWQOS attempt ${attempt}/${maxRetries} failed: ${error?.message || error}`);

      // Don't retry on certain errors
      if (
        error.message?.includes('insufficient funds') ||
        error.message?.includes('InvalidAccountData') ||
        error.message?.includes('AccountNotFound')
      ) {
        return {
          success: false,
          error: error.message,
          phase: 'send',
          fatal: true
        };
      }

      // Intelligent backoff: immediate retry on expiry, small delay otherwise
      if (attempt < maxRetries) {
        const isExpiry =
          error.message?.includes('block height exceeded') ||
          error.message?.includes('blockhash exceeded') ||
          error.message?.includes('expired');
        const delay = isExpiry ? 0 : Math.min(RETRY_DELAY_BASE_MS * attempt, RETRY_DELAY_MAX_MS);
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        if (isDebug) console.log(`↻ Retrying transaction (${attempt + 1}/${maxRetries})...`);
      }
    }
  }

  return {
    success: false,
    error: lastError?.message || 'Transaction failed after retries',
    phase: 'send',
    fatal: false
  };
}

/**
 * Send transaction with automatic SWQOS/Standard RPC selection
 * 
 * This is a convenience wrapper that automatically chooses between SWQOS and
 * standard RPC based on the USE_SWQOS environment flag.
 * 
 * **When SWQOS is enabled (USE_SWQOS=true):**
 * - Uses Helius Sender API with stake-weighted routing
 * - Adds SWQOS tip instruction
 * - 95-99% success rate, <1s confirmation
 * 
 * **When SWQOS is disabled (USE_SWQOS=false):**
 * - Falls back to standard RPC sending
 * - Uses connection.sendRawTransaction()
 * - Lower success rate but no additional tip cost
 * 
 * @param {Connection} connection - Solana connection
 * @param {Transaction} transaction - Transaction to send
 * @param {Array<Signer>} signers - Transaction signers
 * @param {Object} [options] - Send options
 * @returns {Promise<Object>} Result: { success, signature, error }
 */
export async function sendTransaction(connection, transaction, signers, options = {}) {
  const useSWQOS = process.env.USE_SWQOS !== 'false'; // Default: enabled

  if (useSWQOS) {
    if (isDebug) console.log('🚀 Using Helius SWQOS for transaction sending');
    return await sendTransactionSWQOS(connection, transaction, signers, options);
  } else {
    if (isDebug) console.log('📡 Using standard RPC for transaction sending');
    // Import standard transaction utility as fallback
    const { sendAndConfirmTransactionWithRetry } = await import('./transaction.util.js');
    return await sendAndConfirmTransactionWithRetry(connection, transaction, signers, options);
  }
}

export default {
  addSWQOSTip,
  sendTransactionSWQOS,
  sendTransaction
};

