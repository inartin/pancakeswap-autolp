import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { BorshCoder } from '@coral-xyz/anchor';
import { METEORA_IDL, METEORA_PROGRAM_ID } from '../config/constants.js';
import { getMintDecimals } from './token.util.js';

const coder = new BorshCoder(METEORA_IDL);
const METEORA_DATAPI_URL = 'https://dlmm.datapi.meteora.ag';

/**
 * Convert DLMM bin ID to price in human token units (Y/X)
 * price = (1 + binStep / 10000)^binId * 10^(decimalsX - decimalsY)
 * 
 * @param {number} binId 
 * @param {number} binStep 
 * @param {number} decimalsX 
 * @param {number} decimalsY 
 * @returns {number}
 */
export function binIdToPrice(binId, binStep, decimalsX = 0, decimalsY = 0) {
    const rawPrice = Math.pow(1 + binStep / 10000, binId);
    const decimalFactor = Math.pow(10, decimalsX - decimalsY);
    return rawPrice * decimalFactor;
}

/**
 * Fetch all active Meteora DLMM positions for a user wallet address
 * Reads via Meteora DLMM Data API with full details (balances, claimable fees, range).
 * 
 * @param {string} walletAddress - User's Solana wallet address
 * @param {Connection} [connection] - Solana connection instance (optional fallback)
 * @returns {Promise<Array<Object>>} Array of enriched DLMM position objects
 */
export async function fetchMeteoraDlmmPositions(walletAddress, connection = null) {
    if (!walletAddress) return [];

    try {
        const portfolioUrl = `${METEORA_DATAPI_URL}/portfolio/open?user=${walletAddress}`;
        const portfolioRes = await axios.get(portfolioUrl, { timeout: 8000 });
        const pools = portfolioRes.data?.pools || [];

        if (pools.length === 0) {
            return [];
        }

        const positionsList = [];

        // For each pool with open positions, fetch position details
        for (const pool of pools) {
            try {
                const pnlUrl = `${METEORA_DATAPI_URL}/positions/${pool.poolAddress}/pnl?user=${walletAddress}&status=open`;
                const pnlRes = await axios.get(pnlUrl, { timeout: 8000 });
                const poolPositions = pnlRes.data?.positions || [];

                for (const pos of poolPositions) {
                    const minPrice = parseFloat(pos.minPrice) || 0;
                    const maxPrice = parseFloat(pos.maxPrice) || 0;
                    const currentPrice = parseFloat(pos.poolActivePrice) || 0;
                    const rangeWidth = maxPrice - minPrice;
                    const lowerDistancePercent = rangeWidth > 0 ? (Math.abs(currentPrice - minPrice) / rangeWidth) * 100 : 0;
                    const upperDistancePercent = rangeWidth > 0 ? (Math.abs(maxPrice - currentPrice) / rangeWidth) * 100 : 0;

                    const spreadFraction = (maxPrice - minPrice) / (maxPrice + minPrice);
                    const rangePercent = Math.round(spreadFraction * 100 * 10) / 10;

                    const fee0Usd = parseFloat(pos.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0);
                    const fee1Usd = parseFloat(pos.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
                    const totalUnclaimedUsd = fee0Usd + fee1Usd;

                    const feePerTvl24h = parseFloat(pos.feePerTvl24h || 0); // e.g. 0.321532% per 24h
                    const positionValueUsd = pos.unrealizedPnl?.balances || 0;
                    const inRange = !pos.isOutOfRange;

                    // feePerTvl24h is in percent (% per 24h). Convert % to daily factor (/ 100).
                    const estDayUsd = inRange ? positionValueUsd * (feePerTvl24h / 100) : 0;
                    const estHourUsd = estDayUsd / 24;
                    // Annualized APR is daily percentage * 365
                    const aprPercent = inRange ? feePerTvl24h * 365 : 0;

                    positionsList.push({
                        protocol: 'meteora',
                        isReadOnly: true,
                        success: true,
                        mintAddress: pos.positionAddress,
                        positionPda: pos.positionAddress,
                        poolId: pool.poolAddress,
                        mint0: pool.tokenXMint,
                        mint1: pool.tokenYMint,
                        token0Symbol: pool.tokenX,
                        token1Symbol: pool.tokenY,
                        token0Icon: pool.tokenXIcon,
                        token1Icon: pool.tokenYIcon,
                        binStep: pool.binStep,
                        feeTierPercent: (pool.baseFee || 0) / 100, // e.g. 0.04% -> 0.0004
                        lowerPrice: minPrice,
                        upperPrice: maxPrice,
                        currentPrice: currentPrice,
                        inRange: !pos.isOutOfRange,
                        outOfRangeDirection: pos.isOutOfRange ? (pos.poolActiveBinId < pos.lowerBinId ? 'below' : 'above') : null,
                        lowerDistancePercent,
                        upperDistancePercent,
                        range_percent: rangePercent,
                        liquidityValueUsd: positionValueUsd,
                        amount0Human: parseFloat(pos.unrealizedPnl?.balanceTokenX?.amount || 0),
                        amount1Human: parseFloat(pos.unrealizedPnl?.balanceTokenY?.amount || 0),
                        amount0Usd: parseFloat(pos.unrealizedPnl?.balanceTokenX?.usd || 0),
                        amount1Usd: parseFloat(pos.unrealizedPnl?.balanceTokenY?.usd || 0),
                        // Claimable (unclaimed) fees
                        unclaimedFeeToken0: parseFloat(pos.unrealizedPnl?.unclaimedFeeTokenX?.amount || 0),
                        unclaimedFeeToken1: parseFloat(pos.unrealizedPnl?.unclaimedFeeTokenY?.amount || 0),
                        unclaimedFeeToken0Usd: fee0Usd,
                        unclaimedFeeToken1Usd: fee1Usd,
                        unclaimedFeesUsd: totalUnclaimedUsd,
                        // All time fees
                        allTimeFeesToken0: parseFloat(pos.allTimeFees?.tokenX?.amount || 0),
                        allTimeFeesToken1: parseFloat(pos.allTimeFees?.tokenY?.amount || 0),
                        allTimeFeesUsd: parseFloat(pos.allTimeFees?.total?.usd || 0),
                        // Estimated APR
                        aprData: aprPercent > 0 ? {
                            positionApr: aprPercent,
                            estHourUsd,
                            estDayUsd
                        } : null,
                        positionUrl: `https://app.meteora.ag/dlmm/${pool.poolAddress}`,
                        poolUrl: `https://app.meteora.ag/dlmm/${pool.poolAddress}`,
                        createdAt: pos.createdAt || null,
                        updatedAt: pos.updatedAt || null
                    });
                }
            } catch (poolErr) {
                console.warn(`Failed to fetch positions for Meteora pool ${pool.poolAddress}:`, poolErr.message);
            }
        }

        return positionsList;
    } catch (error) {
        console.warn('Meteora Data API fetch failed:', error.message);
        return [];
    }
}

/**
 * Fetch and decode a single Meteora DLMM position on-chain using Anchor IDL
 * 
 * @param {Connection} connection - Solana connection
 * @param {string|PublicKey} positionAddress - Position account public key
 * @returns {Promise<Object>} Decoded and calculated position data
 */
export async function fetchMeteoraPositionOnChain(connection, positionAddress) {
    const positionPubkey = typeof positionAddress === 'string' ? new PublicKey(positionAddress) : positionAddress;
    const posAcc = await connection.getAccountInfo(positionPubkey);
    if (!posAcc) {
        throw new Error(`Meteora position account not found: ${positionPubkey.toBase58()}`);
    }

    // Attempt decode as PositionV2, fall back to Position
    let posData;
    let isV2 = true;
    try {
        posData = coder.accounts.decode('PositionV2', posAcc.data);
    } catch (e1) {
        posData = coder.accounts.decode('Position', posAcc.data);
        isV2 = false;
    }

    const pairPubkey = posData.lb_pair;
    const pairAcc = await connection.getAccountInfo(pairPubkey);
    if (!pairAcc) {
        throw new Error(`Meteora pair account not found: ${pairPubkey.toBase58()}`);
    }

    const pairData = coder.accounts.decode('LbPair', pairAcc.data);
    const mint0 = pairData.token_x_mint;
    const mint1 = pairData.token_y_mint;

    const [decimals0, decimals1] = await Promise.all([
        getMintDecimals(connection, mint0),
        getMintDecimals(connection, mint1)
    ]);

    const binStep = pairData.bin_step;
    const activeId = pairData.active_id;
    const lowerBinId = posData.lower_bin_id;
    const upperBinId = posData.upper_bin_id;

    const currentPrice = binIdToPrice(activeId, binStep, decimals0, decimals1);
    const lowerPrice = binIdToPrice(lowerBinId, binStep, decimals0, decimals1);
    const upperPrice = binIdToPrice(upperBinId, binStep, decimals0, decimals1);

    const inRange = activeId >= lowerBinId && activeId <= upperBinId;
    const outOfRangeDirection = !inRange ? (activeId < lowerBinId ? 'below' : 'above') : null;

    const rangeWidth = upperPrice - lowerPrice;
    const lowerDistancePercent = rangeWidth > 0 ? (Math.abs(currentPrice - lowerPrice) / rangeWidth) * 100 : 0;
    const upperDistancePercent = rangeWidth > 0 ? (Math.abs(upperPrice - currentPrice) / rangeWidth) * 100 : 0;

    const spreadFraction = (upperPrice - lowerPrice) / (upperPrice + lowerPrice);
    const rangePercent = Math.round(spreadFraction * 100 * 10) / 10;

    const claimedFeeX = Number(posData.total_claimed_fee_x_amount || 0) / Math.pow(10, decimals0);
    const claimedFeeY = Number(posData.total_claimed_fee_y_amount || 0) / Math.pow(10, decimals1);

    return {
        protocol: 'meteora',
        isReadOnly: true,
        success: true,
        mintAddress: positionPubkey.toBase58(),
        positionPda: positionPubkey.toBase58(),
        poolId: pairPubkey.toBase58(),
        mint0: mint0.toBase58(),
        mint1: mint1.toBase58(),
        token0Symbol: null,
        token1Symbol: null,
        binStep,
        feeTierPercent: 0,
        lowerPrice,
        upperPrice,
        currentPrice,
        inRange,
        outOfRangeDirection,
        lowerDistancePercent,
        upperDistancePercent,
        range_percent: rangePercent,
        liquidityValueUsd: 0,
        amount0Human: 0,
        amount1Human: 0,
        unclaimedFeeToken0: 0,
        unclaimedFeeToken1: 0,
        unclaimedFeesUsd: 0,
        allTimeFeesToken0: claimedFeeX,
        allTimeFeesToken1: claimedFeeY,
        allTimeFeesUsd: 0,
        positionUrl: `https://app.meteora.ag/dlmm/${pairPubkey.toBase58()}`,
        poolUrl: `https://app.meteora.ag/dlmm/${pairPubkey.toBase58()}`
    };
}
