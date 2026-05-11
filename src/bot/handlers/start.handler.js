import { getActiveWallet } from '../../services/wallet.service.js';
import { formatShortAddress } from '../../utils/format.util.js';
import { buildWalletKeyboard } from '../keyboard.util.js';

/**
 * Handles the /start command
 * Shows different welcome messages for new vs returning users
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleStart(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        // Check if user has a wallet
        const wallet = await getActiveWallet(telegramId);

        if (!wallet) {
            // First-time user (No Wallet)
            const welcomeMessage = `
👋 *Welcome to PancakeSwap Autofarmer!*

I help you automate liquidity management on Solana:
• Track claimable rewards
• Monitor position health
• Auto-rebalance when price moves out of range
• Alert you before positions go out of range

*Get Started:*
1️⃣ Generate a new wallet - /newwallet
2️⃣ Or import existing - /importwallet

Need help? Type /help
            `.trim();

            // No wallet yet: do not show wallet keyboard
            await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
        } else {
            // Returning user (Has Wallet)
            const walletDisplay = wallet.label || formatShortAddress(wallet.wallet_address);

            const welcomeMessage = `
👋 *Welcome back!*

*Your Active Wallet:*
${wallet.label ? `*${wallet.label}*` : `\`${walletDisplay}\``}

*Quick Actions:*
• /rewards - Check claimable rewards
• /positions - View all positions
• /wallet - Wallet details
• /balance - Check balance

Type /help for all commands
            `.trim();

            const keyboard = await buildWalletKeyboard(telegramId);
            await bot.sendMessage(chatId, welcomeMessage, {
                parse_mode: 'Markdown',
                ...(keyboard ? { reply_markup: keyboard } : {})
            });
        }

    } catch (error) {
        console.error('Error in start handler:', error);

        // Fallback to basic welcome message
        const welcomeMessage = `
🥞 *PancakeSwap Autofarmer Bot*

Welcome! This bot helps you automate your PancakeSwap liquidity positions on Solana.

Type /help to see available commands.
        `.trim();

        await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    }
}
