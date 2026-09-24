import { binIdToPrice, fetchMeteoraDlmmPositions } from '../src/utils/meteora-dlmm.util.js';
import { formatPositionsListMessage, formatRewardsMessage } from '../src/bot/formatters/message.formatter.js';

async function runTests() {
    console.log('🧪 Testing Meteora DLMM Integration...\n');

    // 1. Test binIdToPrice calculation
    console.log('Test 1: binIdToPrice math verification');
    // binStep = 4 (0.04%), binId = 0 -> price = 1
    const p0 = binIdToPrice(0, 4, 8, 6);
    console.log(`  binId=0, binStep=4, decX=8, decY=6 -> price: ${p0} (expected 100)`);
    if (Math.abs(p0 - 100) > 1e-6) {
        throw new Error(`Math check failed: expected 100, got ${p0}`);
    }
    console.log('  ✅ binIdToPrice verified\n');

    // 2. Test live position detection for sample wallet
    const testWallet = 'ART96xbeZg8i6kwHa1NnDkPUEHTiFikrTbuk9WB13MiN';
    console.log(`Test 2: Fetching live DLMM positions for ${testWallet}`);
    const positions = await fetchMeteoraDlmmPositions(testWallet);
    console.log(`  Found ${positions.length} Meteora DLMM positions`);

    if (positions.length > 0) {
        const p1 = positions[0];
        console.log(`  Position #1: ${p1.token0Symbol}/${p1.token1Symbol}`);
        console.log(`  Address: ${p1.mintAddress}`);
        console.log(`  Pool: ${p1.poolId}`);
        console.log(`  Claimable Fees: $${p1.unclaimedFeesUsd.toFixed(2)}`);
        console.log(`  TVL: $${p1.liquidityValueUsd.toFixed(2)}`);
        console.log(`  In Range: ${p1.inRange}`);
        console.log('  ✅ Live fetch verified\n');

        // 3. Test Message Formatting
        console.log('Test 3: Formatting positions & rewards messages');
        const posMessage = await formatPositionsListMessage(positions);
        if (!posMessage.includes('Meteora DLMM Position') || !posMessage.includes('Read-only')) {
            throw new Error('Positions list message missing Meteora headers or read-only notice');
        }
        console.log('  ✅ formatPositionsListMessage contains Meteora branding & read-only notice');

        const rewMessage = formatRewardsMessage(testWallet, positions);
        if (!rewMessage.includes('Meteora DLMM') || !rewMessage.includes('Read-only')) {
            throw new Error('Rewards message missing Meteora headers or read-only notice');
        }
        console.log('  ✅ formatRewardsMessage contains Meteora branding & read-only notice\n');
    }

    console.log('🎉 All Meteora DLMM integration tests passed successfully!');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
