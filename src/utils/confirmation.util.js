/**
 * Robust Transaction Confirmation Utility
 * 
 * Polls transaction status until we get a DEFINITIVE answer:
 * - Success (confirmed/finalized)
 * - Error (transaction failed)
 * - Expired (blockhash expired, transaction will never execute)
 * 
 * NO ARBITRARY TIMEOUTS - we use Solana's built-in expiry mechanism.
 * 
 * @module confirmation.util
 */

import { CONFIRMATION_POLL_INTERVAL_MS, COMMITMENT_LEVEL } from '../config/constants.js';

// Debug logging flag
const isDebug = process.env.LOG_LEVEL === 'debug';

/**
 * Wait for transaction confirmation with robust error handling
 * 
 * This function polls until we get a definitive answer. It uses Solana's
 * blockhash expiry as the natural timeout - if the transaction hasn't been
 * included in a block by lastValidBlockHeight, it will NEVER execute.
 * 
 * @param {Connection} connection - Solana RPC connection
 * @param {string} signature - Transaction signature to track
 * @param {Object} options - Confirmation options
 * @param {number} options.lastValidBlockHeight - Block height at which transaction expires
 * @param {string} [options.commitment='confirmed'] - Commitment level to wait for
 * @param {number} [options.pollInterval=300] - Milliseconds between status checks
 * @param {number} [options.maxPolls=null] - Maximum number of polls (null = unlimited)
 * @param {Function} [options.onProgress] - Callback for progress updates
 * 
 * @returns {Promise<Object>} Confirmation result
 * @returns {boolean} return.success - Whether transaction succeeded
 * @returns {string} [return.error] - Error message if failed
 * @returns {string} return.signature - Transaction signature
 * @returns {string} return.status - Final status: 'confirmed', 'finalized', 'failed', or 'expired'
 * @returns {Object} [return.statusDetails] - Raw status object from RPC
 * 
 * @example
 * const result = await confirmTransaction(connection, signature, {
 *   lastValidBlockHeight: 12345678,
 *   onProgress: (elapsed, currentHeight, targetHeight) => {
 *     console.log(`Waiting... ${elapsed}ms (block ${currentHeight}/${targetHeight})`);
 *   }
 * });
 * 
 * if (result.success) {
 *   console.log(`Transaction confirmed: ${result.signature}`);
 * } else {
 *   console.error(`Transaction failed: ${result.error}`);
 * }
 */
export async function confirmTransaction(connection, signature, options = {}) {
  const {
    lastValidBlockHeight,
    commitment = COMMITMENT_LEVEL,
    pollInterval = CONFIRMATION_POLL_INTERVAL_MS,
    maxPolls = null, // null = unlimited (poll until blockhash expires)
    onProgress = null
  } = options;

  if (!lastValidBlockHeight) {
    throw new Error('lastValidBlockHeight is required for robust confirmation');
  }

  const startTime = Date.now();
  let pollCount = 0;
  let lastStatus = null;

  if (isDebug) console.log(`⏳ Waiting for confirmation (will poll until block ${lastValidBlockHeight})...`);

  while (true) {
    pollCount++;
    const elapsed = Date.now() - startTime;

    try {
      // Check current block height to see if transaction expired
      const currentHeight = await connection.getBlockHeight(commitment);

      // Progress callback
      if (onProgress) {
        onProgress(elapsed, currentHeight, lastValidBlockHeight);
      }

      // Check if blockhash expired - transaction will NEVER execute now
      if (currentHeight > lastValidBlockHeight) {
        console.warn(`⏰ Blockhash expired at block ${currentHeight} (expired at ${lastValidBlockHeight})`);
        console.warn(`   Transaction was NOT included in any block - it failed.`);
        
        // Do one final deep search to be absolutely sure
        if (isDebug) console.log(`   🔍 Performing final deep search in transaction history...`);
        const finalCheck = await connection.getSignatureStatuses([signature], { 
          searchTransactionHistory: true 
        });
        const finalStatus = finalCheck?.value?.[0];
        
        if (finalStatus?.confirmationStatus === 'confirmed' || 
            finalStatus?.confirmationStatus === 'finalized') {
          // Transaction actually succeeded despite appearing expired!
          if (isDebug) console.log(`   ✅ Found confirmed transaction in history!`);
          return {
            success: true,
            signature,
            status: finalStatus.confirmationStatus,
            statusDetails: finalStatus
          };
        }

        // Definitely expired
        return {
          success: false,
          signature,
          status: 'expired',
          error: `Transaction expired: blockhash exceeded at block ${currentHeight} (valid until ${lastValidBlockHeight})`,
          statusDetails: finalStatus
        };
      }

      // Check transaction status (fast check, no history search)
      const statusResp = await connection.getSignatureStatuses([signature], { 
        searchTransactionHistory: false 
      });
      const status = statusResp?.value?.[0];
      lastStatus = status;

      // Transaction failed with error
      if (status?.err) {
        console.error(`❌ Transaction failed with error: ${JSON.stringify(status.err)}`);
        return {
          success: false,
          signature,
          status: 'failed',
          error: `Transaction failed: ${JSON.stringify(status.err)}`,
          statusDetails: status
        };
      }

      // Transaction confirmed!
      const confirmationStatus = status?.confirmationStatus;
      if (confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
        const elapsedSec = (elapsed / 1000).toFixed(1);
        if (isDebug) console.log(`✅ Transaction ${confirmationStatus} after ${elapsedSec}s (${pollCount} polls)`);
        return {
          success: true,
          signature,
          status: confirmationStatus,
          statusDetails: status
        };
      }

      // Not confirmed yet - check if we should continue polling
      if (maxPolls !== null && pollCount >= maxPolls) {
        console.warn(`⚠️ Reached maximum polls (${maxPolls})`);
        
        // Do final check with history search before giving up
        if (isDebug) console.log(`   🔍 Final check in transaction history...`);
        const finalCheck = await connection.getSignatureStatuses([signature], { 
          searchTransactionHistory: true 
        });
        const finalStatus = finalCheck?.value?.[0];
        
        if (finalStatus?.confirmationStatus === 'confirmed' || 
            finalStatus?.confirmationStatus === 'finalized') {
          if (isDebug) console.log(`   ✅ Found in history!`);
          return {
            success: true,
            signature,
            status: finalStatus.confirmationStatus,
            statusDetails: finalStatus
          };
        }

        return {
          success: false,
          signature,
          status: 'unknown',
          error: `Reached maximum poll limit (${maxPolls}) without confirmation. Check transaction manually.`,
          statusDetails: finalStatus
        };
      }

      // Continue polling
      const blockProgress = `${currentHeight}/${lastValidBlockHeight}`;
      const timeProgress = `${(elapsed / 1000).toFixed(1)}s`;
      if (pollCount % 10 === 0 && isDebug) {
        // Log progress every 10 polls (~3 seconds) to avoid spam
        console.log(`   ⏳ Still waiting... (${timeProgress}, block ${blockProgress}, poll #${pollCount})`);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));

    } catch (error) {
      // RPC error - don't fail, just log and retry
      console.warn(`   ⚠️ RPC error during confirmation check (poll #${pollCount}): ${error.message}`);
      console.warn(`   Will retry after ${pollInterval}ms...`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }
}

/**
 * Confirm multiple transactions in parallel
 * 
 * @param {Connection} connection - Solana RPC connection
 * @param {Array<Object>} transactions - Array of { signature, lastValidBlockHeight }
 * @param {Object} options - Confirmation options (same as confirmTransaction)
 * 
 * @returns {Promise<Array<Object>>} Array of confirmation results
 */
export async function confirmTransactions(connection, transactions, options = {}) {
  const promises = transactions.map(tx => 
    confirmTransaction(connection, tx.signature, {
      ...options,
      lastValidBlockHeight: tx.lastValidBlockHeight
    })
  );
  
  return Promise.all(promises);
}

export default {
  confirmTransaction,
  confirmTransactions
};

