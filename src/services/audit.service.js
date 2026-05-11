import { db } from '../db/index.js';
import { security_audit_log } from '../db/schema.js';
import { desc, eq, and } from 'drizzle-orm';

/**
 * Audit Service
 * Handles security audit logging for sensitive operations
 *
 * STATUS: ✅ ACTIVE (Phase 2)
 *
 * PHASE: Phase 2 - Core Functionality
 *
 * CURRENT USE:
 * - Logs private key exports with timestamp and user info
 * - Provides audit trail for security-critical actions
 * - Extensible for future security events
 *
 * HANDLERS USING THIS:
 * - exportkey.handler.js - Logs every private key export
 * - auditlog.handler.js - Views security audit logs
 *
 * Action Types:
 * - private_key_export: User exported wallet private key ✅ IMPLEMENTED
 * - wallet_created: New wallet created (future)
 * - wallet_imported: Wallet imported from private key (future)
 * - wallet_deleted: Wallet permanently deleted (future)
 */

/**
 * Security action types enum
 */
export const AUDIT_ACTIONS = {
    PRIVATE_KEY_EXPORT: 'private_key_export',
    WALLET_CREATED: 'wallet_created',
    WALLET_IMPORTED: 'wallet_imported',
    WALLET_DELETED: 'wallet_deleted'
};

/**
 * Log a security-sensitive action
 *
 * @param {number} telegramId - User's Telegram ID
 * @param {number} walletId - Wallet ID
 * @param {string} actionType - Type of action (use AUDIT_ACTIONS enum)
 * @param {Object} metadata - Optional additional context (will be stored as JSON)
 * @returns {Promise<Object>} Created audit log entry
 */
export async function logSecurityAction(telegramId, walletId, actionType, metadata = null) {
    const result = await db.insert(security_audit_log)
        .values({
            user_telegram_id: telegramId,
            wallet_id: walletId,
            action_type: actionType,
            metadata: metadata ? JSON.stringify(metadata) : null
        })
        .returning();

    return result[0];
}

/**
 * Log private key export event
 * Convenience function for the most common audit action
 *
 * @param {number} telegramId - User's Telegram ID
 * @param {number} walletId - Wallet ID that was exported
 * @param {Object} additionalContext - Optional context (e.g., telegram username)
 * @returns {Promise<Object>} Created audit log entry
 */
export async function logPrivateKeyExport(telegramId, walletId, additionalContext = {}) {
    return logSecurityAction(
        telegramId,
        walletId,
        AUDIT_ACTIONS.PRIVATE_KEY_EXPORT,
        additionalContext
    );
}

/**
 * Get all security audit logs for a user
 *
 * @param {number} telegramId - User's Telegram ID
 * @param {number} limit - Maximum number of records to return (default: 100)
 * @returns {Promise<Array>} Array of audit log entries
 */
export async function getUserAuditLogs(telegramId, limit = 100) {
    const logs = await db.select()
        .from(security_audit_log)
        .where(eq(security_audit_log.user_telegram_id, telegramId))
        .orderBy(desc(security_audit_log.created_at))
        .limit(limit);

    // Parse metadata JSON for each log
    return logs.map(log => ({
        ...log,
        metadata: log.metadata ? JSON.parse(log.metadata) : null
    }));
}

/**
 * Get audit logs for a specific wallet
 *
 * @param {number} walletId - Wallet ID
 * @param {number} limit - Maximum number of records to return (default: 50)
 * @returns {Promise<Array>} Array of audit log entries
 */
export async function getWalletAuditLogs(walletId, limit = 50) {
    const logs = await db.select()
        .from(security_audit_log)
        .where(eq(security_audit_log.wallet_id, walletId))
        .orderBy(desc(security_audit_log.created_at))
        .limit(limit);

    // Parse metadata JSON for each log
    return logs.map(log => ({
        ...log,
        metadata: log.metadata ? JSON.parse(log.metadata) : null
    }));
}

/**
 * Get private key export count for a wallet
 * Useful for security monitoring
 *
 * @param {number} walletId - Wallet ID
 * @returns {Promise<number>} Number of times private key was exported
 */
export async function getPrivateKeyExportCount(walletId) {
    const logs = await db.select()
        .from(security_audit_log)
        .where(and(
            eq(security_audit_log.wallet_id, walletId),
            eq(security_audit_log.action_type, AUDIT_ACTIONS.PRIVATE_KEY_EXPORT)
        ));

    return logs.length;
}

/**
 * Get recent private key exports across all users
 * Admin function for security monitoring
 *
 * @param {number} hours - Look back X hours (default: 24)
 * @param {number} limit - Maximum records (default: 100)
 * @returns {Promise<Array>} Array of recent export logs
 */
export async function getRecentPrivateKeyExports(hours = 24, limit = 100) {
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    const logs = await db.select()
        .from(security_audit_log)
        .where(eq(security_audit_log.action_type, AUDIT_ACTIONS.PRIVATE_KEY_EXPORT))
        .orderBy(desc(security_audit_log.created_at))
        .limit(limit);

    // Filter by time and parse metadata
    return logs
        .filter(log => log.created_at >= cutoffTime)
        .map(log => ({
            ...log,
            metadata: log.metadata ? JSON.parse(log.metadata) : null
        }));
}

/**
 * Get audit log statistics for a user
 * Summary of security actions
 *
 * @param {number} telegramId - User's Telegram ID
 * @returns {Promise<Object>} Statistics object
 */
export async function getUserAuditStats(telegramId) {
    const logs = await db.select()
        .from(security_audit_log)
        .where(eq(security_audit_log.user_telegram_id, telegramId));

    const stats = {
        total_actions: logs.length,
        private_key_exports: 0,
        wallets_created: 0,
        wallets_imported: 0,
        wallets_deleted: 0,
        first_action: null,
        last_action: null
    };

    logs.forEach(log => {
        switch (log.action_type) {
            case AUDIT_ACTIONS.PRIVATE_KEY_EXPORT:
                stats.private_key_exports++;
                break;
            case AUDIT_ACTIONS.WALLET_CREATED:
                stats.wallets_created++;
                break;
            case AUDIT_ACTIONS.WALLET_IMPORTED:
                stats.wallets_imported++;
                break;
            case AUDIT_ACTIONS.WALLET_DELETED:
                stats.wallets_deleted++;
                break;
        }

        if (!stats.first_action || log.created_at < stats.first_action) {
            stats.first_action = log.created_at;
        }
        if (!stats.last_action || log.created_at > stats.last_action) {
            stats.last_action = log.created_at;
        }
    });

    return stats;
}
