import { db } from '../../db/index.js';
import { positions as positionsTable } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { getPositionStatistics } from '../../services/position-statistics.service.js';

export async function formatMeteoraStats(meteoraPositions, positionCount, currentSolPrice, formatStats) {
    const messages = [];
    // Process Meteora DLMM positions
    for (let i = 0; i < meteoraPositions.length; i++) {
        const mPos = meteoraPositions[i];
        const displayIndex = positionCount + i + 1;

        try {
            // Get position from DB
            const dbPositions = await db.select()
                .from(positionsTable)
                .where(eq(positionsTable.nft_mint, mPos.mintAddress))
                .limit(1);

            const dbPosition = dbPositions[0] || {
                token0_symbol: mPos.token0Symbol,
                token1_symbol: mPos.token1Symbol,
                token0_mint: mPos.mint0,
                token1_mint: mPos.mint1,
            };
            dbPosition.protocol = 'meteora';

            const stats = dbPositions[0] ? await getPositionStatistics(dbPositions[0].id) : null;

            // Group claimable fee data for rewards section
            const transfers = [];
            const tokenPrices = {};
            if (mPos.unclaimedFeeToken0 > 0) {
                transfers.push({
                    token: mPos.mint0,
                    uiAmount: mPos.unclaimedFeeToken0,
                    decimals: 8
                });
                const priceUsd = (mPos.unclaimedFeeToken0 > 0 && mPos.unclaimedFeeToken0Usd)
                    ? (mPos.unclaimedFeeToken0Usd / mPos.unclaimedFeeToken0).toString()
                    : null;
                tokenPrices[mPos.mint0] = {
                    ticker: mPos.token0Symbol,
                    priceUsd
                };
            }
            if (mPos.unclaimedFeeToken1 > 0) {
                transfers.push({
                    token: mPos.mint1,
                    uiAmount: mPos.unclaimedFeeToken1,
                    decimals: 6
                });
                const priceUsd = (mPos.unclaimedFeeToken1 > 0 && mPos.unclaimedFeeToken1Usd)
                    ? (mPos.unclaimedFeeToken1Usd / mPos.unclaimedFeeToken1).toString()
                    : null;
                tokenPrices[mPos.mint1] = {
                    ticker: mPos.token1Symbol,
                    priceUsd
                };
            }

            const rewardsData = transfers.length > 0 ? {
                transfers,
                tokenPrices,
                totalUsd: mPos.unclaimedFeesUsd || 0
            } : null;

            const rangeData = {
                inRange: mPos.inRange,
                liquidityValueUsd: mPos.liquidityValueUsd,
                amount0Human: mPos.amount0Human,
                amount1Human: mPos.amount1Human,
                token0PriceUsd: mPos.amount0Human > 0 && mPos.amount0Usd ? (mPos.amount0Usd / mPos.amount0Human) : null,
                token1PriceUsd: mPos.amount1Human > 0 && mPos.amount1Usd ? (mPos.amount1Usd / mPos.amount1Human) : null
            };

            const message = formatStats(dbPosition, stats, rangeData, displayIndex, currentSolPrice, rewardsData);
            messages.push(message);

        } catch (error) {
            console.error(`Error processing Meteora position ${mPos.mintAddress}:`, error);
            messages.push(`📊 *Position #${displayIndex}*\n\n❌ Error: ${error.message}`);
        }
    }

    return messages;
}
