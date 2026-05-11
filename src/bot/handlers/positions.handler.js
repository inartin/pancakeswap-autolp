/**
 * Positions List Handler
 * 
 * Handles the /positions command - displays all LP positions with range visualizations
 * Following UIX framework format (lines 1245-1295 in autofarmer_message_framework.md)
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createSolanaConnection } from '../../utils/rpc.util.js';
import { COMMITMENT_LEVEL, DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS, RECOMMENDED_SOL_BUFFER } from '../../config/constants.js';
import { isEvmWallet, getEvmUniswapPositions } from '../../utils/evm.util.js';
import { findPositions } from '../../utils/positions.util.js';
import { fetchPositionRangeData } from '../../utils/range.util.js';
import { calculateCompleteApr } from '../../utils/apr.util.js';
import { formatPositionsListMessage, formatErrorMessage, formatLoadingMessage } from '../formatters/message.formatter.js';
import { getActiveWallet, getActiveWalletWithEncryption } from '../../services/wallet.service.js';
import { upsertPosition, updatePositionStatus, getWalletPositions } from '../../services/position.service.js';
import { removeLiquidity } from '../../utils/remove-liquidity.util.js';
import { decryptPrivateKey } from '../../utils/encryption.util.js';
import { formatCurrency, getPancakeSwapPositionUrl, formatTokenAmount } from '../../utils/format.util.js';
import { getTokenSymbol } from '../../config/constants.js';
import { resolveTokenSymbol } from '../../utils/token.util.js';
import { db } from '../../db/index.js';
import { positions as positionsTable, proximity_alerts } from '../../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { ensureProximityRow, getOutOfRangeConfig, toggleOutOfRangeEnabled, toggleProximityEnabled } from '../../services/alert.service.js';
import { buildPoolsReplyKeyboard } from '../keyboard.util.js';
import { updatePoolsReplyKeyboard } from '../keyboard.util.js';
import { storeKeyboardMessageId } from '../keyboard.util.js';
import { getPositionStatistics, carryOverStatistics, getDailyAverageApr, getMonthlyAverageApr, getLifetimeAverageApr } from '../../services/position-statistics.service.js';

const OUT_RANGE_ALERT_ON = '🔔 Out of Range Alerts';
const OUT_RANGE_ALERT_OFF = '🔕 Out of Range Alerts';
const PROXIMITY_ON = '🎚️ Proximity ON';
const PROXIMITY_OFF = '🎚️ Proximity OFF';

// Track selected pool label per chat so refresh keeps the filter
const _selectedPoolLabelByChatId = new Map();

export function clearSelectedPoolFilter(chatId) {
    try {
        _selectedPoolLabelByChatId.delete(chatId);
    } catch (_) {}
}

/**
 * Handles the /positions command
 * Shows all positions with range visualization
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handlePositions(bot, msg, opts = {}) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const requestedPoolLabel = typeof opts.poolLabel === 'string' && opts.poolLabel.trim().length > 0
        ? opts.poolLabel.trim()
        : null;

    try {
        // Get active wallet
        const wallet = await getActiveWallet(telegramId);

        if (!wallet) {
            await bot.sendMessage(
                chatId,
                formatErrorMessage('No wallet configured.\n\nPlease set up a wallet first:\n• `/newwallet` - Generate new wallet\n• `/importwallet` - Import existing wallet'),
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const walletAddress = wallet.wallet_address;

        // Persist requested filter (if any)
        if (requestedPoolLabel) {
            _selectedPoolLabelByChatId.set(chatId, requestedPoolLabel);
        }

        // Send loading message
        const loadingMsg = await bot.sendMessage(
            chatId,
            formatLoadingMessage(walletAddress, wallet.label),
            { parse_mode: 'Markdown' }
        );

        try {
            // --- EVM wallet: read Uniswap V3 / V4 positions ---
            if (isEvmWallet(walletAddress)) {
                let evmPositions = [];
                try {
                    evmPositions = await getEvmUniswapPositions(walletAddress);
                } catch (evmErr) {
                    console.error('Error fetching EVM positions:', evmErr);
                }

                let evmMessage;
                if (evmPositions.length === 0) {
                    evmMessage = `❌ *No EVM Positions Found*\n\nNo active Uniswap V3 or V4 positions detected for this wallet.`;
                } else {
                    evmMessage = `🔷 *EVM Positions*\n\n`;
                    for (const pos of evmPositions) {
                        const emoji = pos.inRange ? '✅' : '⭕️';
                        evmMessage += `${emoji} ${pos.poolLabel}\n`;
                    }
                }

                await bot.editMessageText(evmMessage, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown'
                });
                return;
            }

            // Connect to Solana
            const connection = createSolanaConnection();
            const startFind = Date.now();
            // Find all PancakeSwap positions for the wallet
            if (process.env.LOG_LEVEL === 'debug') {
                console.log('⏱️  Starting findPositions...');
            }
            const positions = await findPositions(connection, walletAddress);
            if (process.env.LOG_LEVEL === 'debug') { console.log('✅ findPositions took', Date.now() - startFind, 'ms');}

            // Background: Clean up orphaned positions in DB (positions that exist in DB but not on-chain)
            // This runs asynchronously so it doesn't block the UI update
            (async () => {
                try {
                    const onChainMints = new Set(positions.map(p => p.mintAddress));
                    const dbPositions = await getWalletPositions(wallet.id, 'active');
                    
                    const orphaned = dbPositions.filter(
                        dbPos => !onChainMints.has(dbPos.nft_mint)
                    );
                    
                    if (orphaned.length > 0) {
                        for (const pos of orphaned) {
                            try {
                                await updatePositionStatus(pos.nft_mint, 'closed');
                            } catch (err) {
                                console.warn(`⚠️ Failed to mark orphaned position ${pos.nft_mint} as closed:`, err.message);
                            }
                        }
                    }
                } catch (err) {
                    console.warn('⚠️ Failed to check for orphaned positions:', err.message);
                }
            })().catch(err => console.error('❌ Orphan cleanup error:', err));

            if (positions.length === 0) {
                await bot.editMessageText(
                    await formatPositionsListMessage([]),
                    {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id,
                        parse_mode: 'Markdown'
                    }
                );
                
                // Update keyboard to remove pool buttons when no positions exist
                try {
                    await updatePoolsReplyKeyboard(bot, chatId, walletAddress);
                } catch (keyboardError) {
                    console.warn('Failed to update keyboard when no positions:', keyboardError.message);
                }
                
                return;
            }

            // Process each position to get range data
            const positionsData = [];

            for (const position of positions) {
                try {
                    // Fetch position range data
                    // console.log('⏱️  Starting fetchPositionRangeData...');
                    // const startRange = Date.now();
                    const rangeData = await fetchPositionRangeData(
                        connection,
                        position.positionPda
                    );
                    // console.log('✅ fetchPositionRangeData took', Date.now() - startRange, 'ms');

                    // Get existing position from DB to preserve range_percent and fetch statistics
                    let rangePercent = null;
                    let statistics = null;
                    let positionId = null;
                    try {
                        const existingPosition = await db.select()
                            .from(positionsTable)
                            .where(eq(positionsTable.nft_mint, position.mintAddress))
                            .limit(1);
                        
                        if (existingPosition.length > 0) {
                            rangePercent = existingPosition[0].range_percent;
                            positionId = existingPosition[0].id;
                            
                            // Fetch statistics for this position
                            try {
                                statistics = await getPositionStatistics(existingPosition[0].id);
                            } catch (statsError) {
                                console.warn(`Failed to fetch statistics for position ${position.mintAddress}:`, statsError.message);
                            }
                        }
                    } catch (dbQueryError) {
                        console.warn(`Failed to fetch existing position for ${position.mintAddress}:`, dbQueryError.message);
                    }

                    // Derive range percent from price bounds when missing
                    if ((rangePercent === null || rangePercent === undefined)
                        && typeof rangeData.lowerPrice === 'number'
                        && typeof rangeData.upperPrice === 'number'
                        && rangeData.lowerPrice > 0
                        && rangeData.upperPrice > 0) {
                        const priceRatio = rangeData.upperPrice / rangeData.lowerPrice;
                        if (Number.isFinite(priceRatio) && priceRatio > 0) {
                            const spreadFraction = (priceRatio - 1) / (priceRatio + 1);
                            if (Number.isFinite(spreadFraction) && spreadFraction > 0) {
                                const percent = spreadFraction * 100;
                                const roundedUp = Math.ceil(percent * 10) / 10;
                                if (roundedUp > 0) {
                                    rangePercent = roundedUp;
                                }
                            }
                        }
                    }

                    // Calculate APR data
                    let aprData = null;
                    try {
                        const startApr = Date.now();
                        aprData = await calculateCompleteApr({
                            poolId: rangeData.poolId,
                            inRange: rangeData.inRange,
                            positionLiquidity: rangeData.liquidity,
                            poolLiquidity: rangeData.poolLiquidity,
                            positionValueUsd: rangeData.liquidityValueUsd
                        });
                        if (process.env.LOG_LEVEL === 'debug') {
                            console.log('✅ calculateCompleteApr took', Date.now() - startApr, 'ms');
                        }
                    } catch (aprError) {
                        console.error(`Error calculating APR for position ${position.mintAddress}:`, aprError);
                        // Continue without APR data
                    }

                    // Fetch average APR data if we have a position ID
                    let avgAprData = null;
                    if (positionId) {
                        try {
                            const [dailyAvg, monthlyAvg, lifetimeAvg] = await Promise.all([
                                getDailyAverageApr(positionId),
                                getMonthlyAverageApr(positionId),
                                getLifetimeAverageApr(positionId)
                            ]);
                            avgAprData = {
                                daily: dailyAvg,
                                monthly: monthlyAvg,
                                lifetime: lifetimeAvg
                            };
                        } catch (avgAprError) {
                            // Continue without average APR data
                        }
                    }

                    positionsData.push({
                        ...rangeData,
                        aprData,
                        avgAprData, // Add average APR data
                        mintAddress: position.mintAddress,
                        nftAccount: position.nftAccount,
                        range_percent: rangePercent,
                        statistics: statistics, // Add statistics to position data
                        positionId: positionId, // Add database position ID
                        success: true
                    });

                } catch (error) {
                    console.error(`Error fetching range data for position ${position.mintAddress}:`, error);
                    positionsData.push({
                        mintAddress: position.mintAddress,
                        error: error.message,
                        success: false
                    });
                }
            }
            
            // Filter positions by selected pool (if any)
            const activePoolLabel = requestedPoolLabel || _selectedPoolLabelByChatId.get(chatId) || null;
            const filteredPositionsData = (() => {
                if (!activePoolLabel) return positionsData;
                try {
                    return positionsData.filter(p => {
                        const t0 = getTokenSymbol(p.mint0);
                        const t1 = getTokenSymbol(p.mint1);
                        return `${t0}-${t1}` === activePoolLabel;
                    });
                } catch (_) {
                    return positionsData;
                }
            })();

            // Format and send the results
            const message = await formatPositionsListMessage(filteredPositionsData);

            // Create inline keyboard with per-position action buttons (no pool row inside message)
            const keyboard = { inline_keyboard: [] };

            // Build buttons per position with persisted DB rows and config
            for (let index = 0; index < filteredPositionsData.length; index++) {
                const position = filteredPositionsData[index];
                if (!position.success) continue;

                // Persist/update the position so toggles have a position_id
                try {
                    const [sym0, sym1] = await Promise.all([
                        resolveTokenSymbol(position.mint0),
                        resolveTokenSymbol(position.mint1)
                    ]);

                    const saved = await upsertPosition({
                        wallet_id: wallet.id,
                        nft_mint: position.mintAddress,
                        pool_address: position.poolId,
                        token0_mint: position.mint0,
                        token1_mint: position.mint1,
                        token0_symbol: sym0,
                        token1_symbol: sym1,
                        fee_tier: null,
                        lower_price: position.lowerPrice,
                        upper_price: position.upperPrice,
                        current_price: position.currentPrice,
                        liquidity_value_usd: position.liquidityValueUsd,
                        range_percent: position.range_percent, // Use existing range_percent
                        status: 'active'
                    });
                    
                    // Update positionId in positionsData if it wasn't set before
                    if (!position.positionId && saved.id) {
                        position.positionId = saved.id;
                    }

                    // Ensure config row and get current enabled state
                    const cfg = await ensureProximityRow(saved.id);
                    const outRangeEnabled = cfg?.out_of_range_enabled !== 0 && cfg?.out_of_range_enabled !== false;
                    const alertsLabel = outRangeEnabled ? OUT_RANGE_ALERT_ON : OUT_RANGE_ALERT_OFF;

                    // Get auto-rebalance status
                    const autoRebalanceEnabled = saved.auto_rebalance_enabled || false;
                    const autoRebalanceLabel = autoRebalanceEnabled ? '🤖✅ Auto-Rebalance' : '🤖❌ Auto-Rebalance';

                    // Row 1: Close and Top Up buttons
                    keyboard.inline_keyboard.push([
                        {
                            text: `🔴 Close #${index + 1}`,
                            callback_data: `position_close_${position.mintAddress}`
                        },
                        {
                            text: `💰 Top Up #${index + 1}`,
                            callback_data: `topup_${position.mintAddress}`
                        }
                    ]);

                    // Row 2: Rebalance and Auto-Rebalance buttons
                    keyboard.inline_keyboard.push([
                        {
                            text: `⚖️ Rebalance #${index + 1}`,
                            callback_data: `rebalance_${position.mintAddress}`
                        },
                        {
                            text: autoRebalanceLabel,
                            callback_data: `toggle_autorebalance_${saved.id}`
                        }
                    ]);

                    // Row 3: New Range button (if position has range_percent set)
                    if (saved.range_percent != null) {
                        keyboard.inline_keyboard.push([
                            {
                                text: `🔧 New Range #${index + 1}`,
                                callback_data: `rebalance_newrange_${position.mintAddress}`
                            }
                        ]);
                    }

                    // Row 4: Alerts and Stats buttons
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

                    // Row 5: Link Previous Stats button (always visible)
                    keyboard.inline_keyboard.push([
                        {
                            text: `📊 Link Previous Stats`,
                            callback_data: `link_stats_prompt_${saved.id}`
                        }
                    ]);
                } catch (e) {
                    console.warn('Persist position failed:', e?.message || e);
                }
            }

            // Add global Rewards and Refresh buttons at the bottom
            if (keyboard.inline_keyboard.length > 0) {
                keyboard.inline_keyboard.push([
                    { text: '💰 Rewards', callback_data: 'rewards' },
                ]);
                keyboard.inline_keyboard.push([
                    { text: '🔄 Refresh', callback_data: 'positions_refresh' }
                ]);
            }

            // Send the main message with inline buttons only
            await bot.editMessageText(
                message,
                {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: keyboard,
                    disable_web_page_preview: true
                }
            );

            // Update the persistent reply keyboard on the loading message
            try {
                // const poolsReplyKb = await buildPoolsReplyKeyboard(walletAddress, positionsData);
                // await bot.editMessageReplyMarkup(poolsReplyKb, {
                //     chat_id: chatId,
                //     message_id: loadingMsg.message_id
                // });
                storeKeyboardMessageId(chatId, loadingMsg.message_id);
            } catch (keyboardError) {
                console.warn('Failed to update pools reply keyboard:', keyboardError.message);
            }

        } catch (error) {
            console.error('Error in positions handler:', error);

            await bot.editMessageText(
                formatErrorMessage(`Failed to fetch positions: ${error.message}`),
                {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown',
                }
            );
        }

    } catch (outerError) {
        console.error('Error fetching active wallet:', outerError);

        await bot.sendMessage(
            chatId,
            formatErrorMessage(`Failed to load wallet: ${outerError.message}`),
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Toggle out-of-range alerts for a position (per row button)
 */
export async function handleToggleAlerts(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const nftAddress = data.replace('toggle_alerts_', '');

    // Answer callback immediately
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Toggling alerts…' });

    try {
        // Find DB position by NFT
        const dbRows = await db.select()
            .from(positionsTable)
            .where(eq(positionsTable.nft_mint, nftAddress))
            .limit(1);
        const dbPos = dbRows[0];
        if (!dbPos) {
            // Fallback: refresh positions to persist it, then return
            await handlePositionsRefresh(bot, callbackQuery);
            return;
        }

        const newEnabled = await toggleOutOfRangeEnabled(dbPos.id);
        const emoji = newEnabled ? '🔔' : '🔕';
        const newText = newEnabled ? OUT_RANGE_ALERT_ON : OUT_RANGE_ALERT_OFF;

        const msg = callbackQuery.message;
        const kb = msg?.reply_markup?.inline_keyboard;
        if (Array.isArray(kb)) {
            const updated = kb.map(row => row.map(btn => {
                if (btn.callback_data === `toggle_alerts_${nftAddress}`) {
                    return { ...btn, text: newText };
                }
                return btn;
            }));
            await bot.editMessageReplyMarkup(
                { inline_keyboard: updated },
                { chat_id: chatId, message_id: msg.message_id }
            );
            await bot.answerCallbackQuery(callbackQuery.id, { text: `${emoji} Alerts ${newEnabled ? 'enabled' : 'disabled'}` });
        } else {
            // If we can't read current keyboard, refresh as fallback
            await handlePositionsRefresh(bot, callbackQuery);
        }
    } catch (err) {
        console.error('Toggle alerts error:', err);
        await bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Failed: ${err?.message || err}`, show_alert: true });
    }
}

/**
 * Toggle proximity alerts for a position (per row button)
 */
export async function handleToggleProximity(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const nftAddress = data.replace('toggle_proximity_', '');

    // Answer callback immediately
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Toggling proximity…' });

    try {
        // Find DB position by NFT
        const dbRows = await db.select()
            .from(positionsTable)
            .where(eq(positionsTable.nft_mint, nftAddress))
            .limit(1);
        const dbPos = dbRows[0];
        if (!dbPos) {
            await handlePositionsRefresh(bot, callbackQuery);
            return;
        }

        const newEnabled = await toggleProximityEnabled(dbPos.id);
        const newText = newEnabled ? PROXIMITY_ON : PROXIMITY_OFF;

        const msg = callbackQuery.message;
        const kb = msg?.reply_markup?.inline_keyboard;
        if (Array.isArray(kb)) {
            const updated = kb.map(row => row.map(btn => {
                if (btn.callback_data === `toggle_proximity_${nftAddress}`) {
                    return { ...btn, text: newText };
                }
                return btn;
            }));
            await bot.editMessageReplyMarkup(
                { inline_keyboard: updated },
                { chat_id: chatId, message_id: msg.message_id }
            );
            await bot.answerCallbackQuery(callbackQuery.id, { text: `${newEnabled ? '🎚️ Enabled' : '🎚️ Disabled'}` });
        } else {
            await handlePositionsRefresh(bot, callbackQuery);
        }
    } catch (err) {
        console.error('Toggle proximity error:', err);
        await bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Failed: ${err?.message || err}`, show_alert: true });
    }
}

/**
 * Handle position refresh callback
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handlePositionsRefresh(bot, callbackQuery) {
    // Answer the callback query first
    await bot.answerCallbackQuery(callbackQuery.id, {
        text: '🔄 Refreshing positions...'
    });

    // Create synthetic message to reuse handlePositions
    const syntheticMsg = {
        chat: { id: callbackQuery.message.chat.id },
        from: { id: callbackQuery.from.id }
    };

    // Delete the old message
    try {
        await bot.deleteMessage(
            callbackQuery.message.chat.id,
            callbackQuery.message.message_id
        );
    } catch (error) {
        // Ignore - message may already be deleted
    }

    // Call handlePositions to show fresh data
    await handlePositions(bot, syntheticMsg);
}

/**
 * Handle close position callback - shows confirmation dialog
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleClosePositionCallback(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    // Extract NFT address from callback data: position_close_<nft_address>
    const nftAddress = data.replace('position_close_', '');

    if (!nftAddress) {
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Invalid position data',
            show_alert: true
        });
        return;
    }

    // Answer the callback query
    await bot.answerCallbackQuery(callbackQuery.id);

    // Show confirmation dialog
    await bot.sendMessage(chatId,
        `⚠️ *Confirm Close Position*\n\n` +
        `You are about to:\n` +
        `• Remove ALL liquidity from position\n` +
        `• Collect all fees and rewards\n` +
        `• Close the position permanently\n` +
        `• Reclaim rent (~${RECOMMENDED_SOL_BUFFER} SOL)\n\n` +
        `*Position:* \`${nftAddress.slice(0, 8)}...${nftAddress.slice(-8)}\`\n\n` +
        `⚠️ *This action cannot be undone.*\n\n` +
        `Do you want to proceed?`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Confirm Close', callback_data: `confirm_close_${nftAddress}` },
                        { text: '❌ Cancel', callback_data: 'cancel_close' }
                    ]
                ]
            }
        }
    );
}

/**
 * Handle confirmed close position - executes the transaction
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleConfirmClosePosition(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const telegramId = callbackQuery.from.id;
    const data = callbackQuery.data;

    // Extract NFT address
    const nftAddress = data.replace('confirm_close_', '');

    // Answer callback immediately
    await bot.answerCallbackQuery(callbackQuery.id, {
        text: '🔄 Closing position...'
    });

    // Delete confirmation message
    try {
        await bot.deleteMessage(chatId, callbackQuery.message.message_id);
    } catch (error) {
        // Ignore - message may already be deleted
    }

    try {
        // 1. Get active wallet with encryption data
        const wallet = await getActiveWalletWithEncryption(telegramId);

        if (!wallet) {
            await bot.sendMessage(chatId,
                `❌ *No Wallet Configured*\n\n` +
                `You need to set up a wallet first.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🆕 Create New Wallet', callback_data: 'newwallet' }],
                            [{ text: '📥 Import Existing Wallet', callback_data: 'importwallet' }]
                        ]
                    }
                }
            );
            return;
        }

        // 2. Validate wallet has encryption data
        if (!wallet.encrypted_private_key || !wallet.nonce || !wallet.salt) {
            await bot.sendMessage(chatId,
                `❌ *Wallet Data Incomplete*\n\n` +
                `The wallet encryption data is missing or incomplete.\n\n` +
                `This wallet may have been created with an older version.\n` +
                `Please re-import the wallet using \`/importwallet\``,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // 3. Check MASTER_PASSWORD is set
        if (!process.env.MASTER_PASSWORD) {
            await bot.sendMessage(chatId,
                `❌ *Configuration Error*\n\n` +
                `MASTER_PASSWORD is not configured.\n\n` +
                `Please contact the bot administrator.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // 4. Show initial processing message (we'll update step count after checking for WSOL)
        const processingMsg = await bot.sendMessage(chatId,
            `🔄 *Closing Position...*\n\n` +
            `*Position:* \`${nftAddress.slice(0, 8)}...${nftAddress.slice(-8)}\`\n\n` +
            `*Step 1:* Building transaction...\n\n` +
            `⏳ *This may take 30-60 seconds*`,
            { parse_mode: 'Markdown' }
        );

        // 5. Decrypt private key and create keypair
        let privateKey;
        try {
            privateKey = decryptPrivateKey(
                wallet.encrypted_private_key,
                wallet.nonce,
                wallet.salt,
                process.env.MASTER_PASSWORD
            );
        } catch (decryptError) {
            await bot.editMessageText(
                `❌ *Decryption Failed*\n\n` +
                `Could not decrypt wallet private key.\n\n` +
                `*Error:* ${decryptError.message}\n\n` +
                `This may indicate:\n` +
                `• Incorrect MASTER_PASSWORD\n` +
                `• Corrupted wallet data\n\n` +
                `Please contact support.`,
                {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );
            return;
        }

        const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
        const connection = new Connection(process.env.SOLANA_RPC_URL, COMMITMENT_LEVEL);
        const positionMintPk = new PublicKey(nftAddress);

        // 6. Check if position involves WSOL (to determine step count)
        const { BorshCoder } = await import('@coral-xyz/anchor');
        const { PANCAKESWAP_IDL, PROGRAM_ID, KNOWN_TOKENS } = await import('../../config/constants.js');
        
        const coder = new BorshCoder(PANCAKESWAP_IDL);
        const [personalPositionPk] = PublicKey.findProgramAddressSync(
            [Buffer.from("position"), positionMintPk.toBuffer()],
            PROGRAM_ID
        );
        
        let hasWsol = false;
        try {
            const positionAi = await connection.getAccountInfo(personalPositionPk);
            if (positionAi) {
                const position = coder.accounts.decode("PersonalPositionState", positionAi.data);
                const poolPk = new PublicKey(position.pool_id);
                const poolAi = await connection.getAccountInfo(poolPk);
                if (poolAi) {
                    const pool = coder.accounts.decode("PoolState", poolAi.data);
                    const mint0 = new PublicKey(pool.token_mint_0);
                    const mint1 = new PublicKey(pool.token_mint_1);
                    const wsolMint = new PublicKey(KNOWN_TOKENS.SOL.mint);
                    hasWsol = mint0.equals(wsolMint) || mint1.equals(wsolMint);
                }
            }
        } catch (error) {
            // Continue anyway - we'll just use default step count
            console.warn('Could not check for WSOL:', error.message);
        }

        const totalSteps = hasWsol ? 4 : 3;

        // 7. Update: Removing liquidity
        await bot.editMessageText(
            `🔄 *Closing Position...*\n\n` +
            `*Position:* \`${nftAddress.slice(0, 8)}...${nftAddress.slice(-8)}\`\n\n` +
            `*Step 2/${totalSteps}:* Removing liquidity...\n\n` +
            `⏳ *Submitting to Solana...*`,
            {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown'
            }
        );

        // 8. Execute removal with 1% slippage tolerance
        const result = await removeLiquidity(connection, keypair, positionMintPk, {
            slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS
        });

        // 9. Handle result
        if (!result.success) {
            await bot.editMessageText(
                `❌ *Position Close Failed*\n\n` +
                `*Error:* ${result.error}\n\n` +
                `*Common Causes:*\n` +
                `• No liquidity in position\n` +
                `• Position already closed\n` +
                `• Insufficient SOL for fees (~0.01 SOL needed)\n` +
                `• Network congestion\n` +
                `• Slippage exceeded (price moved too much)`,
                {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📊 View Positions', callback_data: 'positions' }],
                            [{ text: '❓ Help', callback_data: 'help' }]
                        ]
                    }
                }
            );
            return;
        }

        // Update position status in database if closed successfully
        if (result.positionClosed) {
            try {
                await updatePositionStatus(nftAddress, 'closed');
            } catch (dbError) {
                // Don't fail the whole operation if DB update fails
                console.warn('Failed to update position status in database:', dbError.message);
            }
        }

        // 10. Show unwrapping step if WSOL was detected
        if (hasWsol) {
            const wasUnwrapped = result.tokensWithdrawn.some(token => token.unwrapped);
            if (wasUnwrapped) {
                await bot.editMessageText(
                    `🔄 *Closing Position...*\n\n` +
                    `*Position:* \`${nftAddress.slice(0, 8)}...${nftAddress.slice(-8)}\`\n\n` +
                    `*Step 3/4:* Unwrapping SOL...\n\n` +
                    `⏳ *Converting WSOL to native SOL...*`,
                    {
                        chat_id: chatId,
                        message_id: processingMsg.message_id,
                        parse_mode: 'Markdown'
                    }
                );
                // Give user time to see the unwrapping message
                await new Promise(resolve => setTimeout(resolve, 800));
            }
        }

        // 11. Update: Closing position account
        await bot.editMessageText(
            `🔄 *Closing Position...*\n\n` +
            `*Position:* \`${nftAddress.slice(0, 8)}...${nftAddress.slice(-8)}\`\n\n` +
            `*Step ${totalSteps}/${totalSteps}:* Closing position account...\n\n` +
            `⏳ *Almost done...*`,
            {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown'
            }
        );

        // 12. Format success message
        const tokensStr = result.tokensWithdrawn.map(token => {
            const usdStr = token.usdValue ? ` (~${formatCurrency(token.usdValue)})` : '';
            return `• ${formatTokenAmount(token.uiAmount)} ${token.symbol}${usdStr}`;
        }).join('\n');

        const rewardsStr = result.rewardsCollected.length > 0
            ? '\n*Rewards Collected:*\n' + result.rewardsCollected.map(token => {
                const usdStr = token.usdValue ? ` (~${formatCurrency(token.usdValue)})` : '';
                return `• ${formatTokenAmount(token.uiAmount)} ${token.symbol}${usdStr}`;
            }).join('\n')
            : '';

        const rentStr = result.positionClosed && result.rentReclaimed
            ? `\n*Rent Reclaimed:* ${formatTokenAmount(result.rentReclaimed)} SOL`
            : '';

        const positionStatusStr = result.positionClosed ? ''  : '\n⚠️ *Position still open (manual close needed)*';

        await bot.editMessageText(
            `✅ *Position Closed Successfully!*\n\n` +
            `*Liquidity Removed:* ${result.liquidityRemovedFormatted}\n\n` +
            `*Tokens Withdrawn:*\n${tokensStr}` +
            rewardsStr +
            rentStr +
            positionStatusStr +
            `\n\n*Total Value:* ~${formatCurrency(result.totalUsd)}\n\n` +
            `*Transaction:*\n[View on Solscan](${result.explorer})`,
            {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💵 Check Balance', callback_data: 'balance' }],
                        [{ text: '📊 View Positions', callback_data: 'positions' }]
                    ]
                }
            }
        );

        // Update the persistent reply keyboard after successful close
        // This removes the closed pool from the keyboard buttons
        try {
            await updatePoolsReplyKeyboard(bot, chatId, wallet.wallet_address);
        } catch (keyboardError) {
            console.warn('Failed to update reply keyboard after close:', keyboardError.message);
        }

    } catch (error) {
        console.error('Error closing position:', error);
        
        await bot.sendMessage(chatId,
            `❌ *Unexpected Error*\n\n` +
            `An unexpected error occurred while closing the position.\n\n` +
            `*Error:* ${error.message}\n\n` +
            `Please try again or contact support if the issue persists.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📊 View Positions', callback_data: 'positions' }]
                    ]
                }
            }
        );
    }
}

/**
 * Handle auto-rebalance toggle callback
 * 
 * Simple toggle like alerts - directly toggles on/off without showing menu
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleToggleAutoRebalance(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    
    // Extract position ID: toggle_autorebalance_{positionId}
    const positionId = parseInt(data.replace('toggle_autorebalance_', ''), 10);
    
    // Answer callback immediately
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Toggling auto-rebalance…' });
    
    try {
        const { togglePositionAutoRebalance } = await import('../../services/position.service.js');
        const newEnabled = await togglePositionAutoRebalance(positionId);
        const emoji = newEnabled ? '🤖✅' : '🤖❌';
        const newText = newEnabled ? '🤖✅ Auto-Rebalance' : '🤖❌ Auto-Rebalance';
        
        const msg = callbackQuery.message;
        const kb = msg?.reply_markup?.inline_keyboard;
        if (Array.isArray(kb)) {
            const updated = kb.map(row => row.map(btn => {
                if (btn.callback_data === `toggle_autorebalance_${positionId}`) {
                    return { ...btn, text: newText };
                }
                return btn;
            }));
            await bot.editMessageReplyMarkup(
                { inline_keyboard: updated },
                { chat_id: chatId, message_id: msg.message_id }
            );
            await bot.answerCallbackQuery(callbackQuery.id, { text: `${emoji} Auto-rebalance ${newEnabled ? 'enabled' : 'disabled'}` });
        } else {
            // If we can't read current keyboard, refresh as fallback
            await handlePositionsRefresh(bot, callbackQuery);
        }
    } catch (err) {
        console.error('Toggle auto-rebalance error:', err);
        await bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Failed: ${err?.message || err}`, show_alert: true });
    }
}

/**
 * Handle claim-before-rebalance toggle callback
 * 
 * Shows explanation menu with toggle and cancel buttons
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleToggleClaimBeforeRebalance(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    
    // Handle toggle confirmation: toggle_claim_before_rebalance_confirm_{positionId}
    if (data.startsWith('toggle_claim_before_rebalance_confirm_')) {
        const positionId = parseInt(data.replace('toggle_claim_before_rebalance_confirm_', ''), 10);
        
        // Answer callback immediately
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '🔄 Updating claim-before-rebalance setting...'
        });
        
        try {
            const { togglePositionClaimBeforeRebalance } = await import('../../services/position.service.js');
            const newEnabled = await togglePositionClaimBeforeRebalance(positionId);
            
            const emoji = newEnabled ? '💰✅' : '💰❌';
            const status = newEnabled ? 'enabled' : 'disabled';
            
            // Delete explanation message
            try {
                await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            } catch (error) {
                // Ignore - message may already be deleted
            }
            
            // Show confirmation
            await bot.sendMessage(chatId,
                `${emoji} *Claim-Before-Rebalance ${status.charAt(0).toUpperCase() + status.slice(1)}*\n\n` +
                `Claim-before-rebalance has been ${status} for this position.\n\n` +
                (newEnabled 
                    ? `✅ Rewards will be claimed automatically before rebalancing.`
                    : `⚠️ Rewards will NOT be claimed before rebalancing.`),
                { parse_mode: 'Markdown' }
            );
            
            // Refresh positions to show updated button
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            await handlePositions(bot, syntheticMsg);
            
        } catch (error) {
            console.error('Error toggling claim-before-rebalance:', error);
            await bot.sendMessage(chatId,
                `❌ *Error*\n\n${error.message}`,
                { parse_mode: 'Markdown' }
            );
        }
        
        return;
    }
    
    // Handle initial toggle click: toggle_claim_before_rebalance_{positionId}
    const positionId = parseInt(data.replace('toggle_claim_before_rebalance_', ''), 10);
    
    // Answer callback immediately
    await bot.answerCallbackQuery(callbackQuery.id);
    
    try {
        const { getPositionClaimBeforeRebalanceStatus } = await import('../../services/position.service.js');
        const currentEnabled = await getPositionClaimBeforeRebalanceStatus(positionId);
        
        const currentEmoji = currentEnabled ? '💰✅' : '💰❌';
        const newStatus = currentEnabled ? 'disabled' : 'enabled';
        const actionEmoji = currentEnabled ? '❌' : '✅';
        
        // Show explanation and confirmation menu
        await bot.sendMessage(chatId,
            `💰 *Claim-Before-Rebalance*\n\n` +
            `*Current Status:* ${currentEmoji} ${currentEnabled ? 'Enabled' : 'Disabled'}\n\n` +
            `*What it does:*\n` +
            `• Claims all accumulated rewards (fees + incentives) before executing a rebalance\n` +
            `• Applies to both manual /rebalance and auto-rebalance\n` +
            `• Transfers rewards to your claim address (or keeps in wallet if not set)\n` +
            `• Re-checks if rebalance is still needed after claiming\n\n` +
            `*Benefits:*\n` +
            `• Maximizes reward collection\n` +
            `• Prevents losing unclaimed rewards on position close\n` +
            `• Automatic and hands-free\n\n` +
            `*Cost:*\n` +
            `• +1 transaction (~$0.50-1.00 in network fees)\n\n` +
            `*Note:* If claim fails, rebalance continues anyway.\n\n` +
            `Would you like to ${newStatus} claim-before-rebalance for this position?`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: `${actionEmoji} ${newStatus.charAt(0).toUpperCase() + newStatus.slice(1)} Claim-Before-Rebalance`,
                                callback_data: `toggle_claim_before_rebalance_confirm_${positionId}`
                            }
                        ],
                        [
                            { text: '❌ Cancel', callback_data: 'positions' }
                        ]
                    ]
                }
            }
        );
        
    } catch (error) {
        console.error('Error showing claim-before-rebalance menu:', error);
        await bot.sendMessage(chatId,
            `❌ *Error*\n\n${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Handle link previous stats callback
 * 
 * Carries over statistics from a closed position to a new position.
 * This is useful when users close and reopen positions outside the bot.
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleLinkPreviousStats(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    // Handle prompt to select closed position: link_stats_prompt_{newPositionId}
    if (data.startsWith('link_stats_prompt_')) {
        const newPositionId = parseInt(data.replace('link_stats_prompt_', ''), 10);
        
        // Answer callback immediately
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '🔍 Searching for closed positions...'
        });

        try {
            // Get current position
            const newPosResult = await db.select()
                .from(positionsTable)
                .where(eq(positionsTable.id, newPositionId))
                .limit(1);
            
            if (!newPosResult[0]) {
                await bot.sendMessage(chatId, '❌ Position not found.', { parse_mode: 'Markdown' });
                return;
            }

            const newPosition = newPosResult[0];
            const poolAddress = newPosition.pool_address;

            // Find closed positions from the same pool
            const closedPositions = await db.select()
                .from(positionsTable)
                .where(eq(positionsTable.wallet_id, newPosition.wallet_id))
                .where(eq(positionsTable.pool_address, poolAddress))
                .where(eq(positionsTable.status, 'closed'))
                .orderBy(desc(positionsTable.updated_at))
                .limit(10);
            
            if (closedPositions.length === 0) {
                await bot.sendMessage(chatId,
                    `❌ *No Closed Positions Found*\n\n` +
                    `No closed positions found for this pool.\n\n` +
                    `The Link Previous Stats feature copies statistics from previously closed positions in the same pool.`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // Filter to only positions with statistics
            const closedWithStats = [];
            for (const closedPos of closedPositions) {
                const stats = await getPositionStatistics(closedPos.id);
                if (stats) {
                    closedWithStats.push({ position: closedPos, stats });
                }
            }

            if (closedWithStats.length === 0) {
                await bot.sendMessage(chatId,
                    `❌ *No Statistics Found*\n\n` +
                    `Found ${closedPositions.length} closed position(s), but none have statistics to carry over.`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // If only one option, link it directly
            if (closedWithStats.length === 1) {
                const oldPositionId = closedWithStats[0].position.id;
                await carryOverStatistics(oldPositionId, newPositionId);
                await sendLinkSuccessMessage(bot, chatId, closedWithStats[0].position, newPosition, closedWithStats[0].stats);
                await handlePositionsRefresh(bot, callbackQuery);
                return;
            }

            // Multiple options - show selection
            let message = `📊 *Select Position to Link*\n\n` +
                `Found ${closedWithStats.length} closed position(s) with statistics.\n\n` +
                `Select which one to link to your current position:\n\n`;

            const keyboard = { inline_keyboard: [] };

            for (let i = 0; i < Math.min(closedWithStats.length, 5); i++) {
                const { position: closedPos, stats } = closedWithStats[i];
                const totalTimeMs = stats.time_in_range_ms + stats.time_out_of_range_ms;
                const totalHours = (totalTimeMs / (1000 * 60 * 60)).toFixed(1);
                const netPnl = (stats.total_fees_earned_usd + stats.total_compounded_usd) - stats.total_rebalance_cost_usd;
                
                // Format closed time
                const closedDate = new Date(closedPos.updated_at);
                const now = new Date();
                const timeDiff = now - closedDate;
                const daysAgo = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
                const hoursAgo = Math.floor(timeDiff / (1000 * 60 * 60));
                
                let timeAgoStr;
                if (daysAgo > 0) {
                    timeAgoStr = `${daysAgo}d ago`;
                } else if (hoursAgo > 0) {
                    timeAgoStr = `${hoursAgo}h ago`;
                } else {
                    timeAgoStr = 'now';
                }
                
                message += `*${i + 1}.* \`${closedPos.nft_mint.slice(0, 8)}...${closedPos.nft_mint.slice(-8)}\`\n` +
                    `   Closed: ${timeAgoStr} | Time: ${totalHours}h | P&L: ${formatCurrency(netPnl)}\n`;

                keyboard.inline_keyboard.push([{
                    text: `${i + 1}. ${closedPos.nft_mint.slice(0, 8)}... (${timeAgoStr}, ${totalHours}h)`,
                    callback_data: `link_stats_${newPositionId}_${closedPos.id}`
                }]);
            }

            keyboard.inline_keyboard.push([{ text: '❌ Cancel', callback_data: 'positions' }]);

            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (error) {
            console.error('Error in link stats prompt:', error);
            await bot.sendMessage(chatId,
                `❌ *Error*\n\n${error.message}`,
                { parse_mode: 'Markdown' }
            );
        }
        return;
    }

    // Handle direct link: link_stats_{newPositionId}_{oldPositionId}
    const match = data.match(/^link_stats_(\d+)_(\d+)$/);
    if (!match) {
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Invalid callback data',
            show_alert: true
        });
        return;
    }

    const newPositionId = parseInt(match[1], 10);
    const oldPositionId = parseInt(match[2], 10);

    // Answer callback immediately
    await bot.answerCallbackQuery(callbackQuery.id, {
        text: '🔄 Linking statistics...'
    });

    try {
        // Get both positions to show user what's being linked
        const [oldPos, newPos] = await Promise.all([
            db.select().from(positionsTable).where(eq(positionsTable.id, oldPositionId)).limit(1),
            db.select().from(positionsTable).where(eq(positionsTable.id, newPositionId)).limit(1)
        ]);

        if (!oldPos[0] || !newPos[0]) {
            await bot.sendMessage(chatId,
                `❌ *Position Not Found*\n\n` +
                `Could not find the positions to link statistics.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const oldPosition = oldPos[0];
        const newPosition = newPos[0];

        // Get old statistics to show what's being carried over
        const oldStats = await getPositionStatistics(oldPositionId);
        if (!oldStats) {
            await bot.sendMessage(chatId,
                `❌ *No Statistics Found*\n\n` +
                `The closed position has no statistics to carry over.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Perform the carryover
        await carryOverStatistics(oldPositionId, newPositionId);

        // Send success message
        await sendLinkSuccessMessage(bot, chatId, oldPosition, newPosition, oldStats);

        // Refresh positions
        await handlePositionsRefresh(bot, callbackQuery);

    } catch (error) {
        console.error('Error linking previous stats:', error);
        
        await bot.sendMessage(chatId,
            `❌ *Failed to Link Statistics*\n\n` +
            `An error occurred while linking statistics:\n` +
            `${error.message}\n\n` +
            `Please try again or contact support.`,
            { parse_mode: 'Markdown' }
        );
    }
}

/**
 * Helper function to send link success message
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {number} chatId - Chat ID
 * @param {Object} oldPosition - Old position object
 * @param {Object} newPosition - New position object
 * @param {Object} oldStats - Old statistics object
 */
async function sendLinkSuccessMessage(bot, chatId, oldPosition, newPosition, oldStats) {
    // Calculate some metrics to show user
    const totalTimeMs = oldStats.time_in_range_ms + oldStats.time_out_of_range_ms;
    const timeInRangePct = totalTimeMs > 0 
        ? ((oldStats.time_in_range_ms / totalTimeMs) * 100).toFixed(1) 
        : '0.0';
    
    const totalHours = (totalTimeMs / (1000 * 60 * 60)).toFixed(1);
    const netPnl = (oldStats.total_fees_earned_usd + oldStats.total_compounded_usd) - 
                   oldStats.total_rebalance_cost_usd;

    // Format closed position timestamp
    const closedDate = new Date(oldPosition.updated_at);
    const now = new Date();
    const timeDiff = now - closedDate;
    const daysAgo = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
    const hoursAgo = Math.floor(timeDiff / (1000 * 60 * 60));
    
    let timeAgoStr;
    if (daysAgo > 0) {
        timeAgoStr = `${daysAgo} day${daysAgo > 1 ? 's' : ''} ago`;
    } else if (hoursAgo > 0) {
        timeAgoStr = `${hoursAgo} hour${hoursAgo > 1 ? 's' : ''} ago`;
    } else {
        timeAgoStr = 'just now';
    }
    
    const closedDateStr = closedDate.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    // Build success message
    let message = `✅ *Statistics Linked Successfully!*\n\n` +
        `*From:* \`${oldPosition.nft_mint.slice(0, 8)}...${oldPosition.nft_mint.slice(-8)}\` (closed)\n` +
        `*Closed:* ${closedDateStr} (${timeAgoStr})\n` +
        `*To:* \`${newPosition.nft_mint.slice(0, 8)}...${newPosition.nft_mint.slice(-8)}\` (active)\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `*Carried Over:*\n\n`;

    // Time tracking
    if (totalTimeMs > 0) {
        message += `⏱ *Time Tracking:*\n` +
            `• Total: ${totalHours}h\n` +
            `• In Range: ${timeInRangePct}%\n\n`;
    }

    // Rebalance history
    if (oldStats.rebalances_count_lifetime > 0) {
        message += `⚖️ *Rebalance History:*\n` +
            `• Lifetime: ${oldStats.rebalances_count_lifetime}\n` +
            `• Today: ${oldStats.rebalances_today}\n` +
            `• Total Cost: ${formatCurrency(oldStats.total_rebalance_cost_usd)}\n\n`;
    }

    // Financial tracking
    if (oldStats.total_fees_earned_usd > 0 || oldStats.total_compounded_usd > 0) {
        message += `💰 *Financial History:*\n`;
        if (oldStats.total_fees_earned_usd > 0) {
            message += `• Fees Earned: ${formatCurrency(oldStats.total_fees_earned_usd)}\n`;
        }
        if (oldStats.total_compounded_usd > 0) {
            message += `• Compounded: ${formatCurrency(oldStats.total_compounded_usd)}\n`;
        }
        message += `• Net P&L: ${formatCurrency(netPnl)}\n\n`;
    }

    // Mode state
    if (oldStats.current_mode) {
        message += `🎯 *Mode State:*\n` +
            `• Mode: ${oldStats.current_mode}\n` +
            `• Active Width: ${(oldStats.active_width_pct * 100).toFixed(1)}%\n` +
            `• Guard Width: ${(oldStats.guard_width_pct * 100).toFixed(1)}%\n\n`;
    }

    message += `✨ *Your position history is now continuous!*`;

    await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📊 View Positions', callback_data: 'positions' }]
            ]
        }
    });
}

