import { db } from '../../db/index.js';
import { positions as positionsTable } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getActiveWallet } from '../../services/wallet.service.js';
import { upsertProximityAlert, getProximityAlert, setProximityEnabled } from '../../services/alert.service.js';
import { upsertPosition, updatePositionStatus } from '../../services/position.service.js';
import { createSolanaConnection } from '../../utils/rpc.util.js';
import { findPositions } from '../../utils/positions.util.js';
import { getTokenSymbol } from '../../config/constants.js';
import { resolveTokenSymbol } from '../../utils/token.util.js';

/**
 * /proximity command: list positions and allow setting proximity threshold
 * Minimal flow: select position → choose threshold (5/10/20) → save
 */
export async function handleProximity(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        const wallet = await getActiveWallet(telegramId);
        if (!wallet) {
            await bot.sendMessage(chatId, '❌ No wallet configured. Use /newwallet or /importwallet', { parse_mode: 'Markdown' });
            return;
        }

        // Fetch currently on-chain positions for this wallet to avoid stale/duplicate DB rows
        const connection = createSolanaConnection();
        const onchain = await findPositions(connection, wallet.wallet_address);
        const onchainMints = new Set((onchain || []).map(p => p.mintAddress));

        const rows = await db.select()
            .from(positionsTable)
            .where(and(
                eq(positionsTable.wallet_id, wallet.id),
                eq(positionsTable.status, 'active')
            ));

        // De-duplicate by NFT mint (prefer most recently updated)
        const uniqueByNft = new Map();
        for (const p of (Array.isArray(rows) ? rows : [])) {
            const existing = uniqueByNft.get(p.nft_mint);
            const prevTs = existing && typeof existing.updated_at === 'number' ? existing.updated_at : 0;
            const curTs = typeof p.updated_at === 'number' ? p.updated_at : 0;
            if (!existing || curTs > prevTs) {
                uniqueByNft.set(p.nft_mint, p);
            }
        }
        // Keep only rows that still exist on-chain
        let items = Array.from(uniqueByNft.values()).filter(p => onchainMints.has(p.nft_mint));

        // If nothing matched (first time), ensure we have DB rows from on-chain list
        if (items.length === 0 && onchainMints.size > 0) {
            const created = [];
            for (const pos of onchain) {
                try {
                    const [sym0, sym1] = await Promise.all([
                        resolveTokenSymbol(pos.mint0),
                        resolveTokenSymbol(pos.mint1)
                    ]);
                    const saved = await upsertPosition({
                        wallet_id: wallet.id,
                        nft_mint: pos.mintAddress,
                        pool_address: pos.poolId,
                        token0_mint: pos.mint0,
                        token1_mint: pos.mint1,
                        token0_symbol: sym0,
                        token1_symbol: sym1,
                        fee_tier: null,
                        lower_price: pos.lowerPrice,
                        upper_price: pos.upperPrice,
                        current_price: pos.currentPrice,
                        liquidity_value_usd: pos.liquidityValueUsd,
                        range_percent: null, // Not available from on-chain data
                        status: 'active'
                    });
                    created.push(saved);
                } catch (_) { /* ignore */ }
            }
            items = created;
        }

        // Mark DB rows as closed if not present on-chain anymore
        for (const p of uniqueByNft.values()) {
            if (!onchainMints.has(p.nft_mint) && p.status !== 'closed') {
                try { await updatePositionStatus(p.nft_mint, 'closed'); } catch (_) {}
            }
        }

        if (items.length === 0) {
            await bot.sendMessage(chatId, '❌ No positions found for your active wallet. Try /positions first.', { parse_mode: 'Markdown' });
            return;
        }

        if (items.length === 1) {
            const p = items[0];
            await sendPickerForPosition(bot, chatId, p);
            return;
        }

        const buttons = items.map((p) => ([{
            text: `Set Proximity: ${getPoolLabel(p)}`,
            callback_data: `proximity_select_${p.id}`
        }]));

        await bot.sendMessage(chatId,
            '🎚️ *Proximity Alerts*\n\nSelect a position to configure alerts:',
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            }
        );
    } catch (err) {
        console.error('handleProximity error:', err);
        await bot.sendMessage(chatId, `❌ Failed to load positions: ${err?.message || err}`);
    }
}

export async function handleProximitySelect(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const positionId = parseInt(data.replace('proximity_select_', ''));

    if (!Number.isFinite(positionId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid position' });
        return;
    }

    await bot.answerCallbackQuery(callbackQuery.id);

    try {
        await sendPickerForPosition(bot, chatId, { id: positionId });
    } catch (err) {
        console.error('handleProximitySelect error:', err);
    }
}

export async function handleProximitySetThreshold(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const m = data.match(/^proximity_threshold_(\d+)_(\d+)$/);
    if (!m) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid selection' });
        return;
    }

    const positionId = parseInt(m[1]);
    const threshold = parseFloat(m[2]);

    await bot.answerCallbackQuery(callbackQuery.id, { text: `Saving ${threshold}%...` });

    try {
        const rows = await db.select()
            .from(positionsTable)
            .where(eq(positionsTable.id, positionId))
            .limit(1);
        const pos = rows[0];
        if (!pos || typeof pos.lower_price !== 'number' || typeof pos.upper_price !== 'number' || !isFinite(pos.lower_price) || !isFinite(pos.upper_price) || pos.upper_price <= pos.lower_price) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid position range', show_alert: true });
            return;
        }

        const width = pos.upper_price - pos.lower_price;
        const distance = width * (threshold / 100);
        const lowerAlert = pos.lower_price + distance;
        const upperAlert = pos.upper_price - distance;

        await setProximityEnabled(positionId, true);
        await upsertProximityAlert(positionId, threshold, lowerAlert, upperAlert);

        const text =
            '✅ *Proximity Alert Configured*\n\n' +
            `Range: ${format6(pos.lower_price)} - ${format6(pos.upper_price)}\n` +
            `Threshold: ${threshold}%\n` +
            `Triggers at: *${format6(lowerAlert)}* or *${format6(upperAlert)}*`;

        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('handleProximitySetThreshold error:', err);
        await bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Failed: ${err?.message || err}`, show_alert: true });
    }
}

// Helpers
async function sendPickerForPosition(bot, chatId, positionRow) {
    // Fetch full row if only id was provided
    let p = positionRow;
    if (!p || typeof p.lower_price !== 'number') {
        const rows = await db.select().from(positionsTable).where(eq(positionsTable.id, positionRow.id)).limit(1);
        p = rows[0];
    }
    if (!p) return;

    const cfg = await getProximityAlert(p.id);
    const selected = (v) => (cfg?.enabled ? (Number(cfg.threshold_percentage) === v ? '✅ ' : '') : '');

    const kb = {
        inline_keyboard: [
            [
                { text: `${selected(1)}1%`, callback_data: `proximity_threshold_${p.id}_1` },
                { text: `${selected(5)}5%`, callback_data: `proximity_threshold_${p.id}_5` },
                { text: `${selected(10)}10%`, callback_data: `proximity_threshold_${p.id}_10` }
            ],
            [
                { text: `${selected(20)}20%`, callback_data: `proximity_threshold_${p.id}_20` },
                { text: `${selected(30)}30%`, callback_data: `proximity_threshold_${p.id}_30` },
                { text: `${selected(50)}50%`, callback_data: `proximity_threshold_${p.id}_50` }
            ],
            [
                { text: cfg?.enabled ? '🔕 Off' : '🔔 On (choose %)', callback_data: cfg?.enabled ? `proximity_disable_${p.id}` : `noop` }
            ]
        ]
    };
    const label = getPoolLabel(p);
    await bot.sendMessage(chatId, `🎚️ *Proximity Alerts*\n\nConfigure for: *${label}*\nSelect threshold:`, {
        parse_mode: 'Markdown',
        reply_markup: kb
    });
}

function format6(n) {
    if (typeof n !== 'number' || !isFinite(n)) return String(n);
    const abs = Math.abs(n);
    const s = abs >= 1 ? n.toFixed(6) : n.toPrecision(6);
    return s.replace(/0+$/,'').replace(/\.$/,'');
}

function getPoolLabel(p) {
    const a = (s) => typeof s === 'string' && s.trim().length > 0;
    if (a(p.token0_symbol) && a(p.token1_symbol)) {
        return `${p.token0_symbol}/${p.token1_symbol}`;
    }
    // Derive symbols from mints if available
    if (a(p.token0_mint) && a(p.token1_mint)) {
        return `${getTokenSymbol(p.token0_mint)}/${getTokenSymbol(p.token1_mint)}`;
    }
    if (a(p.pool_address) && p.pool_address.length > 8) {
        return `${p.pool_address.slice(0, 4)}...${p.pool_address.slice(-4)}`;
    }
    if (a(p.nft_mint) && p.nft_mint.length > 8) {
        return `${p.nft_mint.slice(0, 4)}...${p.nft_mint.slice(-4)}`;
    }
    return `Position ${p.id}`;
}


