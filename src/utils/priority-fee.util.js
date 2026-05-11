import { env } from '../config/env.js';
import {
    HTTP_REQUEST_TIMEOUT_MS,
    MAX_PRIORITY_FEE_LAMPORTS,
    DEFAULT_PRIORITY_FEE_LAMPORTS,
    PRIORITY_FEE_CACHE_TTL_MS
} from '../config/constants.js';

async function getFetch() {
    if (globalThis.fetch) return globalThis.fetch;
    const nodeFetch = await import('node-fetch');
    return nodeFetch.default;
}

// Priority fee cache to prevent rate limit hits
const priorityFeeCache = {
    value: null,
    timestamp: 0,
    ttl: PRIORITY_FEE_CACHE_TTL_MS
};

/**
 * Get cached priority fee if still valid
 * @returns {number|null}
 */
function getCachedPriorityFee() {
    const now = Date.now();
    if (priorityFeeCache.value !== null && (now - priorityFeeCache.timestamp) < priorityFeeCache.ttl) {
        return priorityFeeCache.value;
    }
    return null;
}

/**
 * Cache priority fee estimate
 * @param {number} value
 */
function cachePriorityFee(value) {
    priorityFeeCache.value = value;
    priorityFeeCache.timestamp = Date.now();
}

/**
 * Estimate Solana priority fee (microlamports per compute unit) using Helius getPriorityFeeEstimate.
 *
 * Prefer passing a base64-serialized unsigned transaction for best accuracy.
 * As a fallback, you may pass accountKeys (array of base58 strings).
 *
 * @param {Object} params
 * @param {string|null} params.transactionBase64 - Unsigned transaction in base64
 * @param {Array<string>|null} params.accountKeys - Account keys when tx is not available
 * @param {('Min'|'Low'|'Medium'|'High'|'VeryHigh'|'UnsafeMax')} params.priorityLevel - Desired priority level
 * @param {number} [params.timeoutMs]
 * @returns {Promise<number|null>} microlamports per compute unit or null on failure
 */
export async function estimatePriorityFee({
    transactionBase64 = null,
    accountKeys = null,
    priorityLevel = 'VeryHigh',
    timeoutMs = HTTP_REQUEST_TIMEOUT_MS
}) {
    try {
        // Check cache first to prevent rate limit hits
        const cached = getCachedPriorityFee();
        if (cached !== null) {
            return cached;
        }

        const rpcUrl = env.SOLANA_RPC_URL;
        if (!rpcUrl) return null;

        async function postPayload(payload) {
            const fetch = await getFetch();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                const text = await res.text();
                if (!res.ok) {
                    console.warn(`[priority-fee] Non-OK HTTP ${res.status}: ${text?.slice(0, 256)}`);
                    return null;
                }
                let json;
                try { json = JSON.parse(text); } catch {
                    console.warn('[priority-fee] Failed to parse JSON body');
                    return null;
                }
                if (json?.error) {
                    console.warn(`[priority-fee] JSON-RPC error: ${JSON.stringify(json.error).slice(0,256)}`);
                    return null;
                }
                // Support both response formats: priorityFeeEstimate (standard) and priorityFee (Helius)
                const value = json?.result?.priorityFeeEstimate ?? json?.result?.priorityFee;
                if (typeof value !== 'number' || !Number.isFinite(value)) {
                    console.warn(`[priority-fee] Missing/invalid priority fee in result: ${JSON.stringify(json?.result)?.slice(0,256)}`);
                    return null;
                }
                const capped = Math.min(Math.max(0, Math.floor(value)), MAX_PRIORITY_FEE_LAMPORTS);
                return capped;
            } catch (e) {
                console.warn(`[priority-fee] Request failed: ${e?.message || e}`);
                return null;
            } finally {
                clearTimeout(timeoutId);
            }
        }

        const baseOptions = { priorityLevel };

        // Try with base64 transaction first
        if (transactionBase64) {
            const payload = {
                jsonrpc: '2.0',
                id: '1',
                method: 'getPriorityFeeEstimate',
                params: [{ transaction: transactionBase64, options: { ...baseOptions, transactionEncoding: 'base64' } }]
            };
            const byBase64 = await postPayload(payload);
            if (byBase64 !== null) {
                cachePriorityFee(byBase64);
                return byBase64;
            }
        }

        // Try with bs58-encoded transaction (some providers may accept it)
        if (transactionBase64) {
            try {
                const { default: bs58 } = await import('bs58');
                const bytes = Buffer.from(transactionBase64, 'base64');
                const txBs58 = bs58.encode(bytes);
                const payload = {
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'getPriorityFeeEstimate',
                    params: [{ transaction: txBs58, options: { ...baseOptions, transactionEncoding: 'base58' } }]
                };
                const byBs58 = await postPayload(payload);
                if (byBs58 !== null) {
                    cachePriorityFee(byBs58);
                    return byBs58;
                }
            } catch (e) {
                console.warn(`[priority-fee] bs58 fallback failed: ${e?.message || e}`);
            }
        }

        // Try with accountKeys hint if available
        if (Array.isArray(accountKeys) && accountKeys.length > 0) {
            const payload = {
                jsonrpc: '2.0',
                id: '1',
                method: 'getPriorityFeeEstimate',
                params: [{ accountKeys, options: baseOptions }]
            };
            const byAccounts = await postPayload(payload);
            if (byAccounts !== null) {
                cachePriorityFee(byAccounts);
                return byAccounts;
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Choose a safe fallback when estimation fails.
 * @param {number} attempt - Retry attempt (1-based)
 * @returns {number}
 */
export function fallbackPriorityForAttempt(attempt) {
    const bumped = DEFAULT_PRIORITY_FEE_LAMPORTS * (attempt + 1);
    return Math.min(bumped, MAX_PRIORITY_FEE_LAMPORTS);
}

export default {
    estimatePriorityFee,
    fallbackPriorityForAttempt
};


