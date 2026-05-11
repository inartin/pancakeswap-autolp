import { getUserAuditLogs, getUserAuditStats, getWalletAuditLogs, getPrivateKeyExportCount } from '../../services/audit.service.js';
import { getActiveWallet, getUserWallets } from '../../services/wallet.service.js';

/**
 * Handles the /auditlog command
 * Shows security audit logs for the user
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleAuditLog(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        // Get user stats
        const stats = await getUserAuditStats(telegramId);

        // Get recent logs (last 20)
        const logs = await getUserAuditLogs(telegramId, 20);

        if (logs.length === 0) {
            await bot.sendMessage(
                chatId,
                '📋 *Security Audit Log*\n\nNo security events recorded yet.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Format message
        let message = `🔐 *Security Audit Log*\n\n`;
        message += `*Summary:*\n`;
        message += `• Total Events: ${stats.total_actions}\n`;
        message += `• Private Key Exports: ${stats.private_key_exports}\n`;
        message += `• Wallets Created: ${stats.wallets_created}\n`;
        message += `• Wallets Imported: ${stats.wallets_imported}\n\n`;

        message += `*Recent Events (Last 20):*\n\n`;

        logs.forEach((log, index) => {
            const date = new Date(log.created_at);
            const dateStr = date.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            const actionEmoji = getActionEmoji(log.action_type);
            const actionLabel = formatActionType(log.action_type);

            message += `${actionEmoji} *${actionLabel}*\n`;
            message += `   📅 ${dateStr}\n`;
            message += `   🆔 Wallet ID: ${log.wallet_id}\n`;

            if (log.metadata?.telegram_username) {
                message += `   👤 @${log.metadata.telegram_username}\n`;
            }

            message += `\n`;
        });

        message += `\n💡 *Tip: Use /auditlog <wallet_id> to see logs for a specific wallet*`;

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Error in auditlog handler:', error);

        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to fetch audit logs: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Handles the /walletaudit command
 * Shows audit logs for a specific wallet
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleWalletAudit(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        // Get active wallet
        const activeWallet = await getActiveWallet(telegramId);

        if (!activeWallet) {
            await bot.sendMessage(
                chatId,
                '❌ *No Active Wallet*\n\nYou need to create or import a wallet first.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Get logs for this wallet
        const logs = await getWalletAuditLogs(activeWallet.id);
        const exportCount = await getPrivateKeyExportCount(activeWallet.id);

        if (logs.length === 0) {
            await bot.sendMessage(
                chatId,
                `🔐 *Wallet Security Audit*\n\n*Wallet:* \`${activeWallet.wallet_address}\`\n\nNo security events recorded for this wallet.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Format message
        let message = `🔐 *Wallet Security Audit*\n\n`;
        message += `*Wallet:* \`${activeWallet.wallet_address.substring(0, 8)}...${activeWallet.wallet_address.substring(activeWallet.wallet_address.length - 6)}\`\n`;
        message += `*Label:* ${activeWallet.label}\n\n`;

        message += `*Security Summary:*\n`;
        message += `• Private Key Exports: ${exportCount} time(s)\n`;
        message += `• Total Events: ${logs.length}\n\n`;

        message += `*Event History:*\n\n`;

        logs.forEach((log, index) => {
            const date = new Date(log.created_at);
            const dateStr = date.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            const actionEmoji = getActionEmoji(log.action_type);
            const actionLabel = formatActionType(log.action_type);

            message += `${index + 1}. ${actionEmoji} *${actionLabel}*\n`;
            message += `   📅 ${dateStr}\n\n`;
        });

        if (exportCount > 3) {
            message += `\n⚠️ *Security Notice:* This wallet's private key has been exported ${exportCount} times. Ensure all exports were authorized by you.`;
        }

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Error in walletaudit handler:', error);

        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to fetch wallet audit logs: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Get emoji for action type
 *
 * @param {string} actionType - Action type
 * @returns {string} Emoji
 */
function getActionEmoji(actionType) {
    const emojiMap = {
        'private_key_export': '🔑',
        'wallet_created': '➕',
        'wallet_imported': '📥',
        'wallet_deleted': '🗑️'
    };

    return emojiMap[actionType] || '📝';
}

/**
 * Format action type for display
 *
 * @param {string} actionType - Action type
 * @returns {string} Formatted action
 */
function formatActionType(actionType) {
    const labelMap = {
        'private_key_export': 'Private Key Exported',
        'wallet_created': 'Wallet Created',
        'wallet_imported': 'Wallet Imported',
        'wallet_deleted': 'Wallet Deleted'
    };

    return labelMap[actionType] || actionType;
}
