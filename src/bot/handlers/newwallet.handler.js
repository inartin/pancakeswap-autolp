import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getOrCreateUser } from '../../services/user.service.js';
import { createWallet, walletExists, getUserWallets } from '../../services/wallet.service.js';
import { buildWalletKeyboard } from '../keyboard.util.js';

// Maximum wallets per user
const MAX_WALLETS_PER_USER = 3;

/**
 * Handles the /newwallet command
 * Generates a new Solana wallet and stores it encrypted
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleNewWallet(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        // Get or create user
        await getOrCreateUser(telegramId);

        // Check existing wallets
        const existingWallets = await getUserWallets(telegramId);

        // If user already has wallets, show confirmation message
        if (existingWallets.length > 0) {
            // Check if at wallet limit
            if (existingWallets.length >= MAX_WALLETS_PER_USER) {
                const limitMessage = `
⚠️ *Wallet Limit Reached*

You've reached the maximum of *${MAX_WALLETS_PER_USER} wallets*.

*Your Current Wallets:*
${existingWallets.map((w, i) => `${i + 1}. ${w.label}\n   \`${w.wallet_address.substring(0, 8)}...${w.wallet_address.substring(w.wallet_address.length - 6)}\` ${w.is_active ? '✅' : ''}`).join('\n')}

*To add a new wallet:*
1. Delete an existing wallet first
2. Then create a new one

*Manage Wallets:*
• /wallets - View all wallets
• /wallet - View active wallet details

Need help? Contact support.
                `.trim();

                await bot.sendMessage(chatId, limitMessage, { parse_mode: 'Markdown' });
                return;
            }

            // User has wallets but hasn't reached limit - show confirmation
            const confirmMessage = `
⚠️ *Create Another Wallet?*

You already have *${existingWallets.length} active wallet${existingWallets.length > 1 ? 's' : ''}*:

${existingWallets.map((w, i) => `${i + 1}. ${w.label}\n   \`${w.wallet_address.substring(0, 8)}...${w.wallet_address.substring(w.wallet_address.length - 6)}\` ${w.is_active ? '✅ Active' : ''}`).join('\n')}

*Wallet Limit:* ${existingWallets.length}/${MAX_WALLETS_PER_USER}

Do you want to create another wallet? This will become your new active wallet.

*Note:* All wallets are managed separately, but share the same bot settings.
            `.trim();

            await bot.sendMessage(chatId, confirmMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Yes, Create New Wallet', callback_data: 'newwallet_confirm' },
                            { text: '❌ Cancel', callback_data: 'newwallet_cancel' }
                        ]
                    ]
                }
            });
            return;
        }

        // No existing wallets - proceed with creation
        await createNewWalletForUser(bot, chatId, telegramId);

    } catch (error) {
        console.error('Error in newwallet handler:', error);

        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to create wallet: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/*
 * Handle button callback for wallet creation confirmation
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} callbackQuery - The callback query object
 */
export async function handleNewWalletCallback(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const telegramId = callbackQuery.from.id;

    try {
        if (data === 'newwallet_cancel') {
            await bot.deleteMessage(chatId, messageId);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '✅ Cancelled',
                show_alert: false
            });

            await bot.sendMessage(
                chatId,
                '👍 *Wallet creation cancelled.*\n\nYour current wallet remains active.\n\nManage wallets: /wallets',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (data === 'newwallet_confirm') {
            await bot.deleteMessage(chatId, messageId);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '🔄 Creating wallet...',
                show_alert: false
            });

            // Create the new wallet
            await createNewWalletForUser(bot, chatId, telegramId);
        }

    } catch (error) {
        console.error('Error in newwallet callback:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `Error: ${error.message}`,
            show_alert: true
        });
    }
}

/**
 * Create a new wallet for the user
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {number} chatId - Chat ID
 * @param {number} telegramId - Telegram user ID
 */
export async function createNewWalletForUser(bot, chatId, telegramId) {
    try {
        // Generate new Solana keypair
        const keypair = Keypair.generate();
        const publicKey = keypair.publicKey.toString();
        const privateKey = bs58.encode(keypair.secretKey);

        // Check if wallet already exists (shouldn't happen with new generation, but safety check)
        const exists = await walletExists(publicKey);
        if (exists) {
            await bot.sendMessage(
                chatId,
                '❌ *Wallet Generation Error*\n\nThis wallet address already exists in our system. Please try again.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Get wallet count for label
        const existingWallets = await getUserWallets(telegramId);
        const walletLabel = existingWallets.length === 0 ? 'My Wallet' : `Wallet ${existingWallets.length + 1}`;

        // Create wallet in database (encrypted)
        const wallet = await createWallet(
            telegramId,
            publicKey,
            privateKey,
            walletLabel
        );

        // Success message following framework
        const successMessage = `
✅ *Wallet Created Successfully!*

*Address:*
\`${publicKey}\`

*🔐 Security:*
Your private key is encrypted and stored securely.

*⚠️ Important:*
Send SOL to this address to fund your wallet before creating positions.

*Next Steps:*
• /exportkey - Export private key (secure)
• /balance - Check wallet balance
• /rewards - Check claimable rewards

*Backup Reminder:*
Make sure to export and securely store your private key!
        `.trim();

        const keyboard = await buildWalletKeyboard(telegramId);
        await bot.sendMessage(chatId, successMessage, {
            parse_mode: 'Markdown',
            ...(keyboard ? { reply_markup: keyboard } : {})
        });

    } catch (error) {
        console.error('Error creating wallet:', error);
        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to create wallet: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}
