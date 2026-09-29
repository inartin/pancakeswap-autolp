import { db } from '../../db/index.js';
import { positions as positionsTable } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { ensureProximityRow } from '../../services/alert.service.js';
import { meteoraClaimButtons } from './presentation.js';

export async function appendMeteoraPositionButtons(keyboard, position, index, isOutOfRange) {
    const OUT_RANGE_ALERT_ON = '🔔 Out of Range Alerts';
    const OUT_RANGE_ALERT_OFF = '🔕 Out of Range Alerts';
    const meteoraUrl = position.poolUrl || `https://app.meteora.ag/dlmm/${position.poolId}`;
    const solscanUrl = `https://solscan.io/account/${position.mintAddress}`;

    keyboard.inline_keyboard.push(meteoraClaimButtons(position, index));
    // Row 1: External Links
    keyboard.inline_keyboard.push([
        {
            text: `🪐 View on Meteora #${index + 1}`,
            url: meteoraUrl
        },
        {
            text: `🔍 View on Solscan`,
            url: solscanUrl
        }
    ]);

    // Row 2: Alerts and Stats buttons (matching PancakeSwap positions)
    let posId = position.positionId;
    if (!posId) {
        try {
            const existing = await db.select({ id: positionsTable.id })
                .from(positionsTable)
                .where(eq(positionsTable.nft_mint, position.mintAddress))
                .limit(1);
            if (existing?.[0]?.id) {
                posId = existing[0].id;
                position.positionId = posId;
            }
        } catch (_) {}
    }

    let outRangeEnabled = true;
    if (posId) {
        try {
            const cfg = await ensureProximityRow(posId);
            outRangeEnabled = cfg?.out_of_range_enabled !== 0 && cfg?.out_of_range_enabled !== false;
        } catch (e) {
            console.warn('ensureProximityRow error for Meteora:', e?.message || e);
        }
    }
    const alertsLabel = outRangeEnabled ? OUT_RANGE_ALERT_ON : OUT_RANGE_ALERT_OFF;

    keyboard.inline_keyboard.push([
        {
            text: alertsLabel,
            callback_data: `toggle_alerts_${position.mintAddress}`
        },
        {
            text: `📊 Stats`,
            callback_data: `stats`
        }
    ]);

    // Row 3: Hide button if position is out of range
    if (isOutOfRange) {
        keyboard.inline_keyboard.push([
            {
                text: `👁️ Hide #${index + 1}`,
                callback_data: `toggle_hide_${position.mintAddress}`
            }
        ]);
    }

}
