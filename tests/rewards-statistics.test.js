import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Keep this formatting regression test independent of RPC and database initialization.
mock.module('../src/utils/token.util.js', { namedExports: { getTokenInfo: async () => null } });
const { formatRewardsMessage } = await import('../src/bot/formatters/message.formatter.js');
const positions = [
    { protocol: 'meteora', token0Symbol: 'cbBTC', token1Symbol: 'USDC', allTimeFeesUsd: 287.65, inRange: true },
    { protocol: 'meteora', token0Symbol: 'cbBTC', token1Symbol: 'USDC', allTimeFeesUsd: 105.43, inRange: false }
];

test('wallet claims are not mislabeled as PancakeSwap or mixed with lifetime fees', () => {
    const message = formatRewardsMessage('wallet', positions, 4.17);
    assert.doesNotMatch(message, /PancakeSwap/);
    assert.match(message, /Claims since reset:\* \$4\.17/);
    assert.match(message, /Meteora Total Fees:/);
    assert.match(message, /#1 cbBTC\/USDC: \$287\.65/);
    assert.match(message, /#2 cbBTC\/USDC _\(Out of Range\)_: \$105\.43/);
});

test('lifetime fees remain visible without a wallet counter and for a single position', () => {
    const message = formatRewardsMessage('wallet', positions.slice(0, 1), null);
    assert.doesNotMatch(message, /Claims since reset/);
    assert.match(message, /Meteora Total Fees/);
    assert.match(message, /\$287\.65/);
});

test('split preference does not fabricate compounded or forwarded amounts', () => {
    const message = formatRewardsMessage('wallet', positions, 4.17, true);
    assert.match(message, /Claims since reset:\* \$4\.17/);
    assert.doesNotMatch(message, /Compounded:/);
});
