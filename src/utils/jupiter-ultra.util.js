import { Connection, VersionedTransaction } from '@solana/web3.js';
import {
  MAX_PRIORITY_FEE_LAMPORTS,
  FALLBACK_PRIORITY_FEE_LAMPORTS,
  CONFIRMATION_TIMEOUT_MS,
  CONFIRMATION_POLL_INTERVAL_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  COMMITMENT_LEVEL,
  PRICE_DRIFT_THRESHOLD_BPS,
  FRESH_QUOTE_MAX_RETRIES,
  FRESH_QUOTE_RETRY_DELAY_MS
} from '../config/constants.js';
import { estimatePriorityFee } from './priority-fee.util.js';
import { confirmTransaction } from './confirmation.util.js';

// Debug logging flag
const isDebug = process.env.LOG_LEVEL === 'debug';

/**
 * Jupiter Ultra Swap API Integration (EXACT 2-step flow)
 * 
 * Ultra endpoints (per official docs):
 * - Get Order:     GET  https://api.jup.ag/ultra/v1/order?inputMint=...&outputMint=...&amount=...&taker=...
 * - Execute Order: POST https://api.jup.ag/ultra/v1/execute
 * - Fees:          GET  https://api.jup.ag/ultra/v1/fees
 * 
 * Flow:
 * 1) Create order → returns { requestId, transaction }
 * 2) Sign transaction locally (base64)
 * 3) Execute order → send { requestId, signedTransaction }
 */
// Ultra API configuration
const JUP_API_KEY = process.env.JUP_API || null;
const ULTRA_BASE_URL = process.env.JUPITER_ULTRA_API_BASE_URL || 'https://api.jup.ag/ultra/v1';

// Helper to get fetch function (supports Node.js < 18)
async function getFetch() {
  if (globalThis.fetch) {
    return globalThis.fetch;
  }
  const nodeFetch = await import('node-fetch');
  return nodeFetch.default;
}

function getApiHeaders() {
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'autofarmer-pcs/1.0'
  };
  if (JUP_API_KEY) {
    headers['x-api-key'] = JUP_API_KEY;
  } else {
    if (isDebug) console.warn('[Jupiter Ultra] No API key found - using Pro endpoint without auth may fail. Set JUP_API env var.');
  }
  return headers;
}

// Helper: build Ultra GET order URL with query params
function buildUltraOrderUrl({ inputMint, outputMint, amount, taker, slippageBps }) {
  const params = new URLSearchParams();
  params.set('inputMint', inputMint);
  params.set('outputMint', outputMint);
  params.set('amount', String(amount));
  if (taker) params.set('taker', taker);
  if (Number.isFinite(slippageBps)) params.set('slippageBps', String(slippageBps));
  return `${ULTRA_BASE_URL}/order?${params.toString()}`;
}

async function sendSwapTransaction({ connection, wallet, swapTransactionBase64 }) {
  try {
    const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    const rawTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 0
    });
    return signature;
  } catch (error) {
    throw new Error(`Failed to send Ultra swap transaction: ${error.message}`);
  }
}

export async function swapTokensUltra({
  connection,
  wallet,
  inputMint,
  outputMint,
  amount,
  slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
  priorityFee = null,
  onlyDirectRoutes = false,
  wrapAndUnwrapSol = true,
  maxAccounts = null,
  waitForConfirmation = true,
  swapMode = 'ExactIn'
}) {
  

  try {
    if (!connection) throw new Error('Connection is required');
    if (!wallet) throw new Error('Wallet is required');
    if (!inputMint) throw new Error('Input mint is required');
    if (!outputMint) throw new Error('Output mint is required');
    if (!amount || amount <= 0) throw new Error('Amount must be greater than 0');

    const badMint = (m) => typeof m !== 'string' || m.includes('...') || /\s/.test(m) || m.length < 32;
    if (badMint(inputMint) || badMint(outputMint)) {
      throw new Error('Invalid mint address provided (looks truncated or malformed)');
    }

    // Step 1: Get Order (GET on lite-api)
    let order;
    try {
      const taker = wallet.publicKey.toString();
      const orderUrl = buildUltraOrderUrl({ inputMint, outputMint, amount, taker, slippageBps });
      const fetch = await getFetch();
      const res = await fetch(orderUrl, { method: 'GET', headers: getApiHeaders() });
      const text = await res.text();
      if (!res.ok) {
        console.error('[Jupiter Ultra] Order failed:', res.status, text);
        throw new Error(`${res.status} ${text || 'Unknown error'}`);
      }
      const json = JSON.parse(text);
      if (!json?.requestId || !json?.transaction) {
        throw new Error('Missing requestId/transaction in order response');
      }
      order = json;
    } catch (e) {
      throw new Error(`Ultra /order failed: ${e?.message || e}`);
    }
    

    // Step 2: Sign transaction locally
    let signedBase64;
    try {
    const unsignedBuf = Buffer.from(order.transaction, 'base64');
    const unsignedTx = VersionedTransaction.deserialize(unsignedBuf);
    unsignedTx.sign([wallet]);
      signedBase64 = Buffer.from(unsignedTx.serialize()).toString('base64');
    } catch (signError) {
      console.error('[Jupiter Ultra] Signing failed:', signError?.message);
      throw signError;
    }

    // Step 3: Execute Order (POST on lite-api)
    let signature;
    let confirmed = false;
    let lastValidBlockHeight;

    try {
      const fetch = await getFetch();
      const execRes = await fetch(`${ULTRA_BASE_URL}/execute`, {
        method: 'POST',
        headers: { ...getApiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: order.requestId, signedTransaction: signedBase64 })
      });
      const text = await execRes.text();
      if (!execRes.ok) {
        console.error('[Jupiter Ultra] Execute failed:', execRes.status, text);
        throw new Error(`${execRes.status} ${text || 'Unknown error'}`);
      }
      const json = JSON.parse(text);
      signature = json?.signature || json?.txid || null;
      if (!signature) {
        throw new Error(json?.error || 'Missing signature');
      }
      // console.log('[Jupiter Ultra] Signature:', signature);
    } catch (e) {
      throw new Error(`Ultra /execute failed: ${e?.message || e}`);
    }

    if (waitForConfirmation) {
      const latest = await connection.getLatestBlockhash(COMMITMENT_LEVEL);
      lastValidBlockHeight = latest.lastValidBlockHeight;
      const confirmResult = await confirmTransaction(connection, signature, {
        lastValidBlockHeight,
        commitment: COMMITMENT_LEVEL,
        pollInterval: CONFIRMATION_POLL_INTERVAL_MS
      });
      if (!confirmResult.success) {
        throw new Error(confirmResult.error || 'Confirmation failed');
      }
      confirmed = true;
      try {
        const txFeeDetails = await connection.getTransaction(signature, {
          commitment: COMMITMENT_LEVEL,
          maxSupportedTransactionVersion: 0
        });
        if (txFeeDetails?.meta?.fee) {
          const feeInLamports = txFeeDetails.meta.fee;
          const feeInSol = feeInLamports / 1_000_000_000;
          
          order.transactionFee = feeInSol;
          order.transactionFeeLamports = feeInLamports;
        }
      } catch (feeError) {}
    }

    return {
      success: true,
      signature,
      confirmed,
      transactionFee: order.transactionFee || 0,
      transactionFeeLamports: order.transactionFeeLamports || 0,
      quote: {
        inputAmount: amount?.toString?.() || String(amount),
        outputAmount: order?.outAmount || null,
        priceImpactPct: order?.priceImpactPct || null,
        routePlan: order?.routePlan || null,
        feeBps: order?.feeBps || null
      }
    };

  } catch (error) {
    console.error('[Jupiter Ultra] Swap failed:', error.message);
    return { success: false, error: error.message, signature: null };
  }
}

export async function checkUltraFees(inputMint, outputMint) {
  const fetch = await getFetch();
  const url = `${ULTRA_BASE_URL}/fees?inputMint=${inputMint}&outputMint=${outputMint}`;
  
  try {
    const response = await fetch(url, { headers: getApiHeaders() });
    if (!response.ok) {
      throw new Error(`Failed to check Ultra fees: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (isDebug) console.warn(`⚠️  Could not check Ultra fees: ${error.message}`);
    return null;
  }
}

/**
 * Get a fresh quote without executing (for price checking)
 * 
 * @param {Object} params - Quote parameters
 * @param {string} params.inputMint - Input token mint address
 * @param {string} params.outputMint - Output token mint address
 * @param {bigint|number|string} params.amount - Input amount in raw units
 * @param {string} params.taker - Wallet public key
 * @param {number} params.slippageBps - Slippage tolerance in basis points
 * @returns {Promise<Object>} Quote result with outputAmount
 */
export async function getQuoteOnly({ inputMint, outputMint, amount, taker, slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS }) {
  try {
    const orderUrl = buildUltraOrderUrl({ inputMint, outputMint, amount, taker, slippageBps });
    const fetch = await getFetch();
    const res = await fetch(orderUrl, { method: 'GET', headers: getApiHeaders() });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status} ${text || 'Unknown error'}`);
    }
    const json = JSON.parse(text);
    return {
      success: true,
      outputAmount: json?.outAmount || null,
      priceImpactPct: json?.priceImpactPct || null,
      routePlan: json?.routePlan || null
    };
  } catch (e) {
    return { success: false, error: e?.message || e };
  }
}

/**
 * Swap with fresh quote verification
 * 
 * Gets a quote, verifies it's within expected range based on provided price,
 * and only executes if the quote is fresh and acceptable.
 * 
 * @param {Object} params - Swap parameters (same as swapTokensUltra)
 * @param {number} params.expectedPrice - Expected price (outputToken/inputToken)
 * @param {number} params.inputDecimals - Input token decimals
 * @param {number} params.outputDecimals - Output token decimals
 * @returns {Promise<Object>} Swap result
 */
export async function swapWithFreshnessCheck({
  connection,
  wallet,
  inputMint,
  outputMint,
  amount,
  slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
  expectedPrice,
  inputDecimals,
  outputDecimals,
  waitForConfirmation = true
}) {
  const driftThreshold = PRICE_DRIFT_THRESHOLD_BPS / 10000; // Convert bps to decimal
  const maxRetries = FRESH_QUOTE_MAX_RETRIES;
  const retryDelay = FRESH_QUOTE_RETRY_DELAY_MS;
  
  // Calculate expected output based on provided price
  const inputAmountUi = Number(amount) / Math.pow(10, inputDecimals);
  const expectedOutputUi = inputAmountUi * expectedPrice;
  const expectedOutputRaw = expectedOutputUi * Math.pow(10, outputDecimals);
  
  let lastQuoteOutput = null;
  let lastDrift = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Get fresh quote
    const quote = await getQuoteOnly({
      inputMint,
      outputMint,
      amount,
      taker: wallet.publicKey.toString(),
      slippageBps
    });
    
    if (!quote.success) {
      if (isDebug) console.warn(`[Fresh Quote] Attempt ${attempt}/${maxRetries} - Quote failed: ${quote.error}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      // On last attempt, proceed with regular swap anyway
      if (isDebug) console.log(`[Fresh Quote] Max retries reached, proceeding with standard swap`);
      break;
    }
    
    lastQuoteOutput = Number(quote.outputAmount);
    
    // Calculate drift from expected
    const drift = Math.abs(lastQuoteOutput - expectedOutputRaw) / expectedOutputRaw;
    lastDrift = drift;
    
    if (drift <= driftThreshold) {
      if (isDebug) console.log(`[Fresh Quote] ✅ Quote acceptable (drift: ${(drift * 100).toFixed(3)}% <= ${(driftThreshold * 100).toFixed(1)}%)`);
      // Quote is fresh and acceptable, proceed with swap
      return await swapTokensUltra({
        connection,
        wallet,
        inputMint,
        outputMint,
        amount,
        slippageBps,
        waitForConfirmation
      });
    }
    
    if (isDebug) {
      console.log(`[Fresh Quote] ⚠️  Attempt ${attempt}/${maxRetries} - Drift too high: ${(drift * 100).toFixed(3)}% > ${(driftThreshold * 100).toFixed(1)}%`);
      console.log(`[Fresh Quote]    Expected: ${expectedOutputRaw.toFixed(0)}, Got: ${lastQuoteOutput.toFixed(0)}`);
    }
    
    if (attempt < maxRetries) {
      if (isDebug) console.log(`[Fresh Quote] Waiting ${retryDelay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  // All retries exhausted with high drift - proceed anyway but log warning
  if (isDebug) console.warn(`[Fresh Quote] ⚠️  Proceeding despite high drift (${(lastDrift * 100).toFixed(3)}%) - market may be volatile`);
  return await swapTokensUltra({
    connection,
    wallet,
    inputMint,
    outputMint,
    amount,
    slippageBps,
    waitForConfirmation
  });
}

export default { swapTokensUltra, swapWithFreshnessCheck, getQuoteOnly, checkUltraFees };

