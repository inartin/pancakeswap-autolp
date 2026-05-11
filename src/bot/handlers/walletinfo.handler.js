import { getActiveWallet, getUserWallets, switchActiveWallet, updateWalletLabel, toggleSplitStrategy, getWalletById, deleteWallet } from '../../services/wallet.service.js';
import { getSolanaBalance } from '../../utils/rpc.util.js';
import { isEvmWallet, getEvmBalance } from '../../utils/evm.util.js';
import { formatShortAddress } from '../../utils/format.util.js';
import { buildWalletKeyboard } from '../keyboard.util.js';

/**
 * State management for pending label edits
 * Key: telegramId, Value: { walletId, messageId }
 */
const pendingLabelEdits = new Map();

/**
 * Check if user has a pending label edit
 */
export function hasPendingLabelEdit(telegramId) {
    return pendingLabelEdits.has(telegramId);
}

/**
 * Set pending label edit for user
 */
export function setPendingLabelEdit(telegramId, walletId, messageId) {
    pendingLabelEdits.set(telegramId, { walletId, messageId });
}

/**
 * Clear pending label edit for user
 */
export function clearPendingLabelEdit(telegramId) {
    pendingLabelEdits.delete(telegramId);
}

/**
 * Get pending label edit data
 */
function getPendingLabelEdit(telegramId) {
    return pendingLabelEdits.get(telegramId);
}

/**
 * Handles the /wallet command
 * Shows active wallet information
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleWalletInfo(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        // Get active wallet
        const wallet = await getActiveWallet(telegramId);

        if (!wallet) {
            await bot.sendMessage(
                chatId,
                `❌ *No Wallet Configured*\n\nYou need to set up a wallet first.\n\n*Options:*\n• /newwallet - Generate new wallet\n• /importwallet - Import existing wallet\n\nNeed help? Type /help`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const shortAddress = formatShortAddress(wallet.wallet_address);
        const evm = isEvmWallet(wallet.wallet_address);

        if (evm) {
            // EVM wallet — show ETH balance only
            let ethBalance;
            try {
                ethBalance = await getEvmBalance(wallet.wallet_address);
                ethBalance = parseFloat(ethBalance).toFixed(6);
            } catch (err) {
                ethBalance = 'Error';
            }

            const walletMessage = `
🔷 *Your Active Wallet (EVM)*

*Label:* ${wallet.label}
*Short:* ${shortAddress}

*Balance:* ${ethBalance} ETH

🔷 _Read-only wallet — balance viewing only_

*Actions:*
• /balance - Refresh balance

*Created:* ${new Date(wallet.created_at).toLocaleDateString()}
            `.trim();

            const keyboard = {
                inline_keyboard: [
                    [{ text: '✏️ Edit Label', callback_data: `edit_wallet_label_${wallet.id}` }],
                    [{ text: '🗑 Delete Wallet', callback_data: `delete_wallet_${wallet.id}` }]
                ]
            };

            await bot.sendMessage(chatId, walletMessage, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
            // Solana wallet — existing flow
            const solBalance = await getSolanaBalance(wallet.wallet_address);
            const claimAddress = wallet.claim_address;
            const splitStrategy = wallet.split_strategy;

            let walletMessage = `
🔐 *Your Active Wallet*

*Label:* ${wallet.label}
*Short:* ${shortAddress}

*Balance:* ${solBalance} SOL
`;

            if (claimAddress) {
                walletMessage += `\n*Claim Address:* \`${formatShortAddress(claimAddress)}\`\n`;
            } else {
                walletMessage += `\n*Claim Address:* ❌ Disabled\n`;
            }

            walletMessage += `\n*Split Strategy:* ${splitStrategy ? '✅ Enabled' : '❌ Disabled'}\n\n`;

            walletMessage += `
*Actions:*
• /rewards - Check claimable rewards
• /positions - View all positions
• /balance - Refresh balance
• /exportkey - Export private key (secure)

*Created:* ${new Date(wallet.created_at).toLocaleDateString()}
            `.trim();

            const splitEmoji = splitStrategy ? '✅' : '❌';
            const keyboard = {
                inline_keyboard: [
                    [{ text: '✏️ Edit Label', callback_data: `edit_wallet_label_${wallet.id}` }],
                    [{ text: claimAddress ? '🎯 Change Claim Address' : '🎯 Set Claim Address', callback_data: 'set_claim_address' }],
                    [{ text: `${splitEmoji} Split Strategy`, callback_data: `toggle_split_${wallet.id}` }],
                    [{ text: '🗑 Delete Wallet', callback_data: `delete_wallet_${wallet.id}` }]
                ]
            };

            await bot.sendMessage(chatId, walletMessage, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }

        // Refresh persistent wallet keyboard silently (send then delete)
        const walletKeyboard = await buildWalletKeyboard(telegramId);
        if (walletKeyboard) {
            try {
                const kbMsg = await bot.sendMessage(chatId, '\u200B', { reply_markup: walletKeyboard });
                await bot.deleteMessage(chatId, kbMsg.message_id);
            } catch (_) {
                // ignore
            }
        }

    } catch (error) {
        console.error('Error in wallet info handler:', error);

        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to fetch wallet info: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Handles the /balance command
 * Shows wallet balance
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleBalance(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        // Get active wallet
        const wallet = await getActiveWallet(telegramId);

        if (!wallet) {
            await bot.sendMessage(
                chatId,
                `❌ *No Wallet Configured*\n\nYou need to set up a wallet first.\n\n*Options:*\n• /newwallet - Generate new wallet\n• /importwallet - Import existing wallet`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const evm = isEvmWallet(wallet.wallet_address);

        if (evm) {
            let ethBalance;
            try {
                ethBalance = await getEvmBalance(wallet.wallet_address);
                ethBalance = parseFloat(ethBalance).toFixed(6);
            } catch (err) {
                ethBalance = 'Error';
            }

            const balanceMessage = `
💰 *Wallet Balance (EVM)*

*Address:* \`${formatShortAddress(wallet.wallet_address)}\`

*Balance:* *${ethBalance} ETH*

🔷 _Read-only wallet_
            `.trim();

            await bot.sendMessage(chatId, balanceMessage, { parse_mode: 'Markdown' });
        } else {
            const solBalance = await getSolanaBalance(wallet.wallet_address);

            const balanceMessage = `
💰 *Wallet Balance*

*Address:* \`${formatShortAddress(wallet.wallet_address)}\`

*Balance:* *${solBalance} SOL*

*Need more SOL?*
Send SOL to: \`${wallet.wallet_address}\`

*Actions:*
• /rewards - Check rewards
• /wallet - View wallet details
            `.trim();

            await bot.sendMessage(chatId, balanceMessage, { parse_mode: 'Markdown' });
        }

    } catch (error) {
        console.error('Error in balance handler:', error);

        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to fetch balance: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Handles the /wallets command (plural)
 * Shows all wallets for the user with switching buttons
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleWalletsList(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        const wallets = await getUserWallets(telegramId);

        if (wallets.length === 0) {
            await bot.sendMessage(
                chatId,
                `❌ *No Wallets Found*\n\nYou don't have any wallets yet.\n\n*Get Started:*\n• /newwallet - Generate new wallet\n• /importwallet - Import existing wallet`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        let walletsMessage = `🔐 *Your Wallets (${wallets.length} total)*\n\n`;

        wallets.forEach((wallet, index) => {
            const shortAddress = formatShortAddress(wallet.wallet_address);
            const status = wallet.is_active ? '✅ Active' : '';

            walletsMessage += `*${index + 1}. ${wallet.label}* ${status}\n`;
            walletsMessage += `\`${shortAddress}\`\n`;
            walletsMessage += `Created: ${new Date(wallet.created_at).toLocaleDateString()}\n\n`;
        });

        walletsMessage += `*Switch Active Wallet:*\n`;
        walletsMessage += `Click a button below to switch wallets\n\n`;
        walletsMessage += `*Other Actions:*\n`;
        walletsMessage += `• /wallet - View active wallet details\n`;
        walletsMessage += `• /newwallet - Add another wallet`;

        // Create inline keyboard buttons for wallet switching
        const buttons = wallets.map((wallet) => {
            const buttonText = wallet.is_active
                ? `✅ ${wallet.label} (Active)`
                : `${wallet.label}`;

            return [{
                text: buttonText,
                callback_data: `switch_wallet_${wallet.id}`
            }];
        });

        await bot.sendMessage(chatId, walletsMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buttons
            }
        });

        // Refresh persistent wallet keyboard silently (send then delete)
        const walletKeyboard = await buildWalletKeyboard(telegramId);
        if (walletKeyboard) {
            try {
                const kbMsg = await bot.sendMessage(chatId, '\u200B', { reply_markup: walletKeyboard });
                await bot.deleteMessage(chatId, kbMsg.message_id);
            } catch (_) {
                // ignore
            }
        }

    } catch (error) {
        console.error('Error in wallets list handler:', error);

        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to fetch wallets: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Handles the Edit Label button callback
 * Initiates the label editing flow
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} callbackQuery - The callback query object
 */
export async function handleEditLabelCallback(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const telegramId = callbackQuery.from.id;
    const data = callbackQuery.data;

    // Extract wallet ID from callback data
    const walletId = parseInt(data.replace('edit_wallet_label_', ''));

    try {
        // Get the wallet to show current label
        const wallets = await getUserWallets(telegramId);
        const wallet = wallets.find(w => w.id === walletId);

        if (!wallet) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ Wallet not found',
                show_alert: true
            });
            return;
        }

        // Answer the callback
        await bot.answerCallbackQuery(callbackQuery.id);

        // Send prompt message
        const promptMessage = await bot.sendMessage(
            chatId,
            `✏️ *Edit Wallet Label*\n\n` +
            `*Current label:* ${wallet.label}\n\n` +
            `Please send the new label for your wallet.\n\n` +
            `*Requirements:*\n` +
            `• 1-50 characters\n` +
            `• Can use letters, numbers, spaces, and common symbols\n\n` +
            `Type /cancel to abort`,
            { parse_mode: 'Markdown' }
        );

        // Store pending label edit state
        setPendingLabelEdit(telegramId, walletId, promptMessage.message_id);

    } catch (error) {
        console.error('Error in edit label callback:', error);

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `❌ Error: ${error.message}`,
            show_alert: true
        });
    }
}

/**
 * Handles the new label message from user
 * Updates the wallet label in the database
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleLabelMessage(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const newLabel = msg.text.trim();

    try {
        // Get pending label edit data
        const pendingEdit = getPendingLabelEdit(telegramId);
        if (!pendingEdit) {
            return;
        }

        const { walletId } = pendingEdit;

        // Validate label
        if (!newLabel || newLabel.length === 0) {
            await bot.sendMessage(
                chatId,
                '❌ Label cannot be empty. Please try again or type /cancel',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (newLabel.length > 50) {
            await bot.sendMessage(
                chatId,
                '❌ Label is too long (max 50 characters). Please try again or type /cancel',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Update the label
        const updatedWallet = await updateWalletLabel(walletId, newLabel);

        // Clear pending state
        clearPendingLabelEdit(telegramId);

        // Send confirmation
        const shortAddress = formatShortAddress(updatedWallet.wallet_address);

        await bot.sendMessage(
            chatId,
            `✅ *Wallet Label Updated!*\n\n` +
            `*New label:* ${updatedWallet.label}\n` +
            `*Wallet:* \`${shortAddress}\`\n\n` +
            `Use /wallet to view updated wallet details`,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error('Error in label message handler:', error);

        // Clear pending state
        clearPendingLabelEdit(telegramId);

        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to update label: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Handles the Toggle Split Strategy button callback
 * Toggles split_strategy and updates the message with new emoji
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} callbackQuery - The callback query object
 */
export async function handleToggleSplitCallback(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const telegramId = callbackQuery.from.id;
    const data = callbackQuery.data;

    // Extract wallet ID from callback data
    const walletId = parseInt(data.replace('toggle_split_', ''));

    try {
        // Toggle the split strategy
        const updatedWallet = await toggleSplitStrategy(walletId);

        // Answer the callback query with feedback
        const newStatus = updatedWallet.split_strategy ? 'Enabled' : 'Disabled';
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `✅ Split Strategy ${newStatus}`
        });

        // Get updated balance
        const solBalance = await getSolanaBalance(updatedWallet.wallet_address);
        const claimAddress = updatedWallet.claim_address;
        const splitStrategy = updatedWallet.split_strategy;
        const shortAddress = formatShortAddress(updatedWallet.wallet_address);

        // Rebuild the message with updated split strategy status
        let walletMessage = `
🔐 *Your Active Wallet*

*Label:* ${updatedWallet.label}
*Short:* ${shortAddress}

*Balance:* ${solBalance} SOL
`;

        // Add claim address if set
        if (claimAddress) {
            walletMessage += `\n*Claim Address:* \`${formatShortAddress(claimAddress)}\`\n`;
        }else{
            walletMessage += `\n*Claim Address:* ❌ Disabled\n`;
        }

        // Add split strategy status
        walletMessage += `\n*Split Strategy:* ${splitStrategy ? '✅ Enabled' : '❌ Disabled'}\n\n`;

        walletMessage += `
\n*Actions:*
• /rewards - Check claimable rewards
• /positions - View all positions
• /balance - Refresh balance
• /exportkey - Export private key (secure)

*Created:* ${new Date(updatedWallet.created_at).toLocaleDateString()}
        `.trim();

        // Update keyboard with new emoji
        const splitEmoji = splitStrategy ? '✅' : '❌';
        const keyboard = {
            inline_keyboard: [
                [{ text: '✏️ Edit Label', callback_data: `edit_wallet_label_${updatedWallet.id}` }],
                [{ text: claimAddress ? '🎯 Change Claim Address' : '🎯 Set Claim Address', callback_data: 'set_claim_address' }],
                [{ text: `${splitEmoji} Split Strategy`, callback_data: `toggle_split_${updatedWallet.id}` }],
                [{ text: '🗑 Delete Wallet', callback_data: `delete_wallet_${updatedWallet.id}` }]
            ]
        };

        await bot.editMessageText(walletMessage, {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

    } catch (error) {
        console.error('Error in toggle split callback:', error);

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `❌ Error: ${error.message}`,
            show_alert: true
        });
    }
}

/**
 * Handles the Delete Wallet button callback
 * Prompts user to confirm deletion
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} callbackQuery - The callback query object
 */
export async function handleDeleteWalletPrompt(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const telegramId = callbackQuery.from.id;
    const data = callbackQuery.data;

    const walletId = parseInt(data.replace('delete_wallet_', ''));

    try {
        const wallet = await getWalletById(walletId);

        if (!wallet || wallet.user_telegram_id !== telegramId) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ Wallet not found',
                show_alert: true
            });
            return;
        }

        await bot.answerCallbackQuery(callbackQuery.id);

        const shortAddress = formatShortAddress(wallet.wallet_address);
        const userWallets = await getUserWallets(telegramId);
        const totalWallets = userWallets.length;
        const isActive = wallet.is_active;

        let warningMessage = `
⚠️ *Delete Wallet*

*Wallet:* ${wallet.label}
*Address:* \`${shortAddress}\`

This will permanently remove:
• The wallet profile
• All tracked positions
• Related alerts and history
`.trim();

        if (isActive) {
            warningMessage += `\n\n*Note:* This is your active wallet. Another wallet will be activated automatically if available.`;
        }

        if (totalWallets <= 1) {
            warningMessage += `\n\n❗ You will have *no wallets* configured after this action.`;
        }

        warningMessage += `\n\nType /cancel anytime to stop.`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '❌ Cancel', callback_data: 'cancel_delete_wallet' }
                ],
                [
                    { text: '🗑 Delete Wallet', callback_data: `confirm_delete_wallet_${walletId}` }
                ]
            ]
        };

        await bot.sendMessage(chatId, warningMessage, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

    } catch (error) {
        console.error('Error in delete wallet prompt:', error);

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `❌ Error: ${error.message}`,
            show_alert: true
        });
    }
}

/**
 * Handles cancel delete wallet callback
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} callbackQuery - The callback query object
 */
export async function handleCancelDeleteWallet(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;

    try {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Cancelled' });
        await bot.deleteMessage(chatId, callbackQuery.message.message_id);
    } catch (error) {
        // If delete fails, fall back to editing message
        try {
            await bot.editMessageText('❌ Wallet deletion cancelled.', {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id,
                parse_mode: 'Markdown'
            });
        } catch (_) {
            // ignore
        }
    }
}

/**
 * Handles confirm delete wallet callback
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} callbackQuery - The callback query object
 */
export async function handleConfirmDeleteWallet(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const telegramId = callbackQuery.from.id;
    const data = callbackQuery.data;

    const walletId = parseInt(data.replace('confirm_delete_wallet_', ''));

    try {
        const wallet = await getWalletById(walletId);

        if (!wallet || wallet.user_telegram_id !== telegramId) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ Wallet not found',
                show_alert: true
            });
            return;
        }

        await bot.answerCallbackQuery(callbackQuery.id, { text: '🗑 Deleting...' });

        await deleteWallet(walletId, telegramId);

        const shortAddress = formatShortAddress(wallet.wallet_address);
        const remainingWallets = await getUserWallets(telegramId);
        const newActive = remainingWallets.find(w => w.is_active);

        let resultMessage = `
✅ *Wallet Deleted*

*Removed:* ${wallet.label}
*Address:* \`${shortAddress}\`
`.trim();

        if (remainingWallets.length === 0) {
            resultMessage += `\n\nYou have no wallets configured. Use /newwallet or /importwallet to add one.`;
        } else if (newActive) {
            const newShort = formatShortAddress(newActive.wallet_address);
            resultMessage += `\n\nNow using *${newActive.label}* (\`${newShort}\`).\nRun /wallet to view details.`;
        }

        await bot.editMessageText(resultMessage, {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id,
            parse_mode: 'Markdown'
        });

        // Refresh wallet keyboard so UI matches new state
        const walletKeyboard = await buildWalletKeyboard(telegramId);
        if (walletKeyboard) {
            try {
                const kbMsg = await bot.sendMessage(chatId, '\u200B', { reply_markup: walletKeyboard });
                await bot.deleteMessage(chatId, kbMsg.message_id);
            } catch (_) {
                // ignore
            }
        }

    } catch (error) {
        console.error('Error deleting wallet:', error);

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `❌ Error: ${error.message}`,
            show_alert: true
        });

        try {
            await bot.editMessageText(
                `❌ Failed to delete wallet: ${error.message}`,
                {
                    chat_id: chatId,
                    message_id: callbackQuery.message.message_id,
                    parse_mode: 'Markdown'
                }
            );
        } catch (_) {
            // ignore
        }
    }
}
