import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';

const sdk = createRequire(import.meta.url)('@meteora-ag/dlmm');
const DLMM = sdk.default || sdk;

// One fresh SDK pool per API pool/request. Do not cache bin fee accumulators.
export async function loadMeteoraEarningsPool(connection, poolAddress) {
    return DLMM.create(connection, new PublicKey(poolAddress), { skipSolWrappingOperation: true });
}

export async function readMeteoraEarningsSnapshot(pool, positionAddress, priceX, priceY) {
    const { positionData: data } = await pool.getPosition(new PublicKey(positionAddress));
    const decimalsX = pool.tokenX.mint.decimals;
    const decimalsY = pool.tokenY.mint.decimals;
    const amount0Human = Number(data.totalXAmount) / 10 ** decimalsX;
    const amount1Human = Number(data.totalYAmount) / 10 ** decimalsY;
    const inRange = pool.lbPair.activeId >= data.lowerBinId && pool.lbPair.activeId <= data.upperBinId;
    const valueUsd = (amount0Human > 0 && !(priceX > 0)) || (amount1Human > 0 && !(priceY > 0))
        ? null : amount0Human * (priceX ?? 0) + amount1Human * (priceY ?? 0);
    return {
        position_address: positionAddress,
        recorded_at: Date.now(),
        fee_x: data.totalClaimedFeeXAmount.add(data.feeX).toString(),
        fee_y: data.totalClaimedFeeYAmount.add(data.feeY).toString(),
        decimals_x: decimalsX,
        decimals_y: decimalsY,
        price_x: priceX,
        price_y: priceY,
        position_value_usd: valueUsd,
        in_range: inRange,
        amount0Human,
        amount1Human,
        currentPrice: pool.fromPricePerLamport(Math.pow(1 + pool.lbPair.binStep / 10000, pool.lbPair.activeId))
    };
}
