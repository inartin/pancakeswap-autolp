import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getOrCreateUser } from '../../services/user.service.js';
import { createWallet, walletExists, createEvmWallet } from '../../services/wallet.service.js';
import { findPositions } from '../../utils/positions.util.js';
import { fetchMeteoraDlmmPositions } from '../../utils/meteora-dlmm.util.js';
import { createSolanaConnection } from '../../utils/rpc.util.js';
import { validateEvmAddress, getEvmBalance } from '../../utils/evm.util.js';
import { buildWalletKeyboard, getCancelOnlyKeyboard } from '../keyboard.util.js';

const pendingImports = new Map();
const pendingEvmImports = new Map();

/**
 * Show import type selection (Solana vs EVM)
 */
export async function showImportTypeSelection(bot, chatId, telegramId) {
    await getOrCreateUser(telegramId);

    const message = `
🔐 *Import Wallet*

Choose which type of wallet to import:
    `.trim();

    const keyboard = {
        inline_keyboard: [
            [{ text: '☀️ Solana Wallet', callback_data: 'import_solana' }],
            [{ text: '🔷 EVM Wallet (Read-Only)', callback_data: 'import_evm' }]
        ]
    };

    await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
}

/**
 * Show Solana import instructions (existing flow)
 */
export async function showImportInstructions(bot, chatId, telegramId) {
    await getOrCreateUser(telegramId);

    pendingImports.set(telegramId, { chatId });

    const promptMessage = `
🔐 *Import Solana Wallet*

Please send your Solana private key in the next message.

*Supported Formats:*
• Base58 encoded (recommended)
• JSON array format

*🔐 Security:*
Your private key will be encrypted immediately and securely stored. The original message will be automatically deleted.

*⚠️ Important:*
Make sure you're in a private chat. Never share your private key with anyone else!

Ready? Send your private key now, or /cancel to abort.
    `.trim();

    await bot.sendMessage(chatId, promptMessage, {
        parse_mode: 'Markdown',
        reply_markup: getCancelOnlyKeyboard()
    });
}

/**
 * Show EVM import instructions
 */
export async function showEvmImportInstructions(bot, chatId, telegramId) {
    await getOrCreateUser(telegramId);

    pendingEvmImports.set(telegramId, { chatId });

    const promptMessage = `
🔷 *Import EVM Wallet (Read-Only)*

Please send your Ethereum/EVM wallet address.

*Format:* \`0x...\` (42 characters)

This is a read-only import — no private key needed.
Only ETH balance will be shown.

Send your address now, or /cancel to abort.
    `.trim();

    await bot.sendMessage(chatId, promptMessage, {
        parse_mode: 'Markdown',
        reply_markup: getCancelOnlyKeyboard()
    });
}

export async function handleImportWallet(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
        await showImportTypeSelection(bot, chatId, telegramId);

    } catch (error) {
        console.error('Error in importwallet handler:', error);

        await bot.sendMessage(
            chatId,
            `❌ *Error*\n\nFailed to start import: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Handles incoming private key message for Solana wallet import
 */
export async function handlePrivateKeyMessage(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const privateKeyInput = msg.text.trim();

    try {
        let keypair;
        let privateKey;

        try {
            const secretKey = bs58.decode(privateKeyInput);
            keypair = Keypair.fromSecretKey(secretKey);
            privateKey = privateKeyInput;
        } catch (e1) {
            try {
                const secretKey = new Uint8Array(JSON.parse(privateKeyInput));
                keypair = Keypair.fromSecretKey(secretKey);
                privateKey = bs58.encode(secretKey);
            } catch (e2) {
                throw new Error('Invalid private key format. Please provide a valid base58 or JSON array format.');
            }
        }

        const publicKey = keypair.publicKey.toString();

        try {
            await bot.deleteMessage(chatId, msg.message_id);
        } catch (deleteError) {
            console.warn('Could not delete private key message:', deleteError.message);
        }

        const exists = await walletExists(publicKey);
        if (exists) {
            await bot.sendMessage(
                chatId,
                '❌ *Wallet Already Exists*\n\nThis wallet is already imported in your account.',
                { parse_mode: 'Markdown' }
            );
            pendingImports.delete(telegramId);

            const walletKeyboard = await buildWalletKeyboard(telegramId);
            if (walletKeyboard) {
                try {
                    const kbMsg = await bot.sendMessage(chatId, '\u200B', { reply_markup: walletKeyboard });
                    await bot.deleteMessage(chatId, kbMsg.message_id);
                } catch (_) {
                    // ignore
                }
            }
            return;
        }

        const processingMsg = await bot.sendMessage(
            chatId,
            '🔄 *Importing Wallet...*\n\nChecking blockchain and encrypting private key...',
            { parse_mode: 'Markdown' }
        );

        const connection = createSolanaConnection();
        const balance = await connection.getBalance(keypair.publicKey);
        const solBalance = (balance / 1e9).toFixed(4);

        let positions = [];
        let meteoraPositions = [];
        try {
            [positions, meteoraPositions] = await Promise.all([
                findPositions(connection, publicKey).catch(err => {
                    console.warn('Could not fetch PancakeSwap positions:', err.message);
                    return [];
                }),
                fetchMeteoraDlmmPositions(publicKey, connection).catch(err => {
                    console.warn('Could not fetch Meteora positions:', err.message);
                    return [];
                })
            ]);
        } catch (error) {
            console.warn('Could not fetch positions:', error.message);
        }

        const wallet = await createWallet(
            telegramId,
            publicKey,
            privateKey,
            'Imported Wallet'
        );

        pendingImports.delete(telegramId);

        let positionsSummary = `*Found ${positions.length} PancakeSwap Position(s)*`;
        if (meteoraPositions.length > 0) {
            positionsSummary += `\n*Found ${meteoraPositions.length} Meteora DLMM Position(s)*`;
        }

        const successMessage = `
✅ *Wallet Imported Successfully!*

*Address:*
\`${publicKey}\`

*Balance:* ${solBalance} SOL

${positionsSummary}

*Next Steps:*
• /rewards - Check pending rewards
• /positions - View position details
• /automate - Enable auto-compounding
        `.trim();

        await bot.editMessageText(successMessage, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown'
        });

        const keyboard = await buildWalletKeyboard(telegramId);
        if (keyboard) {
            await bot.sendMessage(chatId, '💼 *Wallet keyboard active* - Tap to switch wallets', {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }

    } catch (error) {
        console.error('Error importing wallet:', error);

        pendingImports.delete(telegramId);

        await bot.sendMessage(
            chatId,
            `❌ *Import Failed*\n\n${error.message}\n\nTry again with /importwallet`,
            { parse_mode: 'Markdown' }
        );

        try {
            const walletKeyboard = await buildWalletKeyboard(telegramId);
            if (walletKeyboard) {
                const kbMsg = await bot.sendMessage(chatId, '\u200B', { reply_markup: walletKeyboard });
                await bot.deleteMessage(chatId, kbMsg.message_id);
            }
        } catch (_) {
            // ignore
        }
    }
}

/**
 * Handles incoming EVM address message for read-only wallet import
 */
export async function handleEvmAddressMessage(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const addressInput = msg.text.trim();

    try {
        const checksumAddress = validateEvmAddress(addressInput);
        if (!checksumAddress) {
            await bot.sendMessage(
                chatId,
                '❌ *Invalid EVM Address*\n\nPlease send a valid Ethereum address (0x... 42 characters).\n\nOr /cancel to abort.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const exists = await walletExists(checksumAddress);
        if (exists) {
            await bot.sendMessage(
                chatId,
                '❌ *Wallet Already Exists*\n\nThis EVM wallet is already imported in your account.',
                { parse_mode: 'Markdown' }
            );
            pendingEvmImports.delete(telegramId);

            const walletKeyboard = await buildWalletKeyboard(telegramId);
            if (walletKeyboard) {
                try {
                    const kbMsg = await bot.sendMessage(chatId, '\u200B', { reply_markup: walletKeyboard });
                    await bot.deleteMessage(chatId, kbMsg.message_id);
                } catch (_) {}
            }
            return;
        }

        const processingMsg = await bot.sendMessage(
            chatId,
            '🔄 *Importing EVM Wallet...*\n\nFetching balance...',
            { parse_mode: 'Markdown' }
        );

        let ethBalance;
        try {
            ethBalance = getEvmBalance(checksumAddress);
            ethBalance = await ethBalance;
        } catch (error) {
            console.warn('Could not fetch ETH balance:', error.message);
            ethBalance = '0.0';
        }

        const wallet = await createEvmWallet(
            telegramId,
            checksumAddress,
            'EVM Wallet'
        );

        pendingEvmImports.delete(telegramId);

        const displayBalance = parseFloat(ethBalance).toFixed(6);
        const successMessage = `
✅ *EVM Wallet Imported Successfully!*

*Address:*
\`${checksumAddress}\`

*Balance:* ${displayBalance} ETH

🔷 _Read-only wallet — balance viewing only_

*Actions:*
• /wallet - View wallet details
• /balance - Refresh balance
        `.trim();

        await bot.editMessageText(successMessage, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            parse_mode: 'Markdown'
        });

        const keyboard = await buildWalletKeyboard(telegramId);
        if (keyboard) {
            await bot.sendMessage(chatId, '💼 *Wallet keyboard active* - Tap to switch wallets', {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }

    } catch (error) {
        console.error('Error importing EVM wallet:', error);

        pendingEvmImports.delete(telegramId);

        await bot.sendMessage(
            chatId,
            `❌ *EVM Import Failed*\n\n${error.message}\n\nTry again with /importwallet`,
            { parse_mode: 'Markdown' }
        );

        try {
            const walletKeyboard = await buildWalletKeyboard(telegramId);
            if (walletKeyboard) {
                const kbMsg = await bot.sendMessage(chatId, '\u200B', { reply_markup: walletKeyboard });
                await bot.deleteMessage(chatId, kbMsg.message_id);
            }
        } catch (_) {}
    }
}

export function hasPendingImport(telegramId) {
    return pendingImports.has(telegramId);
}

export function cancelPendingImport(telegramId) {
    pendingImports.delete(telegramId);
}

export function hasPendingEvmImport(telegramId) {
    return pendingEvmImports.has(telegramId);
}

export function cancelPendingEvmImport(telegramId) {
    pendingEvmImports.delete(telegramId);
}
