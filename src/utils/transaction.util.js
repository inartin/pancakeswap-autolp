/**
 * Transaction Utility - Simulation, MEV Protection, and Execution
 * 
 * Industry-standard transaction handling with:
 * - Pre-flight simulation to catch errors before spending gas
 * - MEV protection via priority fees
 * - Retry logic for common failures
 * - Comprehensive error handling
 * 
 * @module transaction.util
 */

import {
    ComputeBudgetProgram,
    Transaction,
    VersionedTransaction,
    TransactionMessage
} from "@solana/web3.js";
import {
    DEFAULT_PRIORITY_FEE_LAMPORTS,
    MAX_PRIORITY_FEE_LAMPORTS,
    DEFAULT_COMPUTE_UNITS,
    COMMITMENT_LEVEL,
    PREFLIGHT_COMMITMENT,
    CONFIRMATION_TIMEOUT_MS,
    CONFIRMATION_ATTEMPT_TIMEOUT_MS,
    CONFIRMATION_POLL_INTERVAL_MS,
    LAMPORTS_PER_SOL,
    MICROLAMPORTS_PER_LAMPORT,
    RETRY_DELAY_BASE_MS,
    RETRY_DELAY_MAX_MS
} from "../config/constants.js";
import { estimatePriorityFee, fallbackPriorityForAttempt } from './priority-fee.util.js';
import { confirmTransaction } from './confirmation.util.js';

// Debug logging flag
const isDebug = process.env.LOG_LEVEL === 'debug';

/**
 * Add compute budget instructions to transaction for MEV protection
 * 
 * Priority fees help:
 * - Get transactions processed faster
 * - Reduce risk of sandwich attacks
 * - Ensure execution during congestion
 * 
 * @param {Transaction} transaction - Transaction to modify
 * @param {number} [priorityFeeLamports] - Priority fee in microlamports (default from config)
 * @param {number} [computeUnits] - Compute unit limit (default from config)
 * @returns {Transaction} Modified transaction
 */
export function addComputeBudget(
    transaction,
    priorityFeeLamports = DEFAULT_PRIORITY_FEE_LAMPORTS,
    computeUnits = DEFAULT_COMPUTE_UNITS
) {
    // Cap priority fee to prevent accidental drainage
    const cappedFee = Math.min(priorityFeeLamports, MAX_PRIORITY_FEE_LAMPORTS);

    // Add compute unit limit (estimated based on operation complexity)
    transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({
            units: computeUnits
        })
    );

    // Add priority fee (microlamports per compute unit)
    transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: cappedFee
        })
    );

    return transaction;
}

/**
 * @deprecated - Use RPC's built-in preflight simulation instead
 * Kept as stub for compatibility
 * 
 * @param {Connection} connection - Solana connection
 * @param {Transaction} transaction - Transaction to simulate
 * @param {Array<Signer>} signers - Transaction signers
 * @returns {Promise<Object>} Simulation result: { success, error, logs }
 */
export async function simulateTransaction(connection, transaction, signers) {
    return { success: true, logs: [] };
}

/**
 * Send and confirm transaction with retry logic
 *
 * Handles common failures:
 * - Blockhash expiration
 * - Network congestion
 * - Temporary RPC errors
 *
 * @param {Connection} connection - Solana connection
 * @param {Transaction} transaction - Transaction to send
 * @param {Array<Signer>} signers - Transaction signers
 * @param {Object} [options] - Send options
 * @param {boolean} [options.skipPreflight=false] - Skip preflight checks (kept for compatibility, always false now)
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @param {boolean} [options.skipSimulation=true] - Skip pre-send simulation (kept for compatibility, deprecated)
 * @returns {Promise<Object>} Result: { success, signature, error }
 */
export async function sendAndConfirmTransactionWithRetry(
    connection,
    transaction,
    signers,
    options = {}
) {
    const {
        skipPreflight = false, // Keep param for compatibility
        maxRetries = 3,
        skipSimulation = true  // Keep param for compatibility
    } = options;

    let lastError = null;
    const previousSignatures = []; // Track all sent signatures

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Before retry, check if ANY previous signature succeeded (fast)
        if (previousSignatures.length > 0) {
            if (isDebug) console.log(`🔍 Checking ${previousSignatures.length} previous tx(s)...`);
            try {
                // Batch check all signatures at once (faster)
                const statuses = await connection.getSignatureStatuses(previousSignatures);
                for (let i = 0; i < previousSignatures.length; i++) {
                    const status = statuses.value[i];
                    const sig = previousSignatures[i];
                    if (status?.confirmationStatus && !status.err) {
                        if (isDebug) console.log(`   ✅ Previous tx succeeded! Using ${sig.slice(0, 8)}...`);
                        return {
                            success: true,
                            signature: sig,
                            blockhash: null,
                            lastValidBlockHeight: null
                        };
                    }
                }
            } catch (e) {
                // Ignore batch check error, proceed with retry
            }
        }
        try {
            if (isDebug) console.log(`🚚 Sending transaction (attempt ${attempt}/${maxRetries})...`);
            
            // Get fresh blockhash
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(COMMITMENT_LEVEL);
            
            // Build fresh transaction
            const workingTx = new Transaction();
            const nonBudgetInstructions = transaction.instructions.filter(
                ix => ix.programId.toBase58() !== ComputeBudgetProgram.programId.toBase58()
            );

            // Add compute budget with dynamic priority
            workingTx.add(
                ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS })
            );
            
            // Get priority fee (already cached in priority-fee.util.js)
            let basePriority = await estimatePriorityFee({ priorityLevel: 'VeryHigh' });
            
            const usedSource = (basePriority !== null) ? 'Helius' : 'fallback';
            if (basePriority === null) {
                basePriority = fallbackPriorityForAttempt(1);
            }
            
            const escalationMultiplier = attempt;
            let dynamicPriority = Math.floor(basePriority * escalationMultiplier);
            dynamicPriority = Math.min(dynamicPriority, MAX_PRIORITY_FEE_LAMPORTS);
            
            const extraLamports = Math.floor((DEFAULT_COMPUTE_UNITS * dynamicPriority) / MICROLAMPORTS_PER_LAMPORT);
            const extraSol = extraLamports / LAMPORTS_PER_SOL;
            const escalationNote = attempt > 1 ? ` [${escalationMultiplier}x]` : '';
            // console.log(`💎 Priority fee: ${dynamicPriority} µ-lamports/CU (~${extraSol.toFixed(6)} SOL)${escalationNote}`);
            
            workingTx.add(
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: dynamicPriority })
            );

            nonBudgetInstructions.forEach(ix => workingTx.add(ix));
            workingTx.recentBlockhash = blockhash;
            workingTx.feePayer = signers[0].publicKey;

            // Sign and send
            workingTx.sign(...signers);

            // RPC simulates automatically with skipPreflight: false
            let signature;
            try {
                signature = await connection.sendRawTransaction(
                    workingTx.serialize(),
                    {
                        skipPreflight: false, // RPC handles simulation
                        preflightCommitment: 'processed',
                        maxRetries: 0
                    }
                );
                if (isDebug) console.log(`📤 Transaction sent: ${signature}`);
            } catch (sendError) {
                // Preflight failure - catch it immediately
                console.error(`❌ Preflight failed: ${sendError.message}`);
                throw sendError;
            }
            previousSignatures.push(signature); // Track this signature

            // Polling-based confirmation (compatible with all RPC providers)
            const startTime = Date.now();
            
            const confirmationPromise = new Promise((resolve, reject) => {
                let timeoutId = null;
                let pollIntervalId = null;
                let resolved = false;
                
                const cleanup = () => {
                    if (timeoutId) clearTimeout(timeoutId);
                    if (pollIntervalId) clearInterval(pollIntervalId);
                };
                
                const finish = (success, error = null) => {
                    if (resolved) return;
                    resolved = true;
                    cleanup();
                    
                    if (success) {
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                        if (isDebug) console.log(`✅ Confirmed in ${elapsed}s: ${signature}`);
                        resolve();
                    } else {
                        reject(error);
                    }
                };
                
                // Poll for transaction confirmation
                let pollCount = 0;
                pollIntervalId = setInterval(async () => {
                    try {
                        pollCount++;
                        const status = await connection.getSignatureStatus(signature);
                        if (status?.value?.confirmationStatus) {
                            if (isDebug) console.log(`   📊 Confirmed via polling (poll #${pollCount}): ${status.value.confirmationStatus}`);
                            if (status.value.err) {
                                finish(false, new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`));
                            } else {
                                finish(true);
                            }
                        }
                    } catch (e) {
                        // Ignore polling errors
                    }
                }, CONFIRMATION_POLL_INTERVAL_MS);
                
                // Aggressive timeout for fast retries with higher priority
                timeoutId = setTimeout(async () => {
                    // Before timing out, check if tx exists on-chain
                    try {
                        const tx = await connection.getTransaction(signature, {
                            maxSupportedTransactionVersion: 0,
                            commitment: 'confirmed'
                        });
                        if (tx) {
                            if (isDebug) console.log(`✅ Found on-chain despite timeout: ${signature}`);
                            finish(true);
                            return;
                        }
                    } catch (e) {}
                    
                    if (isDebug) console.log(`   ⏱️  Timeout after ${CONFIRMATION_ATTEMPT_TIMEOUT_MS / 1000}s - will retry with higher priority`);
                    finish(false, new Error('Confirmation timeout'));
                }, CONFIRMATION_ATTEMPT_TIMEOUT_MS);
            });
            
            await confirmationPromise;

            return {
                success: true,
                signature,
                blockhash,
                lastValidBlockHeight
            };

        } catch (error) {
            lastError = error;
            if (isDebug) console.warn(`⚠️ Attempt ${attempt}/${maxRetries} failed: ${error?.message || error}`);
            
            // Don't retry on fatal errors or slippage errors (outer loop handles price refresh)
            if (
                error.message?.includes('insufficient funds') ||
                error.message?.includes('InvalidAccountData') ||
                error.message?.includes('AccountNotFound') ||
                error.message?.includes('0x1785') || // Price slippage check (6021)
                error.message?.includes('PriceSlippageCheck') ||
                error.message?.includes('custom program error: 6021')
            ) {
                return {
                    success: false,
                    error: error.message,
                    phase: 'send',
                    fatal: error.message?.includes('0x1785') || 
                           error.message?.includes('PriceSlippageCheck') ? false : true
                };
            }

            // Retry with small delay (except blockhash expiry)
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
 * Build transaction with compute budget and proper setup
 * 
 * @param {Array<Instruction>} instructions - Instructions to include
 * @param {PublicKey} feePayer - Fee payer public key
 * @param {number} [priorityFeeLamports] - Priority fee
 * @param {number} [computeUnits] - Compute unit limit (default from config)
 * @returns {Transaction} Prepared transaction
 */
export function buildTransaction(
    instructions,
    feePayer,
    priorityFeeLamports = DEFAULT_PRIORITY_FEE_LAMPORTS,
    computeUnits = DEFAULT_COMPUTE_UNITS
) {
    const transaction = new Transaction();

    // Add compute budget first
    addComputeBudget(transaction, priorityFeeLamports, computeUnits);

    // Add actual instructions
    instructions.forEach(ix => transaction.add(ix));

    transaction.feePayer = feePayer;

    return transaction;
}

/**
 * Parse transaction error to get human-readable message
 * 
 * @param {Error|Object} error - Error from transaction
 * @returns {string} Human-readable error message
 */
export function parseTransactionError(error) {
    if (typeof error === 'string') {
        return error;
    }

    if (error?.message) {
        // Extract program error if present
        if (error.message.includes('custom program error:')) {
            const match = error.message.match(/custom program error: 0x([0-9a-f]+)/i);
            if (match) {
                const errorCode = parseInt(match[1], 16);
                return `Program error ${errorCode}: ${getProgramErrorName(errorCode)}`;
            }
        }

        return error.message;
    }

    if (error?.logs) {
        // Try to extract error from logs
        const errorLog = error.logs.find(log =>
            log.includes('Error') || log.includes('failed')
        );
        if (errorLog) {
            return errorLog;
        }
    }

    return 'Unknown transaction error';
}

/**
 * Get program error name from error code
 * Supports both low-level errors (0-99) and PancakeSwap-specific errors (6000+)
 * 
 * @param {number} errorCode - Error code from program
 * @returns {string} Error name or description
 */
function getProgramErrorName(errorCode) {
    // Low-level errors (Jupiter, SPL Token, Solana runtime)
    const lowLevelErrors = {
        0: 'Insufficient lamports',
        1: 'Insufficient funds',
        3: 'Invalid account data',
        4: 'Invalid instruction data',
        5: 'Invalid account owner',
        6: 'Account already initialized',
        7: 'Uninitialized account',
        8: 'Account does not match expected',
        16: 'Incorrect program id',
        17: 'Missing required signature',
        18: 'Account already in use',
        19: 'Invalid account state',
        20: 'Arithmetic overflow',
        21: 'Invalid seeds',
        22: 'Insufficient account space',
        34: 'Account data size changed',
        35: 'Account not rent exempt',
        52: 'Slippage tolerance exceeded or account validation failed'
    };

    // PancakeSwap-specific errors (6000+)
    const pancakeErrors = {
        6000: 'LOK',
        6001: 'Not approved',
        6002: 'Invalid update config flag',
        6003: 'Account lack',
        6004: 'Close position error',
        6005: 'Zero mint amount',
        6006: 'Invalid tick index',
        6007: 'Tick invalid order',
        6008: 'Tick lower overflow',
        6009: 'Tick upper overflow',
        6010: 'Tick and spacing not match',
        6011: 'Invalid tick array',
        6012: 'Invalid tick array boundary',
        6013: 'Sqrt price limit overflow',
        6014: 'Sqrt price X64 out of range',
        6015: 'Liquidity sub value error',
        6016: 'Liquidity add value error',
        6017: 'Invalid liquidity',
        6018: 'Forbid both zero for supply liquidity',
        6019: 'Liquidity insufficient',
        6020: 'Transaction too old',
        6021: 'Price slippage check failed',
        6022: 'Too little output received',
        6023: 'Too much input paid',
        6024: 'Zero amount specified',
        6025: 'Invalid input pool vault',
        6026: 'Too small input or output amount',
        6027: 'Not enough tick array account',
        6028: 'Invalid first tick array account',
        6029: 'Invalid reward index',
        6030: 'Full reward info',
        6031: 'Reward token already in use',
        6032: 'Except reward mint',
        6033: 'Invalid reward init param',
        6034: 'Invalid collect reward desired amount',
        6035: 'Invalid collect reward input account number',
        6036: 'Invalid reward period',
        6037: 'Not approve update reward emissiones',
        6038: 'Uninitialized reward info',
        6039: 'Not support mint',
        6040: 'Missing tick array bitmap extension account',
        6041: 'Insufficient liquidity for direction',
        6042: 'Max token overflow',
        6043: 'Calculate overflow',
        6044: 'Transfer fee calculate not match'
    };

    // Check low-level errors first (0-99 range)
    if (errorCode < 1000) {
        return lowLevelErrors[errorCode] || `Unknown low-level error (${errorCode})`;
    }

    // Check PancakeSwap errors (6000+ range)
    return pancakeErrors[errorCode] || `Unknown program error (${errorCode})`;
}

export default {
    addComputeBudget,
    simulateTransaction,
    sendAndConfirmTransactionWithRetry,
    buildTransaction,
    parseTransactionError,
    getProgramErrorName
};

