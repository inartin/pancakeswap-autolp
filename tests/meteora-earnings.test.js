import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import BN from 'bn.js';
import { Keypair } from '@solana/web3.js';
import { meteora_fee_samples } from '../src/db/schema.js';
import { calculateMeteoraEarnings } from '../src/protocols/meteora/earnings.js';
import { createMeteoraEarningsStore } from '../src/protocols/meteora/earnings-store.js';
import { readMeteoraEarningsSnapshot } from '../src/protocols/meteora/earnings-snapshot.js';
import { formatMeteoraApr } from '../src/protocols/meteora/presentation.js';

const start = 1800000000000;
function sample(minute, overrides = {}) {
    return { position_address: 'position', recorded_at: start + minute * 60000,
        fee_x: String(1000000 + minute * 10000), fee_y: '2000000',
        decimals_x: 6, decimals_y: 6, price_x: 2, price_y: 1,
        position_value_usd: 1000, in_range: true, ...overrides };
}
function window(overrides = {}) { return Array.from({ length: 6 }, (_, i) => sample(i, overrides)); }

test('annualizes the actual five-minute token fee delta and values it at current prices', () => {
    const rows = window();
    rows[0].price_x = 1;
    rows.at(-1).price_x = 4;
    const rate = calculateMeteoraEarnings(rows, start + 5 * 60000);
    assert.equal(rate.windowMinutes, 5);
    assert.ok(Math.abs(rate.estHourUsd - 2.4) < 1e-10);
    assert.ok(Math.abs(rate.estDayUsd - 57.6) < 1e-10);
    assert.ok(Math.abs(rate.positionApr - 2102.4) < 1e-8);
});

test('zero fee growth stays zero despite token price or position balance changes', () => {
    const rows = window({ fee_x: '1000000' });
    rows.at(-1).price_x = 100;
    rows.at(-1).position_value_usd = 2000;
    assert.equal(calculateMeteoraEarnings(rows, rows.at(-1).recorded_at).positionApr, 0);
});

test('warming up, stale observations, gaps, and counter resets are unavailable', () => {
    assert.equal(calculateMeteoraEarnings([sample(0)], start).positionApr, null);
    const rows = window();
    assert.equal(calculateMeteoraEarnings(rows, start + 8 * 60000).positionApr, null);
    assert.equal(calculateMeteoraEarnings([sample(0), sample(5)], start + 5 * 60000).positionApr, null);
    rows[3].fee_x = '900000';
    assert.equal(calculateMeteoraEarnings(rows, start + 5 * 60000).positionApr, null);
});

test('out-of-range is zero now and missing valuation never becomes a fabricated zero', () => {
    assert.equal(calculateMeteoraEarnings([sample(0, { in_range: false })], start).positionApr, 0);
    for (const override of [{ price_x: null }, { position_value_usd: null }]) {
        assert.equal(calculateMeteoraEarnings(window(override), start + 5 * 60000).positionApr, null);
    }
});

test('subtracts large atomic counters before conversion to avoid precision loss', () => {
    const big = 2n ** 64n - 100n;
    const rows = window().map((row, i) => ({ ...row, fee_x: String(big + BigInt(i)), fee_y: '0' }));
    assert.ok(calculateMeteoraEarnings(rows, rows.at(-1).recorded_at).estHourUsd > 0);
});

test('SQLite observations survive tracker recreation, deduplicate rapid refreshes and prune the short history', () => {
    const sqlite = new Database(':memory:');
    try {
        sqlite.exec(fs.readFileSync(new URL('../drizzle/0002_happy_namorita.sql', import.meta.url), 'utf8'));
        const db = drizzle(sqlite);
        let observe = createMeteoraEarningsStore(db, meteora_fee_samples);
        for (const row of window()) observe(row);
        observe(sample(5));
        assert.equal(db.select().from(meteora_fee_samples).all().length, 6);
        observe = createMeteoraEarningsStore(db, meteora_fee_samples);
        assert.ok(observe(sample(6)).positionApr > 0);
        assert.equal(observe(sample(40)).positionApr, null);
        assert.equal(db.select().from(meteora_fee_samples).all().length, 1);
    } finally { sqlite.close(); }
});

test('SDK observations add claimed and unclaimed amounts so claims do not interrupt earning', async () => {
    const data = { totalXAmount: '1000000', totalYAmount: '2000000', lowerBinId: -1, upperBinId: 1,
        totalClaimedFeeXAmount: new BN(10), totalClaimedFeeYAmount: new BN(20), feeX: new BN(100), feeY: new BN(200) };
    const pool = { tokenX: { mint: { decimals: 6 } }, tokenY: { mint: { decimals: 6 } },
        lbPair: { activeId: 0, binStep: 10 }, fromPricePerLamport: p => p,
        getPosition: async () => ({ positionData: data }) };
    const address = Keypair.generate().publicKey.toBase58();
    const before = await readMeteoraEarningsSnapshot(pool, address, 2, 1);
    data.totalClaimedFeeXAmount = new BN(110);
    data.feeX = new BN(0);
    const after = await readMeteoraEarningsSnapshot(pool, address, 2, 1);
    assert.equal(before.fee_x, after.fee_x);
    assert.equal(after.position_value_usd, 4);
    assert.equal(after.in_range, true);
});

test('display separates current and average income, preserving average while current is unavailable or zero', () => {
    const position = { liquidityValueUsd: 1000, avgAprData: { daily: { avgPositionApr: 365, sampleCount: 1 } } };
    const waiting = formatMeteoraApr(position);
    assert.match(waiting, /Current APR:\* unavailable/);
    assert.match(waiting, /Avg 24h: 365/);
    assert.match(waiting, /Estimated Income \(24h avg rate\)/);
    const zero = formatMeteoraApr({ ...position, aprData: { positionApr: 0, estHourUsd: 0, estDayUsd: 0 } });
    assert.match(zero, /Current APR:\* 0/);
    assert.match(zero, /Avg 24h: 365/);
    const active = formatMeteoraApr({ ...position, aprData: calculateMeteoraEarnings(window(), start + 5 * 60000) });
    assert.match(active, /last 5.0m/);
    assert.match(active, /Estimated Income \(current rate\)/);
});
