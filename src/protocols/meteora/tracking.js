import { upsertPosition } from '../../services/position.service.js';
import { getPositionStatistics, updateAccumulatedTime } from '../../services/position-statistics.service.js';

export async function trackMeteoraPositions(meteoraPositions, wallet) {
    const enriched = [];
    for (const mPos of meteoraPositions) {
        let statistics = null;
        let positionId = null;
        let isHidden = false;

        try {
            const saved = await upsertPosition({
                wallet_id: wallet.id,
                nft_mint: mPos.mintAddress,
                pool_address: mPos.poolId,
                token0_mint: mPos.mint0,
                token1_mint: mPos.mint1,
                token0_symbol: mPos.token0Symbol,
                token1_symbol: mPos.token1Symbol,
                fee_tier: mPos.feeTierPercent,
                lower_price: mPos.lowerPrice,
                upper_price: mPos.upperPrice,
                current_price: mPos.currentPrice,
                liquidity_value_usd: mPos.liquidityValueUsd,
                range_percent: mPos.range_percent,
                auto_rebalance_enabled: false,
                claim_before_rebalance: false,
                status: 'active'
            });

            positionId = saved.id;
            isHidden = !!saved.is_hidden;
            statistics = await getPositionStatistics(saved.id);

            // Seed initial time in range from createdAt if statistics is fresh (0 ms accumulated)
            if (statistics && (statistics.time_in_range_ms + statistics.time_out_of_range_ms === 0)) {
                const createdAtMs = mPos.createdAt ? mPos.createdAt * 1000 : Date.now();
                const initialAgeMs = Math.max(0, Date.now() - createdAtMs);
                if (initialAgeMs > 0) {
                    await updateAccumulatedTime(positionId, initialAgeMs, mPos.inRange);
                    statistics = await getPositionStatistics(positionId);
                }
            }
        } catch (dbErr) {
            console.warn(`Failed to track Meteora position ${mPos.mintAddress} in DB:`, dbErr.message);
        }

        enriched.push({
            ...mPos,
            statistics,
            positionId,
            is_hidden: isHidden
        });
    }
    return enriched;
}
