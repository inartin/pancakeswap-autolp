// Rates are measured from cumulative swap-fee token amounts, never USD balance changes.
export const CURRENT_WINDOW_MS = 5 * 60 * 1000;
export const MAX_WINDOW_MS = 10 * 60 * 1000;
export const MAX_SAMPLE_AGE_MS = 2 * 60 * 1000;

export function calculateMeteoraEarnings(samples, now = Date.now()) {
    const latest = samples.at(-1);
    const unavailable = { positionApr: null, estHourUsd: null, estDayUsd: null, windowMinutes: null };
    if (!latest || now - latest.recorded_at > MAX_SAMPLE_AGE_MS) return unavailable;
    if (!latest.in_range) return { positionApr: 0, estHourUsd: 0, estDayUsd: 0, windowMinutes: null };
    const baseline = samples.findLast(sample => {
        const age = latest.recorded_at - sample.recorded_at;
        return age >= CURRENT_WINDOW_MS && age <= MAX_WINDOW_MS;
    });
    if (!baseline || !(latest.position_value_usd > 0)) return unavailable;
    const windowSamples = samples.filter(sample => sample.recorded_at >= baseline.recorded_at);
    for (let i = 1; i < windowSamples.length; i++) {
        const before = windowSamples[i - 1], after = windowSamples[i];
        if (after.recorded_at - before.recorded_at > MAX_SAMPLE_AGE_MS ||
            BigInt(after.fee_x) < BigInt(before.fee_x) || BigInt(after.fee_y) < BigInt(before.fee_y)) return unavailable;
    }
    const deltaX = Number(BigInt(latest.fee_x) - BigInt(baseline.fee_x)) / 10 ** latest.decimals_x;
    const deltaY = Number(BigInt(latest.fee_y) - BigInt(baseline.fee_y)) / 10 ** latest.decimals_y;
    if ((deltaX > 0 && !(latest.price_x > 0)) || (deltaY > 0 && !(latest.price_y > 0))) return unavailable;
    const earnedUsd = deltaX * (latest.price_x ?? 0) + deltaY * (latest.price_y ?? 0);
    const elapsedMs = latest.recorded_at - baseline.recorded_at;
    const estHourUsd = earnedUsd * 3600000 / elapsedMs;
    const estDayUsd = estHourUsd * 24;
    const positionApr = estDayUsd / latest.position_value_usd * 365 * 100;
    if (![positionApr, estHourUsd, estDayUsd].every(Number.isFinite)) return unavailable;
    return { positionApr, estHourUsd, estDayUsd, windowMinutes: elapsedMs / 60000 };
}
