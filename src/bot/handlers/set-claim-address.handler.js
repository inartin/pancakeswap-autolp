import { logSecurityAction } from '../../services/audit.service.js';
import { getActiveWallet, updateWalletClaimAddress, getWalletClaimAddress } from '../../services/wallet.service.js';

/**
 * State management for pending claim address edits
 * Key: telegramId, Value: { messageId }
 */
const pendingClaimAddressEdits = new Map();

/**
 * Check if user has a pending claim address edit
 */
export function hasPendingClaimAddress(telegramId) {
    return pendingClaimAddressEdits.has(telegramId);
}

/**
 * Set pending claim address edit for user
 */
export function setPendingClaimAddress(telegramId, messageId) {
    pendingClaimAddressEdits.set(telegramId, { messageId });
}

/**
 * Clear pending claim address edit for user
 */
export function clearPendingClaimAddress(telegramId) {
    pendingClaimAddressEdits.delete(telegramId);
}

/**
 * Get pending claim address edit data
 */
function getPendingClaimAddress(telegramId) {
    return pendingClaimAddressEdits.get(telegramId);
}

/**
 * Validate Solana address format
 * 
 * @param {string} address - Address to validate
 * @returns {boolean} True if valid Solana address
 */
function isValidSolanaAddress(address) {
    // Solana addresses are base58 encoded and typically 32-44 characters
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    return base58Regex.test(address);
}

/**
 * Handles the Set Claim Address button callback
 * Initiates the claim address editing flow
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} callbackQuery - The callback query object
 */
export async function handleSetClaimAddressCallback(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const telegramId = callbackQuery.from.id;

    try {
        // Get active wallet
        const wallet = await getActiveWallet(telegramId);
        if (!wallet) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ No active wallet found. Please create or import a wallet first.',
                show_alert: true
            });
            return;
        }

        // Get current claim address for this wallet
        const currentClaimAddress = await getWalletClaimAddress(wallet.id);

        // Answer the callback
        await bot.answerCallbackQuery(callbackQuery.id);

        // Send prompt message
        let promptText = `🎯 *Set Claim Address*\n\n`;
        promptText += `*Wallet:* \`${wallet.label}\`\n`;
        promptText += `\`${wallet.wallet_address.slice(0, 8)}...${wallet.wallet_address.slice(-8)}\`\n\n`;
        
        if (currentClaimAddress) {
            promptText += `*Current claim address:*\n\`${currentClaimAddress}\`\n\n`;
        } else {
            promptText += `*No claim address set for this wallet*\n\n`;
        }

        promptText += `Please send a valid Solana address where you want rewards to be sent.\n\n`;
        promptText += `*Requirements:*\n`;
        promptText += `• Valid Solana address (base58)\n`;
        promptText += `• 32-44 characters\n\n`;
        promptText += `*To clear:* Send \`clear\` or \`remove\`\n`;
        promptText += `*To cancel:* Type /cancel`;

        const promptMessage = await bot.sendMessage(chatId, promptText, {
            parse_mode: 'Markdown'
        });

        // Store pending claim address edit state
        setPendingClaimAddress(telegramId, promptMessage.message_id);

    } catch (error) {
        console.error('Error in set claim address callback:', error);

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `❌ Error: ${error.message}`,
            show_alert: true
        });
    }
}

/**
 * Handles the claim address message from user
 * Updates the claim address in the database
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleClaimAddressMessage(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const input = msg.text.trim();

    try {
        // Get pending claim address edit data
        const pendingEdit = getPendingClaimAddress(telegramId);
        if (!pendingEdit) {
            return;
        }

        // Get active wallet
        const wallet = await getActiveWallet(telegramId);
        if (!wallet) {
            clearPendingClaimAddress(telegramId);
            await bot.sendMessage(
                chatId,
                `❌ *Error*\n\nNo active wallet found.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Get previous claim address for audit log
        const previousAddress = await getWalletClaimAddress(wallet.id);

        // Check if user wants to clear the address
        if (input.toLowerCase() === 'clear' || input.toLowerCase() === 'remove') {
            await updateWalletClaimAddress(wallet.id, null);
            
            // Log the action
            await logSecurityAction(
                telegramId,
                wallet.id,
                'claim_address_cleared',
                { 
                    telegram_username: msg.from.username || 'unknown',
                    previous_address: previousAddress,
                    wallet_address: wallet.wallet_address
                }
            );

            clearPendingClaimAddress(telegramId);

            await bot.sendMessage(
                chatId,
                `✅ *Claim Address Cleared*\n\n` +
                `*Wallet:* \`${wallet.label}\`\n\n` +
                `Rewards will now be sent to your wallet address.\n\n` +
                `Use /wallet to see your wallet details`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Validate address format
        if (!isValidSolanaAddress(input)) {
            await bot.sendMessage(
                chatId,
                '❌ Invalid Solana address format.\n\n' +
                'Address must be:\n' +
                '• Base58 encoded\n' +
                '• 32-44 characters\n\n' +
                'Please try again or type /cancel',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Update the claim address for this wallet
        await updateWalletClaimAddress(wallet.id, input);

        // Log the action
        await logSecurityAction(
            telegramId,
            wallet.id,
            'claim_address_set',
            { 
                telegram_username: msg.from.username || 'unknown',
                new_address: input,
                previous_address: previousAddress,
                wallet_address: wallet.wallet_address
            }
        );

        // Clear pending state
        clearPendingClaimAddress(telegramId);

        // Send confirmation
        await bot.sendMessage(
            chatId,
            `✅ *Claim Address Set!*\n\n` +
            `*Wallet:* \`${wallet.label}\`\n` +
            `*New claim address:*\n\`${input}\`\n\n` +
            `⚠️ All rewards from this wallet will be sent to this address.\n\n` +
            `Use /wallet to view or change it`,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error('Error in claim address message handler:', error);

        // Clear pending state
        clearPendingClaimAddress(telegramId);

        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to set claim address: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

