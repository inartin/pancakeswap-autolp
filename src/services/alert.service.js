import { db } from '../db/index.js';
import { proximity_alerts, alert_history, positions } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

/**
 * Alert Service
 * Handles proximity alerts and alert history
 *
 * STATUS: ⏳ READY FOR PHASE 3 - Database schema created, service functions ready
 *
 * PHASE: Phase 3 - Automation (Planned)
 *
 * CURRENT USE:
 * - NOT YET INTEGRATED
 * - No position monitoring system
 * - No price alerts configured
 * - No background jobs running
 * - Database tables exist but remain empty
 *
 * HANDLERS USING THIS:
 * - None
 *
 * TODO (Phase 3):
 * - Create /proximity or /alerts command to configure alerts
 * - Add background monitoring service to check prices
 * - Send Telegram notifications when alerts trigger
 * - Implement snooze/dismiss functionality
 * - Track user actions (rebalanced, ignored, snoozed)
 * - Add alert cooldown to prevent spam
 *
 * INTEGRATION POINTS:
 * - Create alerts.handler.js - Configure proximity alerts
 * - Add src/jobs/alert-monitor.js - Background price monitoring
 * - Integrate with position.service.js - Need tracked positions first
 * - Add src/utils/price-check.util.js - Fetch current prices
 * - Add Telegram notification sending on alert trigger
 *
 * WORKFLOW:
 * 1. User sets proximity alert: /proximity 10 (10% from range edges)
 * 2. Background job checks position prices every X minutes
 * 3. If price within threshold, send Telegram alert
 * 4. Log alert in alert_history
 * 5. User responds: rebalance/snooze/ignore
 * 6. Update alert_history with user action
 */

/**
 * Create or update proximity alert for position
 *
 * @param {number} positionId - Position ID
 * @param {number} thresholdPercentage - Alert threshold (e.g., 10 for 10%)
 * @param {number} lowerAlertPrice - Calculated lower alert price
 * @param {number} upperAlertPrice - Calculated upper alert price
 * @returns {Promise<Object>} Created/updated alert
 */
export async function upsertProximityAlert(positionId, thresholdPercentage, lowerAlertPrice, upperAlertPrice) {
    // Check if alert exists
    const existing = await db.select()
        .from(proximity_alerts)
        .where(eq(proximity_alerts.position_id, positionId))
        .limit(1);

    if (existing.length > 0) {
        // Update existing
        const result = await db.update(proximity_alerts)
            .set({
                threshold_percentage: thresholdPercentage,
                lower_alert_price: lowerAlertPrice,
                upper_alert_price: upperAlertPrice,
                enabled: true,
                updated_at: new Date()
            })
            .where(eq(proximity_alerts.position_id, positionId))
            .returning();
        return result[0];
    } else {
        // Create new
        const result = await db.insert(proximity_alerts)
            .values({
                position_id: positionId,
                threshold_percentage: thresholdPercentage,
                lower_alert_price: lowerAlertPrice,
                upper_alert_price: upperAlertPrice,
                enabled: true
            })
            .returning();
        return result[0];
    }
}

/**
 * Get proximity alert for position
 *
 * @param {number} positionId - Position ID
 * @returns {Promise<Object|null>} Alert or null
 */
export async function getProximityAlert(positionId) {
    const result = await db.select()
        .from(proximity_alerts)
        .where(eq(proximity_alerts.position_id, positionId))
        .limit(1);

    return result[0] || null;
}

/**
 * Explicitly set proximity enabled flag (creates row if missing)
 * @param {number} positionId
 * @param {boolean} enabled
 * @returns {Promise<boolean>} New enabled state
 */
export async function setProximityEnabled(positionId, enabled) {
    await ensureProximityRow(positionId);
    const result = await db.update(proximity_alerts)
        .set({ enabled: !!enabled, updated_at: new Date() })
        .where(eq(proximity_alerts.position_id, positionId))
        .returning();
    return !!result[0].enabled;
}

/**
 * Log alert trigger in history
 *
 * @param {number} positionId - Position ID
 * @param {string} alertType - Alert type
 * @param {number} priceAtAlert - Price when alert triggered
 * @param {boolean|number} messageSentOrThreshold - For backward compatibility: boolean (messageSent) or number (proximityThreshold)
 * @param {boolean} messageSent - Whether message was sent (when proximityThreshold is provided)
 * @returns {Promise<Object>} Created history entry
 */
export async function logAlertTrigger(positionId, alertType, priceAtAlert, messageSentOrThreshold = true, messageSent = true) {
    // Handle backward compatibility: if 4th param is boolean, it's the old messageSent param
    const proximityThreshold = typeof messageSentOrThreshold === 'number' ? messageSentOrThreshold : null;
    const actualMessageSent = typeof messageSentOrThreshold === 'boolean' ? messageSentOrThreshold : messageSent;

    const result = await db.insert(alert_history)
        .values({
            position_id: positionId,
            alert_type: alertType,
            price_at_alert: priceAtAlert,
            proximity_threshold_percent: proximityThreshold,
            message_sent: !!actualMessageSent
        })
        .returning();

    // Update last_triggered_at in proximity_alerts
    if (alertType === 'proximity') {
        await db.update(proximity_alerts)
            .set({ last_triggered_at: new Date() })
            .where(eq(proximity_alerts.position_id, positionId));
    }

    return result[0];
}

/**
 * Update user action for alert
 *
 * @param {number} historyId - Alert history ID
 * @param {string} action - User action (rebalanced, snoozed, ignored)
 * @returns {Promise<Object>} Updated history entry
 */
export async function updateAlertAction(historyId, action) {
    const result = await db.update(alert_history)
        .set({ user_action: action })
        .where(eq(alert_history.id, historyId))
        .returning();

    return result[0];
}

/**
 * Get out_of_range config row for a position
 * @param {number} positionId
 * @returns {Promise<Object|null>}
 */
export async function getOutOfRangeConfig(positionId) {
    const result = await db.select()
        .from(proximity_alerts)
        .where(eq(proximity_alerts.position_id, positionId))
        .limit(1);
    return result[0] || null;
}

/**
 * Ensure a proximity_alerts row exists for a position using positions table bounds
 * Uses defaults: threshold=10, lower/upper from positions table
 * @param {number} positionId
 * @returns {Promise<Object>} proximity_alerts row
 */
export async function ensureProximityRow(positionId) {
    // Check existing
    const existing = await getOutOfRangeConfig(positionId);
    if (existing) return existing;

    // Fetch bounds from positions table
    const posRows = await db.select()
        .from(positions)
        .where(eq(positions.id, positionId))
        .limit(1);
    const pos = posRows[0];
    const lower = typeof pos?.lower_price === 'number' ? pos.lower_price : 0;
    const upper = typeof pos?.upper_price === 'number' ? pos.upper_price : 0;

    // Calculate correct 10% alert prices (inward from boundaries)
    const width = upper - lower;
    const distance = width * 0.10; // 10% default threshold
    const lowerAlert = lower + distance;
    const upperAlert = upper - distance;

    const result = await db.insert(proximity_alerts)
        .values({
            position_id: positionId,
            threshold_percentage: 10,
            lower_alert_price: lowerAlert,
            upper_alert_price: upperAlert,
            enabled: false,
            out_of_range_enabled: true,
            out_of_range_cooldown_minutes: 1,
            proximity_cooldown_minutes: 2
        })
        .returning();
    return result[0];
}

/**
 * One-time helper to reduce existing rows' out_of_range_cooldown_minutes to 1 minute.
 * Safe to call multiple times; only affects rows with null or >1 minute.
 */
export async function migrateOutOfRangeCooldownToOneMinute() {
    try {
        await db.run(sql`UPDATE proximity_alerts SET out_of_range_cooldown_minutes = 1 WHERE out_of_range_cooldown_minutes IS NULL OR out_of_range_cooldown_minutes > 1`);
    } catch (_) {
        // ignore migration errors; non-critical at runtime
    }
}

/**
 * Toggle out_of_range_enabled for a position (creates row if missing)
 * @param {number} positionId
 * @returns {Promise<boolean>} New enabled state
 */
export async function toggleOutOfRangeEnabled(positionId) {
    const row = await ensureProximityRow(positionId);
    const newEnabled = !row.out_of_range_enabled;
    const result = await db.update(proximity_alerts)
        .set({ out_of_range_enabled: newEnabled, updated_at: new Date() })
        .where(eq(proximity_alerts.position_id, positionId))
        .returning();
    return !!result[0].out_of_range_enabled;
}

/**
 * Toggle proximity enabled for a position (creates row if missing)
 * When enabling, recalculates alert prices based on current threshold to ensure correctness
 * @param {number} positionId
 * @returns {Promise<boolean>} New enabled state
 */
export async function toggleProximityEnabled(positionId) {
    const row = await ensureProximityRow(positionId);
    const newEnabled = !row.enabled;

    // Build update data
    let updateData = { enabled: newEnabled, updated_at: new Date() };

    // If enabling, recalculate alert prices based on current threshold
    if (newEnabled) {
        // Fetch position bounds
        const posRows = await db.select()
            .from(positions)
            .where(eq(positions.id, positionId))
            .limit(1);
        const pos = posRows[0];

        if (pos && typeof pos.lower_price === 'number' && typeof pos.upper_price === 'number') {
            const width = pos.upper_price - pos.lower_price;
            const threshold = row.threshold_percentage || 10;
            const distance = width * (threshold / 100);
            const lowerAlert = pos.lower_price + distance;
            const upperAlert = pos.upper_price - distance;

            updateData.lower_alert_price = lowerAlert;
            updateData.upper_alert_price = upperAlert;
        }
    }

    const result = await db.update(proximity_alerts)
        .set(updateData)
        .where(eq(proximity_alerts.position_id, positionId))
        .returning();
    return !!result[0].enabled;
}
