/**
 * Jupiter Lite API Utility
 *
 * This utility provides token information from Jupiter's Lite API for Solana tokens.
 * Jupiter offers comprehensive token data including USD price, decimals, and metadata.
 *
 * Features:
 * - Batch fetch multiple tokens in a single API call (up to 100 mint addresses)
 * - Automatic mint address validation using @solana/web3.js PublicKey
 * - Standardized response format for consistency
 * - Comprehensive error handling
 * - Logo URLs and social links for tokens
 *
 * API Endpoint: https://api.jup.ag/tokens/v2/search
 * Documentation: https://dev.jup.ag
 *
 * @module jupiter-api.util
 */

import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import {
  HTTP_REQUEST_TIMEOUT_MS,
  JUPITER_MAX_RETRIES,
  JUPITER_RETRY_DELAY_MS
} from '../config/constants.js';

// Debug logging flag
const isDebug = process.env.LOG_LEVEL === 'debug';

// Jupiter API configuration
const JUPITER_API_BASE = 'https://api.jup.ag/tokens/v2';
const JUP_API_KEY = process.env.JUP_API || null;
const JUP_PLAN = process.env.JUP_PLAN || 'paid';
const MAX_MINT_ADDRESSES = 100; // API limit for batch queries

// Rate limiting: Track last API call to prevent bans
// NOTE: This is SEPARATE from the Jupiter Price API rate limiter in market-data.service.js
// Different endpoints have independent rate limits
let lastTokenApiFetchTime = 0;
const MIN_TOKEN_API_FETCH_INTERVAL_MS = JUP_PLAN === 'free' ? 1100 : 110; // free = 1 req/sec, paid = 10 req/sec

// Debug: Track call origins
let callCounter = 0;

/**
 * Sleep helper for retry delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 * @private
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if enough time has passed since last Token API call (rate limiting)
 * 
 * @param {string} caller - Identifier for debugging who is calling
 * @returns {{canFetch: boolean, waitMs: number}} Object with fetch status and wait time
 * @private
 */
function canFetchTokenApiNow(caller = 'unknown') {
  const now = Date.now();
  const timeSinceLastFetch = now - lastTokenApiFetchTime;
  const callId = ++callCounter;

  if (timeSinceLastFetch < MIN_TOKEN_API_FETCH_INTERVAL_MS) {
    const waitMs = MIN_TOKEN_API_FETCH_INTERVAL_MS - timeSinceLastFetch;
    return { canFetch: false, waitMs };
  }

  return { canFetch: true, waitMs: 0 };
}

/**
 * Validate if a string is a valid Solana mint address
 *
 * @param {string} address - Address to validate
 * @returns {boolean} True if valid mint address
 * @private
 */
function isValidMintAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch token information from Jupiter API for multiple mint addresses
 *
 * This function retrieves comprehensive token data from Jupiter including:
 * - USD price
 * - Token symbol/ticker
 * - Token name
 * - Decimals
 * - Icon/logo URL
 * - Social links (Twitter, Telegram, Website)
 * - Supply information
 * - Verification status
 *
 * Supports batch queries of up to 100 mint addresses per request.
 * Invalid mint addresses are filtered out automatically.
 *
 * Includes automatic retry mechanism: 3 attempts with 500ms delay between retries.
 *
 * **Response Format:**
 * The function returns a standardized response object:
 * ```javascript
 * {
 *   success: boolean,
 *   data: [
 *     {
 *       mintAddress: string,
 *       ticker: string,
 *       usdPrice: number,
 *       decimals: number,
 *       name: string,
 *       icon: string,
 *       twitter: string,
 *       telegram: string,
 *       website: string,
 *       isVerified: boolean
 *     }
 *   ],
 *   error: {
 *     message: string,
 *     code: string,
 *     details: any
 *   },
 *   meta: {
 *     timestamp: string,
 *     source: string,
 *     requestedCount: number,
 *     validCount: number,
 *     invalidAddresses: string[],
 *     returnedCount: number
 *   }
 * }
 * ```
 *
 * @param {string[]} mintAddresses - Array of Solana token mint addresses (max 100)
 * @returns {Promise<Object>} Standardized response with token data
 *
 * @example
 * // Fetch multiple tokens
 * const result = await fetchTokensFromJupiter([
 *   "4qQeZ5LwSz6HuupUu8jCtgXyW1mYQcNbFAW1sWZp89HL", // CAKE
 *   "So11111111111111111111111111111111111111112"    // SOL
 * ]);
 * if (result.success) {
 *   result.data.forEach(token => {
 *     console.log(`${token.ticker}: $${token.usdPrice}`);
 *   });
 * }
 *
 * @example
 * // Handle errors
 * const result = await fetchTokensFromJupiter(["invalid_address"]);
 * if (!result.success) {
 *   console.error(`Error: ${result.error.message}`);
 * }
 */
export async function fetchTokensFromJupiter(mintAddresses, options = {}) {
  const timestamp = new Date().toISOString();
  
  // Extract caller from stack trace for debugging
  const caller = options.caller || (() => {
    try {
      const stack = new Error().stack;
      const lines = stack.split('\n');
      // Find the first line that's not from this file
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('jupiter-api.util.js')) {
          const match = line.match(/at\s+(?:async\s+)?(\S+)/);
          if (match) return match[1];
        }
      }
      return 'unknown';
    } catch { return 'unknown'; }
  })();

  try {
    // Validate input
    if (!Array.isArray(mintAddresses)) {
      return {
        success: false,
        data: [],
        error: {
          message: 'Invalid input: mintAddresses must be an array',
          code: 'INVALID_INPUT',
          details: 'Expected array of mint addresses'
        },
        meta: {
          timestamp,
          source: 'jupiter',
          requestedCount: 0,
          validCount: 0,
          invalidAddresses: [],
          returnedCount: 0
        }
      };
    }

    if (mintAddresses.length === 0) {
      return {
        success: false,
        data: [],
        error: {
          message: 'No mint addresses provided',
          code: 'EMPTY_INPUT',
          details: 'Provide at least one mint address'
        },
        meta: {
          timestamp,
          source: 'jupiter',
          requestedCount: 0,
          validCount: 0,
          invalidAddresses: [],
          returnedCount: 0
        }
      };
    }

    if (mintAddresses.length > MAX_MINT_ADDRESSES) {
      return {
        success: false,
        data: [],
        error: {
          message: `Too many mint addresses (max ${MAX_MINT_ADDRESSES})`,
          code: 'LIMIT_EXCEEDED',
          details: `Received ${mintAddresses.length} addresses, maximum is ${MAX_MINT_ADDRESSES}`
        },
        meta: {
          timestamp,
          source: 'jupiter',
          requestedCount: mintAddresses.length,
          validCount: 0,
          invalidAddresses: [],
          returnedCount: 0
        }
      };
    }

    // Filter and validate mint addresses
    const invalidAddresses = [];
    const validAddresses = mintAddresses.filter(address => {
      if (typeof address !== 'string' || !address.trim()) {
        invalidAddresses.push(address);
        return false;
      }
      if (!isValidMintAddress(address)) {
        invalidAddresses.push(address);
        return false;
      }
      return true;
    });

    if (validAddresses.length === 0) {
      return {
        success: false,
        data: [],
        error: {
          message: 'No valid mint addresses provided',
          code: 'NO_VALID_ADDRESSES',
          details: 'All provided addresses failed validation'
        },
        meta: {
          timestamp,
          source: 'jupiter',
          requestedCount: mintAddresses.length,
          validCount: 0,
          invalidAddresses,
          returnedCount: 0
        }
      };
    }

    // Build query string with comma-separated mint addresses
    const query = validAddresses.join(',');
    const url = `${JUPITER_API_BASE}/search`;

    // Rate limiting check - wait if needed instead of rejecting
    const rateCheck = canFetchTokenApiNow(caller);
    if (!rateCheck.canFetch) {
      if (isDebug) console.log(`[Jupiter API] Waiting ${rateCheck.waitMs}ms for rate limit (caller: ${caller})`);
      await sleep(rateCheck.waitMs);
    }

    // Retry loop
    if (!JUP_API_KEY) {
      if (isDebug) console.warn('[Jupiter API] No API key found - requests will fail. Set JUP_API env var.');
    }
    let lastError = null;
    for (let attempt = 1; attempt <= JUPITER_MAX_RETRIES; attempt++) {
      try {
        // Make API request
        const apiResponse = await axios.get(url, {
          params: { query },
          headers: {
            'Accept': 'application/json',
            ...(JUP_API_KEY && { 'x-api-key': JUP_API_KEY })
          },
          timeout: HTTP_REQUEST_TIMEOUT_MS
        });

        // Validate response status
        if (apiResponse.status !== 200) {
          throw new Error(`Jupiter API returned status ${apiResponse.status}: ${apiResponse.statusText}`);
        }

        // Extract data from response
        const apiData = apiResponse.data;

        // Validate response format
        if (!Array.isArray(apiData)) {
          throw new Error('Invalid response format from Jupiter API (expected array)');
        }

        // Parse and structure the data
        const tokens = apiData.map(token => ({
          mintAddress: token.id || '',
          ticker: token.symbol || '',
          usdPrice: parseFloat(token.usdPrice) || 0,
          decimals: token.decimals || 0,
          name: token.name || '',
          icon: token.icon || null,
          twitter: token.twitter || null,
          telegram: token.telegram || null,
          website: token.website || null,
          isVerified: token.isVerified || false
        }));

        // Update last fetch time on success
        lastTokenApiFetchTime = Date.now();

        // Build response object
        return {
          success: true,
          data: tokens,
          error: null,
          meta: {
            timestamp,
            source: 'jupiter',
            requestedCount: mintAddresses.length,
            validCount: validAddresses.length,
            invalidAddresses,
            returnedCount: tokens.length,
            retryCount: attempt,
            caller
          }
        };

      } catch (error) {
        lastError = error;

        // Don't retry on certain errors (bad request, validation errors)
        if (axios.isAxiosError(error) && error.response?.status === 400) {
          break; // Bad request, no point retrying
        }

        // If not the last attempt, wait and retry
        if (attempt < JUPITER_MAX_RETRIES) {
          await sleep(JUPITER_RETRY_DELAY_MS);
          continue;
        }
      }
    }

    // All retries failed, handle error
    let errorMessage = 'Failed to fetch token data from Jupiter after retries';
    let errorCode = 'UNKNOWN_ERROR';
    let errorDetails = null;

    if (axios.isAxiosError(lastError)) {
      if (lastError.response) {
        // Server responded with error status
        errorMessage = `Jupiter API error: ${lastError.response.status} ${lastError.response.statusText}`;
        errorCode = 'API_ERROR';
        errorDetails = lastError.response.data;
        console.error('[Jupiter API] Error:', errorMessage, errorDetails);
      } else if (lastError.request) {
        // Request was made but no response received
        errorMessage = 'No response from Jupiter API (network error)';
        errorCode = 'NETWORK_ERROR';
        errorDetails = 'Check your internet connection';
        console.error('[Jupiter API] Network error');
      } else {
        // Error in request configuration
        errorMessage = `Request error: ${lastError.message}`;
        errorCode = 'REQUEST_ERROR';
        errorDetails = lastError.message;
        console.error('[Jupiter API] Request error:', lastError.message);
      }
    } else {
      // Non-axios error
      errorMessage = lastError?.message || 'Unknown error occurred';
      errorCode = 'UNKNOWN_ERROR';
      errorDetails = lastError;
      console.error('[Jupiter API] Unknown error:', lastError?.message);
    }

    return {
      success: false,
      data: [],
      error: {
        message: errorMessage,
        code: errorCode,
        details: errorDetails
      },
      meta: {
        timestamp,
        source: 'jupiter',
        requestedCount: mintAddresses.length,
        validCount: validAddresses.length,
        invalidAddresses,
        returnedCount: 0,
        retryCount: JUPITER_MAX_RETRIES
      }
    };

  } catch (error) {
    // Unexpected error outside retry loop
    return {
      success: false,
      data: [],
      error: {
        message: error.message || 'Unexpected error',
        code: 'UNEXPECTED_ERROR',
        details: error
      },
      meta: {
        timestamp,
        source: 'jupiter',
        requestedCount: Array.isArray(mintAddresses) ? mintAddresses.length : 0,
        validCount: 0,
        invalidAddresses: [],
        returnedCount: 0,
        retryCount: 0
      }
    };
  }
}

/**
 * Fetch token information for a single mint address
 *
 * Convenience wrapper for fetching a single token.
 *
 * @param {string} mintAddress - Solana token mint address
 * @returns {Promise<Object>} Standardized response with single token data
 *
 * @example
 * const result = await fetchTokenFromJupiter("So11111111111111111111111111111111111111112");
 * if (result.success && result.data.length > 0) {
 *   const token = result.data[0];
 *   console.log(`${token.ticker}: $${token.usdPrice}`);
 * }
 */
export async function fetchTokenFromJupiter(mintAddress) {
  return fetchTokensFromJupiter([mintAddress]);
}
