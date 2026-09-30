import { upsertPosition } from '../../services/position.service.js';
import { getPositionStatistics, updateAccumulatedTime, getDailyAverageApr, getLifetimeAverageApr, recordAprSnapshot } from '../../services/position-statistics.service.js';
import { db } from '../../db/index.js';
import { meteora_fee_samples, position_apr_history } from '../../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { createMeteoraEarningsStore } from './earnings-store.js';

const observeEarnings = createMeteoraEarningsStore(db, meteora_fee_samples);

export async function trackMeteoraPositions(meteoraPositions, wallet, { background = false } = {}) {
    const enriched = [];
    for (const mPos of meteoraPositions) {
        let statistics = null;
        let positionId = null;
        let isHidden = false;
        let aprData = mPos.aprData;
        let avgAprData = mPos.avgAprData;

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
            if (mPos.earningsSnapshot) {
                aprData = await observeEarnings(mPos.earningsSnapshot);
                // Same four-hour cadence and shared historical averages as PancakeSwap.
                const latest = await db.select().from(position_apr_history)
                    .where(eq(position_apr_history.position_id, saved.id))
                    .orderBy(desc(position_apr_history.recorded_at)).limit(1);
                if (aprData.positionApr != null && (!latest[0] ||
                    Date.now() - new Date(latest[0].recorded_at).getTime() >= 4 * 3600000)) {
                    await recordAprSnapshot(saved.id, aprData, mPos.inRange, mPos.liquidityValueUsd, mPos.range_percent);
                }
            }
            if (!background) {
                const [daily, lifetime] = await Promise.all([getDailyAverageApr(saved.id), getLifetimeAverageApr(saved.id)]);
                avgAprData = { daily: mPos.avgAprData?.daily ?? daily, lifetime };
                statistics = await getPositionStatistics(saved.id);
            }

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
            aprData,
            avgAprData,
            statistics,
            positionId,
            is_hidden: isHidden
        });
    }
    return enriched;
}
