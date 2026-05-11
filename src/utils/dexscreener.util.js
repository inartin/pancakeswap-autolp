/**
 * Token Price Utility using DexScreener API
 * 
 * DexScreener provides free API access (300 requests/min) without requiring an API key.
 * This utility fetches token prices from Solana DEXes and returns the most reliable price
 * based on the pair with the highest liquidity.
 * 
 * @module dexscreener.util
 */

import { KNOWN_TOKENS } from '../config/constants.js';

const DEXSCREENER_API_BASE = 'https://api.dexscreener.com/latest/dex';

/**
 * Check if a token is a known stablecoin and return hardcoded price
 * 
 * @param {string} mintAddress - The token mint address
 * @returns {Object|null} Token info with hardcoded price or null if not a known stablecoin
 */
function getKnownTokenPrice(mintAddress) {
    // Check all known tokens with fixed prices
    for (const [key, tokenInfo] of Object.entries(KNOWN_TOKENS)) {
        if (tokenInfo.mint === mintAddress && tokenInfo.price) {
            return {
                mintAddress: mintAddress,
                ticker: tokenInfo.symbol,
                priceUsd: tokenInfo.price.toString()
            };
        }
    }
    return null;
}

/**
 * Get token price information for a single Solana token by mint address
 * 
 * @param {string} mintAddress - The Solana token mint address
 * @returns {Promise<Object|null>} Token price info or null if not found
 * @returns {string} return.mintAddress - The token mint address
 * @returns {string} return.ticker - The token symbol/ticker
 * @returns {string} return.priceUsd - The token price in USD
 */
export async function getTokenPrice(mintAddress) {
    // Check if it's a known token with fixed price (e.g. stablecoins)
    const knownPrice = getKnownTokenPrice(mintAddress);
    if (knownPrice) {
        return knownPrice;
    }
    
    try {
        const url = `${DEXSCREENER_API_BASE}/tokens/${mintAddress}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            console.error(`DexScreener API error: ${response.status} ${response.statusText}`);
            return null;
        }
        
        const data = await response.json();
        
        if (!data.pairs || data.pairs.length === 0) {
            console.warn(`No trading pairs found for token: ${mintAddress}`);
            return null;
        }
        
        // Find the pair with the highest liquidity (most reliable price)
        const bestPair = data.pairs.reduce((best, current) => {
            const bestLiquidity = best.liquidity?.usd || 0;
            const currentLiquidity = current.liquidity?.usd || 0;
            return currentLiquidity > bestLiquidity ? current : best;
        });
        
        // Determine if the queried token is the base or quote token
        const isBaseToken = bestPair.baseToken.address.toLowerCase() === mintAddress.toLowerCase();
        const isQuoteToken = bestPair.quoteToken.address.toLowerCase() === mintAddress.toLowerCase();
        
        let ticker, priceUsd;
        
        if (isBaseToken) {
            ticker = bestPair.baseToken.symbol;
            priceUsd = bestPair.priceUsd;
        } else if (isQuoteToken) {
            ticker = bestPair.quoteToken.symbol;
            // For quote token, we need to find a pair where it's the base token
            // Look through all pairs to find one where our token is the base
            const quoteAsBasePair = data.pairs.find(pair => 
                pair.baseToken.address.toLowerCase() === mintAddress.toLowerCase()
            );
            
            if (quoteAsBasePair) {
                priceUsd = quoteAsBasePair.priceUsd;
            } else {
                // If we can't find the token as base, use priceNative and calculate
                // priceNative is the price in the quote token, so we can derive USD price
                priceUsd = bestPair.priceNative ? (parseFloat(bestPair.priceNative) * parseFloat(bestPair.priceUsd)).toString() : null;
            }
        } else {
            // Fallback: token address doesn't match either (shouldn't happen)
            console.warn(`Token ${mintAddress} doesn't match base or quote in best pair`);
            ticker = bestPair.baseToken.symbol;
            priceUsd = bestPair.priceUsd;
        }
        
        return {
            mintAddress: mintAddress,
            ticker: ticker,
            priceUsd: priceUsd
        };
        
    } catch (error) {
        console.error(`Error fetching price for ${mintAddress}:`, error.message);
        return null;
    }
}

/**
 * Get token price information for multiple Solana tokens by mint addresses
 * 
 * Note: DexScreener returns max 30 pairs per request. When querying multiple tokens,
 * tokens with many pairs (like SOL) can fill all 30 slots. To ensure all tokens are
 * fetched, this function makes individual requests for each token.
 * 
 * @param {string[]} mintAddresses - Array of Solana token mint addresses
 * @returns {Promise<Object[]>} Array of token price info objects
 * @returns {string} return[].mintAddress - The token mint address
 * @returns {string} return[].ticker - The token symbol/ticker
 * @returns {string} return[].priceUsd - The token price in USD
 */
export async function getTokenPrices(mintAddresses) {
    if (!Array.isArray(mintAddresses) || mintAddresses.length === 0) {
        throw new Error('mintAddresses must be a non-empty array');
    }
    
    try {
        // Fetch each token individually to avoid the 30-pair limit issue
        const promises = mintAddresses.map(address => getTokenPrice(address));
        const results = await Promise.all(promises);
        
        // Filter out null results (tokens not found)
        return results.filter(result => result !== null);
        
    } catch (error) {
        console.error('Error fetching prices:', error.message);
        return [];
    }
}

/**
 * Get detailed token information including price, liquidity, volume, and market data
 * 
 * @param {string} mintAddress - The Solana token mint address
 * @returns {Promise<Object|null>} Detailed token info or null if not found
 */
export async function getTokenDetails(mintAddress) {
    // Check if it's a known token with fixed price (e.g. stablecoins)
    const knownPrice = getKnownTokenPrice(mintAddress);
    if (knownPrice) {
        // Return extended format for getTokenDetails
        return {
            ...knownPrice,
            name: KNOWN_TOKENS[Object.keys(KNOWN_TOKENS).find(k => KNOWN_TOKENS[k].mint === mintAddress)]?.symbol || knownPrice.ticker,
            priceNative: null,
            liquidity: null,
            volume24h: null,
            priceChange24h: null,
            marketCap: null,
            fdv: null,
            dexId: 'hardcoded',
            pairAddress: null,
            quoteToken: 'USD'
        };
    }
    
    try {
        const url = `${DEXSCREENER_API_BASE}/tokens/${mintAddress}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            console.error(`DexScreener API error: ${response.status} ${response.statusText}`);
            return null;
        }
        
        const data = await response.json();
        
        if (!data.pairs || data.pairs.length === 0) {
            console.warn(`No trading pairs found for token: ${mintAddress}`);
            return null;
        }
        
        // Find the pair with the highest liquidity (most reliable price)
        const bestPair = data.pairs.reduce((best, current) => {
            const bestLiquidity = best.liquidity?.usd || 0;
            const currentLiquidity = current.liquidity?.usd || 0;
            return currentLiquidity > bestLiquidity ? current : best;
        });
        
        // Determine if the queried token is the base or quote token
        const isBaseToken = bestPair.baseToken.address.toLowerCase() === mintAddress.toLowerCase();
        const isQuoteToken = bestPair.quoteToken.address.toLowerCase() === mintAddress.toLowerCase();
        
        let ticker, name, priceUsd;
        
        if (isBaseToken) {
            ticker = bestPair.baseToken.symbol;
            name = bestPair.baseToken.name;
            priceUsd = bestPair.priceUsd;
        } else if (isQuoteToken) {
            ticker = bestPair.quoteToken.symbol;
            name = bestPair.quoteToken.name;
            // For quote token, we need to find a pair where it's the base token
            // Look through all pairs to find one where our token is the base
            const quoteAsBasePair = data.pairs.find(pair => 
                pair.baseToken.address.toLowerCase() === mintAddress.toLowerCase()
            );
            
            if (quoteAsBasePair) {
                priceUsd = quoteAsBasePair.priceUsd;
            } else {
                // If we can't find the token as base, use priceNative and calculate
                // priceNative is the price in the quote token, so we can derive USD price
                priceUsd = bestPair.priceNative ? (parseFloat(bestPair.priceNative) * parseFloat(bestPair.priceUsd)).toString() : null;
            }
        } else {
            // Fallback: token address doesn't match either (shouldn't happen)
            console.warn(`Token ${mintAddress} doesn't match base or quote in best pair`);
            ticker = bestPair.baseToken.symbol;
            name = bestPair.baseToken.name;
            priceUsd = bestPair.priceUsd;
        }
        
        return {
            mintAddress: mintAddress,
            ticker: ticker,
            name: name,
            priceUsd: priceUsd,
            priceNative: bestPair.priceNative,
            liquidity: bestPair.liquidity?.usd,
            volume24h: bestPair.volume?.h24,
            priceChange24h: bestPair.priceChange?.h24,
            marketCap: bestPair.marketCap,
            fdv: bestPair.fdv,
            dexId: bestPair.dexId,
            pairAddress: bestPair.pairAddress,
            quoteToken: bestPair.quoteToken.symbol
        };
        
    } catch (error) {
        console.error(`Error fetching details for ${mintAddress}:`, error.message);
        return null;
    }
}
