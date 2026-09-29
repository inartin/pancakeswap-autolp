import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { BorshCoder } from '@coral-xyz/anchor';
import { METEORA_IDL, METEORA_PROGRAM_ID } from './constants.js';
import { sendClaimTransaction } from '../../chains/solana/claim-transaction.js';
import { transferToClaimAddress } from '../../chains/solana/claim-transfer.js';
const getTokenInfo = async mint => (await import('../../utils/token.util.js')).getTokenInfo(mint);
const forwardClaim = (...args) => transferToClaimAddress(...args, (connection, tx, signers) => sendClaimTransaction(connection, tx, signers[0]));

const coder = new BorshCoder(METEORA_IDL);
const inFlight = new Set();

async function loadPosition(connection, address, owner) {
    const account = await connection.getAccountInfo(address);
    if (!account?.owner.equals(METEORA_PROGRAM_ID)) throw new Error('Not a Meteora DLMM position');
    let decoded;
    try { decoded = coder.accounts.decode('PositionV2', account.data); }
    catch { decoded = coder.accounts.decode('Position', account.data); }
    if (!decoded.owner.equals(owner)) throw new Error('Position does not belong to the active wallet');
    // The SDK's ESM build contains directory imports unsupported by Node.
    const sdk = createRequire(import.meta.url)('@meteora-ag/dlmm');
    const DLMM = sdk.default || sdk;
    const pool = await DLMM.create(connection, decoded.lb_pair, { skipSolWrappingOperation: true });
    const position = await pool.getPosition(address);
    return { pool, position };
}

export function validateClaimOwner(position, owner) {
    if (!position.positionData.owner.equals(owner)) throw new Error('Position does not belong to the active wallet');
    const feeOwner = position.positionData.feeOwner;
    if (!feeOwner.equals(PublicKey.default) && !feeOwner.equals(owner)) {
        throw new Error('This position has a separate on-chain fee owner. Claim via Meteora to preserve that destination.');
    }
}

// Use only confirmed transaction deltas, never the wallet balance or an API estimate.
export function receivedTokens(meta, owner, mints) {
    const balances = new Map();
    for (const [rows, sign] of [[meta.preTokenBalances || [], -1n], [meta.postTokenBalances || [], 1n]]) {
        for (const row of rows) {
            if (row.owner !== owner || !mints.has(row.mint)) continue;
            const entry = balances.get(row.mint) || { mint: row.mint, amount: 0n, decimals: row.uiTokenAmount.decimals };
            entry.amount += sign * BigInt(row.uiTokenAmount.amount);
            balances.set(row.mint, entry);
        }
    }
    return [...balances.values()].filter(t => t.amount > 0n).map(t => ({
        ...t, amount: t.amount.toString(), uiAmount: Number(t.amount) / 10 ** t.decimals, type: 'fee_or_reward'
    }));
}

// Dependencies allow deterministic tests without RPC, signing, or sending funds.
export function createMeteoraClaimer({ load = loadPosition, send = sendClaimTransaction, tokenInfo = getTokenInfo, transfer = forwardClaim } = {}) {
    return async function claim(connection, wallet, address, claimAddress = null, splitStrategy = false, onConfirmed = async () => {}) {
        const key = address.toBase58();
        if (inFlight.has(key)) throw new Error('A claim for this position is already running');
        if (claimAddress) new PublicKey(claimAddress);
        inFlight.add(key);
        const results = [];
        const warnings = [];
        let pendingSignature = null;
        let error = null;
        try {
            const { pool, position } = await load(connection, address, wallet.publicKey);
            validateClaimOwner(position, wallet.publicKey);
            const mints = new Set([pool.tokenX.publicKey, pool.tokenY.publicKey,
                ...pool.lbPair.rewardInfos.map(r => r.mint)].filter(m => !m.equals(PublicKey.default)).map(m => m.toBase58()));
            const transactions = await pool.claimAllRewardsByPosition({ owner: wallet.publicKey, position });
            if (!transactions.length) throw new Error('No fees or rewards to claim');
            for (const transaction of transactions) {
                const sent = await send(connection, transaction, wallet);
                if (!sent.success) {
                    pendingSignature = sent.signature;
                    error = sent.uncertain ? `Confirmation unknown: ${sent.error}. Check the transaction before retrying.` : sent.error;
                    break;
                }
                const result = { success: true, signature: sent.signature, explorer: `https://solscan.io/tx/${sent.signature}`, claimed: [], totalUsd: 0, transactionFee: 0 };
                result.position = { pool_address: pool.pubkey.toBase58(), token0_mint: pool.tokenX.publicKey.toBase58(), token1_mint: pool.tokenY.publicKey.toBase58() };
                results.push(result);
                let details;
                try {
                    details = await connection.getTransaction(sent.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
                } catch (err) { warnings.push(`Receipt unavailable: ${err.message}`); }
                if (!details?.meta || details.meta.err) {
                    warnings.push('Claim confirmed, but receipt unavailable. Funds remain in the wallet; forwarding was skipped.');
                    await onConfirmed(result);
                    break;
                }
                result.transactionFee = details.meta.fee / 1e9;
                const tokens = receivedTokens(details.meta, wallet.publicKey.toBase58(), mints);
                result.claimed = await Promise.all(tokens.map(async token => {
                    const info = await tokenInfo(token.mint).catch(() => null);
                    return { ...token, symbol: info?.ticker || token.mint, usdValue: token.uiAmount * (Number(info?.price) || 0) };
                }));
                result.totalUsd = result.claimed.reduce((sum, t) => sum + t.usdValue, 0);
                // Persist each confirmed transaction even if a later claim or transfer fails.
                try { await onConfirmed(result); }
                catch (err) { warnings.push(`Claim confirmed, but history could not be saved: ${err.message}`); }
                if (claimAddress && claimAddress !== wallet.publicKey.toBase58() && result.claimed.length) {
                    try { result.transfer = await transfer(connection, wallet, claimAddress, result.claimed, false, splitStrategy); }
                    catch (err) { result.transfer = { transferred: false, error: err.message }; }
                }
            }
        } catch (err) { error = err.message; }
        finally { inFlight.delete(key); }
        return { success: !error && warnings.length === 0, results, warnings, error, pendingSignature };
    };
}

export const claimMeteoraRewards = createMeteoraClaimer();
