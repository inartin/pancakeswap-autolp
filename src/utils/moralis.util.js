/**
 * Moralis Token Price Utility
 *
 * This utility provides token price and ticker data from the Moralis API for Solana tokens.
 * Moralis offers comprehensive token data including USD price, 24-hour price changes, and token symbols.
 * Cache and retry settings are centralized in constants.js for easy configuration.
 *
 * Features:
 * - Token price and ticker fetching in a single API call
 * - 24-hour price change tracking
 * - Standardized response format for consistency
 * - Comprehensive error handling with retry mechanism (see constants.js)
 * - Logo URLs for tokens
 *
 * API Endpoint: https://solana-gateway.moralis.io/token/{network}/{address}/price
 * Documentation: https://docs.moralis.io/web3-data-api/solana/reference/get-token-price
 *
 * @module moralis.util
 */

import axios from 'axios';
import 'dotenv/config';
import {
  MORALIS_MAX_RETRIES,
  MORALIS_RETRY_DELAY_MS,
  MORALIS_CACHE_DURATION_MS
} from '../config/constants.js';

// Moralis API configuration
const MORALIS_API_BASE = 'https://solana-gateway.moralis.io/token';
const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const MORALIS_NETWORK = 'mainnet'; // Solana mainnet

// Response cache structure: { tokenAddress: { data, timestamp } }
// Cache duration and retry settings imported from constants.js
const responseCache = new Map();

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
 * Fetch token price and ticker data from Moralis API with retry mechanism
 *
 * This function retrieves comprehensive token data from Moralis including:
 * - USD price (current and 24h ago)
 * - Token symbol/ticker
 * - Token name
 * - Price change percentage (24h)
 * - Exchange information
 * - Token logo URL
 *
 * Includes automatic retry mechanism: 3 attempts with 300ms delay between retries.
 * Includes 1-second response caching to reduce redundant API calls.
 *
 * **Response Format:**
 * The function returns a standardized response object:
 * ```javascript
 * {
 *   success: boolean,
 *   data: {
 *     usdPrice: number,
 *     ticker: string,
 *     name: string,
 *     usdPrice24h: number,
 *     usdPrice24hChange: number,
 *     usdPrice24hPercentChange: number,
 *     exchangeName: string,
 *     logo: string
 *   },
 *   error: {
 *     message: string,
 *     code: string,
 *     details: any
 *   },
 *   meta: {
 *     timestamp: string,
 *     source: string,
 *     tokenAddress: string,
 *     retryCount: number,
 *     cached: boolean
 *   }
 * }
 * ```
 *
 * @param {string} tokenAddress - Solana token mint address
 * @returns {Promise<Object>} Standardized response with token data
 *
 * @example
 * // Fetch TROLL token data
 * const result = await fetchTokenDataFromMoralis("5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2");
 * if (result.success) {
 *   console.log(`${result.data.ticker}: $${result.data.usdPrice}`);
 *   console.log(`24h change: ${result.data.usdPrice24hPercentChange}%`);
 * }
 *
 * @example
 * // Handle errors
 * const result = await fetchTokenDataFromMoralis("invalid_address");
 * if (!result.success) {
 *   console.error(`Error: ${result.error.message}`);
 * }
 */
export async function fetchTokenDataFromMoralis(tokenAddress) {
  const timestamp = new Date().toISOString();
  const now = Date.now();

  // Check cache first
  const cached = responseCache.get(tokenAddress);
  if (cached && (now - cached.timestamp) < MORALIS_CACHE_DURATION_MS) {
    // Return cached response with updated metadata
    return {
      ...cached.data,
      meta: {
        ...cached.data.meta,
        timestamp,
        cached: true
      }
    };
  }

  try {
    // Validate input
    if (!tokenAddress || typeof tokenAddress !== 'string') {
      return {
        success: false,
        data: null,
        error: {
          message: 'Invalid token address provided',
          code: 'INVALID_INPUT',
          details: 'Token address must be a non-empty string'
        },
        meta: {
          timestamp,
          source: 'moralis',
          tokenAddress: tokenAddress || null,
          retryCount: 0
        }
      };
    }

    // Check if API key is configured
    if (!MORALIS_API_KEY) {
      return {
        success: false,
        data: null,
        error: {
          message: 'Moralis API key not configured',
          code: 'MISSING_API_KEY',
          details: 'MORALIS_API_KEY environment variable is not set'
        },
        meta: {
          timestamp,
          source: 'moralis',
          tokenAddress,
          retryCount: 0
        }
      };
    }

    // Build API URL
    const url = `${MORALIS_API_BASE}/${MORALIS_NETWORK}/${tokenAddress}/price`;

    // Retry loop
    let lastError = null;
    for (let attempt = 1; attempt <= MORALIS_MAX_RETRIES; attempt++) {
      try {
        // Make API request
        const apiResponse = await axios.get(url, {
          headers: {
            'Accept': 'application/json',
            'X-API-Key': MORALIS_API_KEY
          },
          timeout: 10000 // 10 second timeout
        });

        // Validate response status
        if (apiResponse.status !== 200) {
          throw new Error(`Moralis API returned status ${apiResponse.status}: ${apiResponse.statusText}`);
        }

        // Extract data from response
        const apiData = apiResponse.data;

        // Validate required fields
        if (!apiData || typeof apiData.usdPrice === 'undefined') {
          throw new Error('Token price data not available from Moralis API');
        }

        // Parse and structure the data
        const tokenData = {
          usdPrice: parseFloat(apiData.usdPrice) || 0,
          ticker: apiData.symbol || apiData.tokenSymbol || 'UNKNOWN',
          name: apiData.name || apiData.tokenName || 'Unknown Token',
          usdPrice24h: parseFloat(apiData.usdPrice24h) || null,
          usdPrice24hChange: parseFloat(apiData.usdPrice24hrUsdChange) || null,
          usdPrice24hPercentChange: parseFloat(apiData.usdPrice24hrPercentChange) || null,
          exchangeName: apiData.exchangeName || null,
          pairAddress: apiData.pairAddress || null,
          logo: apiData.logo || null,
          isVerifiedContract: apiData.isVerifiedContract || false
        };

        // Build response object
        const response = {
          success: true,
          data: tokenData,
          error: null,
          meta: {
            timestamp,
            source: 'moralis',
            tokenAddress,
            exchangeName: tokenData.exchangeName,
            pairAddress: tokenData.pairAddress,
            retryCount: attempt,
            cached: false
          }
        };

        // Cache the response
        responseCache.set(tokenAddress, {
          data: response,
          timestamp: now
        });

        // Success! Return immediately
        return response;

      } catch (error) {
        lastError = error;

        // Don't retry on certain errors (invalid input, missing API key, etc)
        if (axios.isAxiosError(error) && error.response?.status === 400) {
          break; // Bad request, no point retrying
        }

        // If not the last attempt, wait and retry
        if (attempt < MORALIS_MAX_RETRIES) {
          await sleep(MORALIS_RETRY_DELAY_MS);
          continue;
        }
      }
    }

    // All retries failed, return error

    let errorMessage = 'Failed to fetch token data from Moralis after retries';
    let errorCode = 'UNKNOWN_ERROR';
    let errorDetails = null;

    if (axios.isAxiosError(lastError)) {
      if (lastError.response) {
        // Server responded with error status
        errorMessage = `Moralis API error: ${lastError.response.status} ${lastError.response.statusText}`;
        errorCode = 'API_ERROR';
        errorDetails = lastError.response.data;
      } else if (lastError.request) {
        // Request was made but no response received
        errorMessage = 'No response from Moralis API (network error)';
        errorCode = 'NETWORK_ERROR';
        errorDetails = 'Check your internet connection';
      } else {
        // Error in request configuration
        errorMessage = `Request error: ${lastError.message}`;
        errorCode = 'REQUEST_ERROR';
        errorDetails = lastError.message;
      }
    } else {
      // Non-axios error
      errorMessage = lastError?.message || 'Unknown error occurred';
      errorCode = 'UNKNOWN_ERROR';
      errorDetails = lastError;
    }

    return {
      success: false,
      data: null,
      error: {
        message: errorMessage,
        code: errorCode,
        details: errorDetails
      },
      meta: {
        timestamp,
        source: 'moralis',
        tokenAddress,
        retryCount: MORALIS_MAX_RETRIES
      }
    };

  } catch (error) {
    // Unexpected error outside retry loop
    return {
      success: false,
      data: null,
      error: {
        message: error.message || 'Unexpected error',
        code: 'UNEXPECTED_ERROR',
        details: error
      },
      meta: {
        timestamp,
        source: 'moralis',
        tokenAddress,
        retryCount: 0
      }
    };
  }
}

/**
 * Fetch only the USD price for a token
 *
 * Convenience wrapper that extracts just the USD price from Moralis data.
 *
 * @param {string} tokenAddress - Solana token mint address
 * @returns {Promise<number|null>} USD price or null if unavailable
 *
 * @example
 * const price = await getTokenPrice(tokenAddress);
 * if (price) {
 *   console.log(`Price: $${price}`);
 * }
 */
export async function getTokenPrice(tokenAddress) {
  const result = await fetchTokenDataFromMoralis(tokenAddress);
  return result.success ? result.data.usdPrice : null;
}

/**
 * Fetch only the ticker/symbol for a token
 *
 * Convenience wrapper that extracts just the ticker from Moralis data.
 *
 * @param {string} tokenAddress - Solana token mint address
 * @returns {Promise<string|null>} Token ticker or null if unavailable
 *
 * @example
 * const ticker = await getTokenTicker(tokenAddress);
 * console.log(`Ticker: ${ticker}`);
 */
export async function getTokenTicker(tokenAddress) {
  const result = await fetchTokenDataFromMoralis(tokenAddress);
  return result.success ? result.data.ticker : null;
}
