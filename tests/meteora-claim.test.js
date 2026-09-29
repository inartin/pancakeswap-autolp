import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { createRequire } from 'node:module';
import { createMeteoraClaimer, receivedTokens } from '../src/protocols/meteora/claim.js';
import { sendClaimTransaction } from '../src/chains/solana/claim-transaction.js';
import { meteoraClaimButtons, formatMeteoraRewards, formatMeteoraLinks } from '../src/protocols/meteora/presentation.js';

const owner = Keypair.generate();
const recipient = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey;
const otherMint = Keypair.generate().publicKey;
function row(amount, token = mint, who = owner.publicKey.toBase58()) {
    return { accountIndex: 1, mint: token.toBase58(), owner: who, uiTokenAmount: { amount, decimals: 6 } };
}
function fixture(overrides = {}) {
    const saved = [], forwarded = [], sent = [];
    const address = Keypair.generate().publicKey;
    const position = { positionData: { owner: owner.publicKey, feeOwner: PublicKey.default } };
    const pool = { pubkey: Keypair.generate().publicKey, tokenX: { publicKey: mint }, tokenY: { publicKey: otherMint }, lbPair: { rewardInfos: [] }, claimAllRewardsByPosition: async () => [{}, {}] };
    const meta = { fee: 5000, preTokenBalances: [row('100000000')], postTokenBalances: [row('102000000')] };
    const connection = { getTransaction: async () => ({ meta }) };
    const claim = createMeteoraClaimer({
        load: async () => ({ position, pool }),
        send: async () => { sent.push(1); return { success: true, signature: `sig${sent.length}` }; },
        tokenInfo: async () => ({ ticker: 'TOKEN', price: 2 }),
        transfer: async (...args) => { forwarded.push(args); return { transferred: true }; },
        ...overrides
    });
    return { claim, address, position, pool, meta, connection, saved, forwarded, sent,
        run: (to = recipient, split = true) => claim(connection, owner, address, to, split, async r => saved.push(r)) };
}

test('SDK CommonJS entry exposes the installed claim builder', () => {
    const sdk = createRequire(import.meta.url)('@meteora-ag/dlmm');
    const DLMM = sdk.default || sdk;
    assert.equal(typeof DLMM.create, 'function');
    assert.equal(typeof DLMM.prototype.claimAllRewardsByPosition, 'function');
});

test('claims every transaction and forwards only received tokens, preserving split setting', async () => {
    const f = fixture();
    const result = await f.run();
    assert.equal(result.success, true);
    assert.equal(f.saved.length, 2);
    assert.equal(f.forwarded.length, 2);
    assert.equal(f.saved[0].transactionFee, 0.000005);
    assert.equal(f.saved[0].totalUsd, 4);
    assert.equal(f.forwarded[0][3][0].amount, '2000000');
    assert.equal(f.forwarded[0][4], false); // WSOL is not unwrapped / pre-existing SOL never swept.
    assert.equal(f.forwarded[0][5], true);
});

test('wallet destination or no configured destination does not forward', async () => {
    for (const to of [null, owner.publicKey.toBase58()]) {
        const f = fixture();
        assert.equal((await f.run(to)).success, true);
        assert.equal(f.forwarded.length, 0);
    }
});

test('wrong owner and external fee owner fail before building or sending', async () => {
    for (const field of ['owner', 'feeOwner']) {
        const f = fixture();
        f.position.positionData[field] = Keypair.generate().publicKey;
        const result = await f.run();
        assert.equal(result.success, false);
        assert.equal(f.sent.length, 0);
        assert.equal(f.forwarded.length, 0);
    }
});

test('confirmed transactions survive a later confirmation failure', async () => {
    let count = 0;
    const f = fixture({ send: async () => ++count === 1 ? { success: true, signature: 'first' } : { success: false, signature: 'pending', uncertain: true, error: 'timeout' } });
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(result.results.length, 1);
    assert.equal(f.saved.length, 1);
    assert.equal(result.pendingSignature, 'pending');
    assert.match(result.error, /Check the transaction before retrying/);
});

test('missing receipt records the signature but stops forwarding and remaining claims', async () => {
    const f = fixture();
    f.connection.getTransaction = async () => null;
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(f.sent.length, 1);
    assert.equal(f.saved[0].signature, 'sig1');
    assert.equal(f.forwarded.length, 0);
});

test('unknown token price still records received amount and successful transaction', async () => {
    const f = fixture({ tokenInfo: async () => { throw new Error('price API unavailable'); } });
    await f.run(null);
    assert.equal(f.saved[0].claimed[0].amount, '2000000');
    assert.equal(f.saved[0].totalUsd, 0);
});

test('forward failure does not erase successful claim history', async () => {
    const f = fixture({ transfer: async () => { throw new Error('transfer failed'); } });
    const result = await f.run();
    assert.equal(f.saved.length, 2);
    assert.match(result.results[0].transfer.error, /transfer failed/);
});

test('invalid destination and empty claim fail without sending', async () => {
    const f = fixture();
    await assert.rejects(f.run('invalid'));
    f.pool.claimAllRewardsByPosition = async () => [];
    assert.equal((await f.run()).success, false);
    assert.equal(f.sent.length, 0);
});

test('receipt parser sums exact raw deltas, ignores other owners and unrelated tokens', () => {
    const result = receivedTokens({ preTokenBalances: [row('900719925474099300')], postTokenBalances: [row('900719925474099307'), row('5000', otherMint), row('888', mint, recipient)] }, owner.publicKey.toBase58(), new Set([mint.toBase58()]));
    assert.equal(result.length, 1);
    assert.equal(result[0].amount, '7');
});

test('concurrent clicks cannot submit two claims for the same position', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ tokenInfo: async () => { await gate; return {}; } });
    const pending = f.run();
    await assert.rejects(f.run(), /already running/);
    release();
    await pending;
});

test('sender retains signature on timeout and sends once', async () => {
    let sends = 0;
    const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: new PublicKey(recipient), lamports: 1 }));
    const result = await sendClaimTransaction({
        getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
        sendRawTransaction: async () => { sends++; },
        confirmTransaction: async () => { throw new Error('timeout'); }
    }, transaction, owner);
    assert.equal(sends, 1);
    assert.equal(result.uncertain, true);
    assert.ok(result.signature);
});

test('Meteora buttons expose claim/settings only, fit Telegram limits, and remove read-only labels', () => {
    const position = { mintAddress: Keypair.generate().publicKey.toBase58(), poolId: mint.toBase58(), token0Symbol: 'X', token1Symbol: 'Y', unclaimedFeesUsd: 2, unclaimedFeeToken0: 1 };
    const buttons = meteoraClaimButtons(position, 0);
    assert.equal(buttons[0].callback_data, `claim_${position.mintAddress}`);
    assert.equal(buttons[1].callback_data, 'set_claim_address');
    assert.ok(buttons.every(b => Buffer.byteLength(b.callback_data) <= 64));
    assert.doesNotMatch(formatMeteoraRewards(position, 0) + formatMeteoraLinks(position), /read-only/i);
});

test('shared Solana forwarding preserves dust handling and exact non-split amounts', async () => {
    const { transferToClaimAddress } = await import('../src/chains/solana/claim-transfer.js');
    const { decodeTransferCheckedInstruction, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
    const connection = { getAccountInfo: async () => ({}), getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { tokenAmount: { amount: '999999999999999999' } } } } } }) };
    let transaction;
    const send = async (_c, tx) => { transaction = tx; return { success: true, signature: 'transfer' }; };
    const token = { mint: mint.toBase58(), symbol: 'T', amount: '1234567', decimals: 6, uiAmount: 1.234567, usdValue: 2 };
    const result = await transferToClaimAddress(connection, owner, recipient, [token], false, false, send);
    assert.equal(result.transferred, true);
    assert.equal(decodeTransferCheckedInstruction(transaction.instructions[0], TOKEN_2022_PROGRAM_ID).data.amount, 1234567n);
    let sentDust = false;
    const dust = await transferToClaimAddress(connection, owner, recipient, [{ ...token, usdValue: 0.01 }], false, false, async () => { sentDust = true; });
    assert.equal(dust.reason, 'all_dust');
    assert.equal(sentDust, false);
});

test('shared forwarding retains uncertain signature instead of reporting a confirmed transfer', async () => {
    const { transferToClaimAddress } = await import('../src/chains/solana/claim-transfer.js');
    const connection = { getAccountInfo: async () => ({}), getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { tokenAmount: { amount: '10000000' } } } } } }) };
    const result = await transferToClaimAddress(connection, owner, recipient, [{ mint: mint.toBase58(), amount: '1000000', decimals: 6, uiAmount: 1, usdValue: 1 }], false, false,
        async () => ({ success: false, signature: 'uncertain-transfer', uncertain: true, error: 'timeout' }));
    assert.equal(result.transferred, false);
    assert.equal(result.signature, 'uncertain-transfer');
    assert.equal(result.uncertain, true);
});

test('real position loader rejects missing or non-Meteora accounts before sending', async () => {
    for (const account of [null, { owner: PublicKey.default }]) {
        const claim = createMeteoraClaimer({ send: async () => { assert.fail('must not send'); } });
        const result = await claim({ getAccountInfo: async () => account }, owner, Keypair.generate().publicKey);
        assert.equal(result.success, false);
        assert.match(result.error, /Not a Meteora/);
    }
});
