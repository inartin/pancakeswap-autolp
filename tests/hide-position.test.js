import { formatPositionsListMessage } from '../src/bot/formatters/message.formatter.js';
import { buildPositionsInlineKeyboard } from '../src/bot/handlers/positions.handler.js';
import { togglePositionHidden, getPositionHiddenStatus, upsertPosition } from '../src/services/position.service.js';
import { db } from '../src/db/index.js';
import { positions as positionsTable, wallets } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function runTests() {
    console.log('🧪 Testing Out-of-Range Position Show/Hide Toggle...\n');

    // Get or setup wallet for testing
    let wallet = (await db.select().from(wallets).limit(1))[0];
    if (!wallet) {
        const inserted = await db.insert(wallets).values({
            user_telegram_id: 123456789,
            wallet_address: 'TestWalletHidePos11111111111111111111111111111',
            encrypted_private_key: 'dummy',
            nonce: 'dummy',
            salt: 'dummy',
            label: 'Test Hide Wallet'
        }).returning();
        wallet = inserted[0];
    }

    const dummyMintOor = 'DummyMintOor1111111111111111111111111111111111';
    const dummyMintInRange = 'DummyMintInRange11111111111111111111111111111';

    // Clean up any previous test positions
    await db.delete(positionsTable).where(eq(positionsTable.nft_mint, dummyMintOor));
    await db.delete(positionsTable).where(eq(positionsTable.nft_mint, dummyMintInRange));

    // Test 1: In-Range Position does NOT have a hide button
    console.log('Test 1: In-Range Position does not have a show/hide button');
    const inRangePos = {
        success: true,
        protocol: 'pancakeswap',
        mintAddress: dummyMintInRange,
        poolId: 'pool1',
        mint0: 'mint0',
        mint1: 'mint1',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
        lowerPrice: 100,
        upperPrice: 200,
        currentPrice: 150,
        inRange: true,
        is_hidden: false,
        liquidityValueUsd: 500
    };

    const inRangeKb = await buildPositionsInlineKeyboard([inRangePos], wallet);
    const inRangeFlatButtons = inRangeKb.inline_keyboard.flat();
    const hasHideBtnInRange = inRangeFlatButtons.some(b => b.callback_data && b.callback_data.startsWith('toggle_hide_'));
    if (hasHideBtnInRange) {
        throw new Error('In-range position should not have a toggle_hide button');
    }
    console.log('  ✅ No toggle_hide button for in-range position\n');

    // Test 2: Out-of-Range Position (Shown) has "👁️ Hide #1" button
    console.log('Test 2: Out-of-Range Position (Shown) has "👁️ Hide #1" button');
    const oorPosShown = {
        success: true,
        protocol: 'pancakeswap',
        mintAddress: dummyMintOor,
        poolId: 'pool2',
        mint0: 'mint0',
        mint1: 'mint1',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
        lowerPrice: 100,
        upperPrice: 150,
        currentPrice: 200,
        inRange: false,
        is_hidden: false,
        liquidityValueUsd: 1000
    };

    const oorShownKb = await buildPositionsInlineKeyboard([oorPosShown], wallet);
    const oorShownButtons = oorShownKb.inline_keyboard.flat();
    const hideBtn = oorShownButtons.find(b => b.callback_data === `toggle_hide_${dummyMintOor}`);
    if (!hideBtn || !hideBtn.text.includes('Hide #1')) {
        throw new Error(`Expected "👁️ Hide #1" button, got: ${JSON.stringify(hideBtn)}`);
    }
    console.log(`  ✅ Found hide button: "${hideBtn.text}"`);

    // Verify message formatting for shown position
    const msgShown = await formatPositionsListMessage([oorPosShown]);
    if (msgShown.includes('_(Hidden)_')) {
        throw new Error('Shown position should not contain (Hidden) tag');
    }
    console.log('  ✅ Formatted message displays full position info when shown\n');

    // Test 3: Out-of-Range Position (Hidden) has "👁️ Show #1" button and compact message
    console.log('Test 3: Out-of-Range Position (Hidden) has "👁️ Show #1" button and compact message');
    const oorPosHidden = {
        ...oorPosShown,
        is_hidden: true
    };

    const oorHiddenKb = await buildPositionsInlineKeyboard([oorPosHidden], wallet);
    const oorHiddenButtons = oorHiddenKb.inline_keyboard.flat();
    const showBtn = oorHiddenButtons.find(b => b.callback_data === `toggle_hide_${dummyMintOor}`);
    if (!showBtn || !showBtn.text.includes('Show #1')) {
        throw new Error(`Expected "👁️ Show #1" button, got: ${JSON.stringify(showBtn)}`);
    }
    console.log(`  ✅ Found show button: "${showBtn.text}"`);

    // In hidden mode, normal action buttons (Close, Rebalance, etc.) should not be present
    const hasCloseBtn = oorHiddenButtons.some(b => b.callback_data && b.callback_data.startsWith('position_close_'));
    if (hasCloseBtn) {
        throw new Error('Hidden position should not display Close button');
    }
    console.log('  ✅ Action buttons are collapsed/hidden');

    // Verify compact message formatting for hidden position
    const msgHidden = await formatPositionsListMessage([oorPosHidden]);
    if (!msgHidden.includes('⭕ *Out of Range* _(Hidden)_')) {
        throw new Error(`Expected compact hidden message, got:\n${msgHidden}`);
    }
    console.log('  ✅ Formatted message displays compact ⭕ Out of Range (Hidden) placeholder\n');

    // Test 4: Database toggle functions
    console.log('Test 4: Database persistence with togglePositionHidden');
    // Ensure position is inserted in DB
    const savedPos = await upsertPosition({
        wallet_id: wallet.id,
        nft_mint: dummyMintOor,
        pool_address: 'pool2',
        token0_mint: 'mint0',
        token1_mint: 'mint1',
        status: 'active'
    });

    const initialHidden = await getPositionHiddenStatus(dummyMintOor);
    if (initialHidden !== false) {
        throw new Error(`Initial hidden status should be false, got: ${initialHidden}`);
    }
    console.log('  ✅ Initial hidden status is false');

    const toggled1 = await togglePositionHidden(dummyMintOor);
    if (toggled1 !== true) {
        throw new Error(`After toggle 1, status should be true, got: ${toggled1}`);
    }
    const status1 = await getPositionHiddenStatus(dummyMintOor);
    if (status1 !== true) {
        throw new Error(`After toggle 1, getPositionHiddenStatus should return true, got: ${status1}`);
    }
    console.log('  ✅ togglePositionHidden(mint) -> true');

    const toggled2 = await togglePositionHidden(dummyMintOor);
    if (toggled2 !== false) {
        throw new Error(`After toggle 2, status should be false, got: ${toggled2}`);
    }
    const status2 = await getPositionHiddenStatus(dummyMintOor);
    if (status2 !== false) {
        throw new Error(`After toggle 2, getPositionHiddenStatus should return false, got: ${status2}`);
    }
    console.log('  ✅ togglePositionHidden(mint) -> false');

    // Clean up test position
    await db.delete(positionsTable).where(eq(positionsTable.nft_mint, dummyMintOor));

    console.log('🎉 All Show/Hide toggle tests passed successfully!');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
