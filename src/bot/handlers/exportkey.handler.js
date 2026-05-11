import { getActiveWallet, getWalletPrivateKey } from '../../services/wallet.service.js';
import { logPrivateKeyExport } from '../../services/audit.service.js';

/**
 * Handles the /exportkey command
 * Exports private key with security warnings and auto-delete
 * Follows the message framework security pattern
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleExportKey(bot, msg) {
    console.log('🔑 /exportkey command received from user:', msg.from.id);

    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        // Get active wallet
        const activeWallet = await getActiveWallet(telegramId);
        console.log('👛 Active wallet found:', activeWallet ? activeWallet.id : 'none');

        if (!activeWallet) {
            await bot.sendMessage(
                chatId,
                '❌ *No Active Wallet*\n\nYou need to create or import a wallet first.\n\n• `/newwallet` - Generate new wallet\n• `/importwallet` - Import existing wallet',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Step 1: Show Security Warning
        const warningMessage = `
⚠️ *Private Key Export Warning*

You're about to view your wallet's private key.

*🚨 CRITICAL SECURITY INFORMATION:*

*Dangers:*
• Anyone with your private key has FULL access to your funds
• Sharing or exposing it can result in PERMANENT loss of ALL assets
• Screenshots, photos, or sharing = HIGH RISK

*Secure Storage:*
✅ Write it down on paper and store in a safe place
✅ Use a hardware wallet or password manager
✅ Keep multiple secure backups
❌ Never share via message, email, or screenshot
❌ Never store in plain text on your computer
❌ Never enter it on untrusted websites

*This message will auto-delete in 30 seconds after showing the key.*

*Do you understand and accept the risks?*
        `.trim();

        const sentMessage = await bot.sendMessage(chatId, warningMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '⚠️ I Understand - Show Key', callback_data: `exportkey_confirm_${activeWallet.id}` },
                        { text: '❌ Cancel', callback_data: 'exportkey_cancel' }
                    ]
                ]
            }
        });
        console.log('✅ Warning message sent with buttons. Message ID:', sentMessage.message_id);
        console.log('🔘 Button callbacks:', `exportkey_confirm_${activeWallet.id}`, 'exportkey_cancel');

    } catch (error) {
        console.error('Error in exportkey handler:', error);
        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to export key: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Handle button callback for key export confirmation
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} callbackQuery - The callback query object
 */
export async function handleExportKeyCallback(bot, callbackQuery) {
    console.log('🔑 exportkey callback handler called with data:', callbackQuery.data);

    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    try {
        if (data === 'exportkey_cancel') {
            console.log('🚫 User cancelled export');

            // Answer callback first
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '✅ Export cancelled',
                show_alert: false
            });

            // Try to delete warning message (might already be deleted)
            try {
                await bot.deleteMessage(chatId, messageId);
            } catch (error) {
                console.log('⚠️  Message already deleted or not found');
            }

            await bot.sendMessage(
                chatId,
                '👍 *Good call!* Your private key remains secure.\n\nYou can export it anytime with /exportkey',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (data.startsWith('exportkey_confirm_')) {
            const walletId = parseInt(data.replace('exportkey_confirm_', ''));
            console.log('✅ User confirmed export for wallet ID:', walletId);

            // Answer callback first
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '🔓 Decrypting key...',
                show_alert: false
            });

            // Try to delete the warning message (might already be deleted if they clicked cancel first)
            try {
                await bot.deleteMessage(chatId, messageId);
            } catch (error) {
                console.log('⚠️  Warning message already deleted or not found');
            }

            // Get decrypted private key
            const privateKey = await getWalletPrivateKey(walletId);

            // 🔒 SECURITY AUDIT: Log private key export
            const telegramId = callbackQuery.from.id;
            const telegramUsername = callbackQuery.from.username || 'unknown';

            await logPrivateKeyExport(telegramId, walletId, {
                telegram_username: telegramUsername,
                telegram_first_name: callbackQuery.from.first_name,
                chat_id: chatId
            });

            console.log(`🔐 AUDIT: Private key exported for wallet ${walletId} by user ${telegramId} (@${telegramUsername})`);

            // Step 2: Show Private Key with spoiler (HTML parse mode)
            const keyMessage = `
🔐 <b>Your Private Key</b>

<span class="tg-spoiler"><code>${privateKey}</code></span>

<b>⏱️ This message will auto-delete in 30 seconds</b>

<b>CRITICAL REMINDERS:</b>
• Copy this key NOW and store it securely
• Never share this with ANYONE
• This is your ONLY way to recover your wallet
• Bot support will NEVER ask for your private key

<b>Secure Storage Checklist:</b>
□ Written down on paper
□ Stored in a safe/secure location
□ Never photographed or screenshotted
□ Not stored digitally in plain text

Once you've secured your key, click Done below.
            `.trim();

            const keyMessageSent = await bot.sendMessage(chatId, keyMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Done - Delete This Message', callback_data: 'exportkey_done' }
                    ]]
                }
            });

            // Set up simple auto-delete timer (30 seconds)
            const AUTO_DELETE_MS = 30000;

            // Store timeout for manual deletion
            bot._exportKeyTimers = bot._exportKeyTimers || {};
            bot._exportKeyTimers[keyMessageSent.message_id] = setTimeout(async () => {
                try {
                    await bot.deleteMessage(chatId, keyMessageSent.message_id);
                    await sendDeletionConfirmation(bot, chatId);
                } catch (error) {
                    console.error('Error auto-deleting key message:', error);
                }
                delete bot._exportKeyTimers[keyMessageSent.message_id];
            }, AUTO_DELETE_MS);

            return;
        }

        if (data === 'exportkey_done') {
            // Get the message_id from the callback query itself
            const keyMessageId = messageId;
            console.log('✅ User clicked Done button for message:', keyMessageId);

            // Answer callback
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '✅ Private key secured',
                show_alert: false
            });

            // Stop the auto-delete timer if running
            if (bot._exportKeyTimers?.[keyMessageId]) {
                clearTimeout(bot._exportKeyTimers[keyMessageId]);
                delete bot._exportKeyTimers[keyMessageId];
            }

            // Delete the key message
            try {
                await bot.deleteMessage(chatId, keyMessageId);
            } catch (error) {
                console.error('Error deleting message:', error);
            }

            // Step 3: Show Confirmation
            await sendDeletionConfirmation(bot, chatId);
        }

    } catch (error) {
        console.error('❌ Error in exportkey callback:', error);
        console.error('Stack trace:', error.stack);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `Error: ${error.message}`,
            show_alert: true
        });
    }
}

/**
 * Send confirmation message after key deletion
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {number} chatId - Chat ID
 */
async function sendDeletionConfirmation(bot, chatId) {
    const confirmMessage = `
✅ *Private Key Secured*

Your private key has been removed from the chat.

*Next Steps:*
• Verify you've saved it securely
• Test your backup by importing to another wallet
• View wallet details and fund: /wallet

*Remember:* Keep your private key safe and NEVER share it!
    `.trim();

    await bot.sendMessage(chatId, confirmMessage, { parse_mode: 'Markdown' });
}
