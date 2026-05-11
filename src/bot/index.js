import TelegramBot from 'node-telegram-bot-api';
import { env } from '../config/env.js';
import { handleStart } from './handlers/start.handler.js';
import { handleHelp } from './handlers/help.handler.js';
import { handleRewards, handleRewardsRefresh, handleRewardsResetStats } from './handlers/rewards.handler.js';
import { handleNewWallet, handleNewWalletCallback } from './handlers/newwallet.handler.js';
import { handleImportWallet, handlePrivateKeyMessage, hasPendingImport, cancelPendingImport, handleEvmAddressMessage, hasPendingEvmImport, cancelPendingEvmImport, showImportInstructions, showEvmImportInstructions } from './handlers/importwallet.handler.js';
import { handleWalletInfo, handleBalance, handleWalletsList, handleEditLabelCallback, handleLabelMessage, hasPendingLabelEdit, clearPendingLabelEdit, handleToggleSplitCallback, handleDeleteWalletPrompt, handleConfirmDeleteWallet, handleCancelDeleteWallet } from './handlers/walletinfo.handler.js';
import { handleExportKey, handleExportKeyCallback } from './handlers/exportkey.handler.js';
import { handleAuditLog, handleWalletAudit } from './handlers/auditlog.handler.js';
import { switchActiveWallet, getWalletById } from '../services/wallet.service.js';
import { formatShortAddress } from '../utils/format.util.js';
import { isEvmWallet } from '../utils/evm.util.js';
import { handleClaim, handleClaimCallback } from './handlers/claim.handler.js';
import { handleCompound, handleCompoundCallback } from './handlers/compound.handler.js';
import { handlePositions, handlePositionsRefresh, handleClosePositionCallback, handleConfirmClosePosition, handleLinkPreviousStats, handleToggleAutoRebalance, handleToggleClaimBeforeRebalance } from './handlers/positions.handler.js';
import { handleProximity, handleProximitySelect, handleProximitySetThreshold } from './handlers/proximity.handler.js';
import { handleAddPosition, handleAddPositionMessage, hasPendingAddPosition, cancelPendingAddPosition, handleAddPositionCallback } from './handlers/addposition.handler.js';
import { handleTopUpCallback, handleTopUpMessage, hasPendingTopUp, cancelPendingTopUp } from './handlers/topup.handler.js';
import { handleRebalance, handleRebalanceCallback, handleRebalanceRetryCallback, handleAddMoreLiquidityCallback, handleRebalanceNewRangeCallback, handleRebalanceRangeMessage, hasPendingRebalanceRange, clearPendingRebalanceRange } from './handlers/rebalance.handler.js';
import { handleStats, handleStatsRefresh } from './handlers/stats.handler.js';
import { handleSetClaimAddressCallback, handleClaimAddressMessage, hasPendingClaimAddress, clearPendingClaimAddress } from './handlers/set-claim-address.handler.js';
import { startMonitoring as startSchedulerMonitoring, startDailyResetJob, startIdleFundsRecoveryJob, startAprHistoryJob, initializeMarketData, startEvmOutOfRangeJob } from '../services/scheduler.service.js';
import { POSITION_MONITOR_INTERVAL_MS } from '../config/constants.js';
import { resolveWalletButton, resolveWalletButtonAsync, buildWalletKeyboard } from './keyboard.util.js';

/**
 * Initializes and starts the Telegram bot
 */
export async function startBot() {
    const token = env.TELEGRAM_BOT_TOKEN;

    if (!token) {
        throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
    }

    // Step 1: Delete any existing webhook that might block polling
    if (process.env.LOG_LEVEL === 'debug') {
        console.log('🔍 Step 1/3: Clearing webhooks...');
    }
    try {
        const https = await import('https');
        const deleteWebhookUrl = `https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`;

        await new Promise((resolve, reject) => {
            https.get(deleteWebhookUrl, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const result = JSON.parse(data);
                    if (result.ok) {
                        if (process.env.LOG_LEVEL === 'debug') {
                            console.log('   ✅ Webhook cleared');
                        }
                    } else {
                        if (process.env.LOG_LEVEL === 'debug') {
                            console.log('   ⚠️  Response:', result.description);
                        }
                    }
                    resolve();
                });
            }).on('error', reject);
        });
    } catch (error) {
        console.error('   ⚠️  Error:', error.message);
    }

    // Step 2: CRITICAL - Explicitly register allowed_updates with Telegram
    // This tells Telegram's servers what update types we want to receive
    if (process.env.LOG_LEVEL === 'debug') {
        console.log('🔧 Step 2/3: Registering allowed_updates with Telegram...');
    }
    try {
        const https = await import('https');
        // Use getUpdates with offset=-1 to register our allowed_updates without consuming updates
        const registerUrl = `https://api.telegram.org/bot${token}/getUpdates?offset=-1&allowed_updates=["message","callback_query"]`;

        await new Promise((resolve, reject) => {
            https.get(registerUrl, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const result = JSON.parse(data);
                    if (result.ok) {
                        if (process.env.LOG_LEVEL === 'debug') {
                            console.log('   ✅ Registered: message, callback_query');
                        }
                    } else {
                        if (process.env.LOG_LEVEL === 'debug') {
                            console.log('   ⚠️  Response:', result.description);
                        }
                    }
                    resolve();
                });
            }).on('error', reject);
        });
    } catch (error) {
        console.error('   ⚠️  Error:', error.message);
    }

    // Step 3: Create bot with simple polling config
    if (process.env.LOG_LEVEL === 'debug') {
        console.log('🤖 Step 3/3: Starting bot polling...');
    }
    const bot = new TelegramBot(token, {
        polling: true
    });

    if (process.env.LOG_LEVEL === 'debug') {
        console.log('✅ Bot is ready and polling for updates!');
    }

    // Initialize market data system
    // Starts Jupiter WebSocket for real-time SOL/CAKE prices
    // Also backfills price candle history for TWAP/ATR calculations
    try {
        await initializeMarketData();
    } catch (err) {
        console.error('Failed to initialize market data:', err?.message || err);
    }

    // Start background monitoring
    // Alerts (out-of-range, proximity, back-in-range) are sent to position owners
    // Now also collects market data every 30s automatically
    try {
        startSchedulerMonitoring(bot, {
            intervalMs: POSITION_MONITOR_INTERVAL_MS
        });
        if (process.env.LOG_LEVEL === 'debug') {
            console.log(`🕒 Background monitoring started (${POSITION_MONITOR_INTERVAL_MS / 1000}s intervals).`);
        }
    } catch (err) {
        console.error('Failed to start background monitoring:', err?.message || err);
    }

    // Start daily reset job for rebalance counters
    // Resets `rebalances_today` at UTC midnight (enforces daily cap from automation plan)
    try {
        startDailyResetJob();
    } catch (err) {
        console.error('Failed to start daily reset job:', err?.message || err);
    }

    // Start idle funds recovery job
    // Recovers funds stuck in wallets after failed rebalances
    try {
        startIdleFundsRecoveryJob(bot);
    } catch (err) {
        console.error('Failed to start idle funds recovery job:', err?.message || err);
    }

    // Start APR history recording job
    // Records APR snapshots every 4 hours for daily/monthly averages
    try {
        startAprHistoryJob();
    } catch (err) {
        console.error('Failed to start APR history job:', err?.message || err);
    }

    // Start EVM out-of-range monitor job
    // Checks every 5 minutes if any EVM wallet positions are out of range
    try {
        startEvmOutOfRangeJob(bot);
    } catch (err) {
        console.error('Failed to start EVM out-of-range monitor:', err?.message || err);
    }

    // Handle /start command
    bot.onText(/\/start/, (msg) => {
        handleStart(bot, msg);
    });

    // Handle /help command
    bot.onText(/\/help/, (msg) => {
        handleHelp(bot, msg);
    });

    // Handle /rewards command (no longer requires arguments)
    bot.onText(/\/rewards/, (msg) => {
        handleRewards(bot, msg);
    });

    // Handle /newwallet command
    bot.onText(/\/newwallet/, (msg) => {
        handleNewWallet(bot, msg);
    });

    // Handle /importwallet command
    bot.onText(/\/importwallet/, (msg) => {
        handleImportWallet(bot, msg);
    });

    // Handle /wallet command
    bot.onText(/\/wallet$/, (msg) => {
        handleWalletInfo(bot, msg);
    });

    // Handle /wallets command
    bot.onText(/\/wallets/, (msg) => {
        handleWalletsList(bot, msg);
    });

    // Handle /balance command
    bot.onText(/\/balance/, (msg) => {
        handleBalance(bot, msg);
    });

    // Handle /exportkey command
    bot.onText(/\/exportkey/, (msg) => {
        handleExportKey(bot, msg);
    });

    // Handle /auditlog command
    bot.onText(/\/auditlog/, (msg) => {
        handleAuditLog(bot, msg);
    });

    // Handle /walletaudit command
    bot.onText(/\/walletaudit/, (msg) => {
        handleWalletAudit(bot, msg);
    });

    // Handle /claim command
    bot.onText(/\/claim(.*)/, (msg, match) => {
        const args = match[1].trim().split(/\s+/).filter(arg => arg.length > 0);
        handleClaim(bot, msg, args);
    });

    // Handle /compound command
    bot.onText(/\/compound(.*)/, (msg, match) => {
        const args = match[1].trim().split(/\s+/).filter(arg => arg.length > 0);
        handleCompound(bot, msg, args);
    });

    // Handle /positions command
    bot.onText(/\/positions/, (msg) => {
        handlePositions(bot, msg);
    });

    // Handle /proximity command
    bot.onText(/\/proximity/, (msg) => {
        handleProximity(bot, msg);
    });

    // Handle /addposition command
    bot.onText(/\/addposition/, (msg) => {
        handleAddPosition(bot, msg);
    });

    // Handle /rebalance command
    bot.onText(/\/rebalance(.*)/, (msg, match) => {
        const args = match[1].trim().split(/\s+/).filter(arg => arg.length > 0);
        handleRebalance(bot, msg, args);
    });

    // Handle /stats command
    bot.onText(/\/stats/, (msg) => {
        handleStats(bot, msg);
    });

    // Handle /cancel command
    bot.onText(/\/cancel/, async (msg) => {
        const telegramId = msg.from.id;
        let cancelled = false;

        if (hasPendingImport(telegramId)) {
            cancelPendingImport(telegramId);
            cancelled = true;
        }

        if (hasPendingEvmImport(telegramId)) {
            cancelPendingEvmImport(telegramId);
            cancelled = true;
        }

        if (hasPendingLabelEdit(telegramId)) {
            clearPendingLabelEdit(telegramId);
            cancelled = true;
        }

        if (hasPendingAddPosition(telegramId)) {
            cancelPendingAddPosition(telegramId);
            cancelled = true;
        }

        if (hasPendingTopUp(telegramId)) {
            cancelPendingTopUp(telegramId);
            cancelled = true;
        }

        if (hasPendingClaimAddress(telegramId)) {
            clearPendingClaimAddress(telegramId);
            cancelled = true;
        }

        if (hasPendingRebalanceRange(telegramId)) {
            clearPendingRebalanceRange(telegramId);
            cancelled = true;
        }

        // Try to rebuild wallet keyboard or remove any temporary keyboard
        let replyMarkup = { remove_keyboard: true };
        try {
            const keyboard = await buildWalletKeyboard(telegramId);
            if (keyboard) replyMarkup = keyboard;
        } catch (_) {
            // keep remove_keyboard fallback
        }

        if (cancelled) {
            await bot.sendMessage(
                msg.chat.id,
                '✅ Operation cancelled.',
                { parse_mode: 'Markdown', reply_markup: replyMarkup }
            );
        } else {
            await bot.sendMessage(
                msg.chat.id,
                'Nothing to cancel.',
                { parse_mode: 'Markdown', reply_markup: replyMarkup }
            );
        }
    });

    // Handle button callbacks
    bot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;

        // Handle import type selection (Solana vs EVM)
        if (data === 'import_solana') {
            await bot.answerCallbackQuery(callbackQuery.id);
            await showImportInstructions(bot, chatId, callbackQuery.from.id);
            return;
        }
        if (data === 'import_evm') {
            await bot.answerCallbackQuery(callbackQuery.id);
            await showEvmImportInstructions(bot, chatId, callbackQuery.from.id);
            return;
        }

        // Handle exportkey callbacks
        if (data.startsWith('exportkey_')) {
            handleExportKeyCallback(bot, callbackQuery);
            return;
        }

        // Handle newwallet callbacks
        if (data.startsWith('newwallet_')) {
            handleNewWalletCallback(bot, callbackQuery);
            return;
        }

        // Handle wallet switching callbacks
        if (data.startsWith('switch_wallet_')) {
            const walletId = parseInt(data.replace('switch_wallet_', ''));
            const telegramId = callbackQuery.from.id;

            try {
                const newActiveWallet = await switchActiveWallet(telegramId, walletId);
                const isEvm = isEvmWallet(newActiveWallet.wallet_address);

                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: `✅ Switched to ${newActiveWallet.label}`
                });

                const shortAddress = formatShortAddress(newActiveWallet.wallet_address);

                if (isEvm) {
                    await bot.editMessageText(
                        `✅ *Active Wallet Changed*\n\n` +
                        `Now using: *${newActiveWallet.label}* 🔷\n` +
                        `Address: \`${shortAddress}\`\n\n` +
                        `_Read-only EVM wallet_\n\n` +
                        `• /wallet - View wallet details\n` +
                        `• /balance - Check ETH balance\n\n` +
                        `Use /wallets to view all wallets.`,
                        {
                            chat_id: chatId,
                            message_id: callbackQuery.message.message_id,
                            parse_mode: 'Markdown'
                        }
                    );

                    const keyboard = await buildWalletKeyboard(telegramId);
                    if (keyboard) {
                        await bot.sendMessage(chatId, '💼 *Loading positions...*', {
                            parse_mode: 'Markdown',
                            reply_markup: keyboard
                        });
                    }

                    const syntheticMsg = { chat: { id: chatId }, from: { id: telegramId } };
                    await handlePositions(bot, syntheticMsg);
                } else {
                    await bot.editMessageText(
                        `✅ *Active Wallet Changed*\n\n` +
                        `Now using: *${newActiveWallet.label}*\n` +
                        `Address: \`${shortAddress}\`\n\n` +
                        `*What this means:*\n` +
                        `• /rewards will show rewards for this wallet\n` +
                        `• /positions will show this wallet's positions\n` +
                        `• All operations will use this wallet\n\n` +
                        `Use /wallets to view all wallets or /wallet to see details.`,
                        {
                            chat_id: chatId,
                            message_id: callbackQuery.message.message_id,
                            parse_mode: 'Markdown'
                        }
                    );

                    const keyboard = await buildWalletKeyboard(telegramId);
                    if (keyboard) {
                        await bot.sendMessage(chatId, '💼 *Loading positions...*', {
                            parse_mode: 'Markdown',
                            reply_markup: keyboard
                        });
                    }

                    const syntheticMsg = { chat: { id: chatId }, from: { id: telegramId } };
                    await handlePositions(bot, syntheticMsg);
                }

            } catch (error) {
                console.error('Error switching wallet:', error);

                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: `❌ Failed to switch wallet: ${error.message}`,
                    show_alert: true
                });
            }
            return;
        }

        // Handle edit wallet label callbacks
        if (data.startsWith('edit_wallet_label_')) {
            handleEditLabelCallback(bot, callbackQuery);
            return;
        }

        // Handle toggle split strategy callbacks
        if (data.startsWith('toggle_split_')) {
            handleToggleSplitCallback(bot, callbackQuery);
            return;
        }

        // Handle delete wallet prompt
        if (data.startsWith('delete_wallet_')) {
            handleDeleteWalletPrompt(bot, callbackQuery);
            return;
        }

        // Handle confirm wallet deletion
        if (data.startsWith('confirm_delete_wallet_')) {
            handleConfirmDeleteWallet(bot, callbackQuery);
            return;
        }

        // Handle cancel delete wallet
        if (data === 'cancel_delete_wallet') {
            handleCancelDeleteWallet(bot, callbackQuery);
            return;
        }

        // Handle set claim address callback
        if (data === 'set_claim_address') {
            handleSetClaimAddressCallback(bot, callbackQuery);
            return;
        }

        // Handle quick rewards button
        if (data === 'quick_rewards') {
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handleRewards(bot, syntheticMsg);
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        // Handle quick positions button
        if (data === 'quick_positions') {
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handlePositions(bot, syntheticMsg);
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        // Handle claim callbacks
        if (data.startsWith('claim_')) {
            handleClaimCallback(bot, callbackQuery);
            return;
        }

        // Handle compound callbacks
        if (data.startsWith('compound_')) {
            handleCompoundCallback(bot, callbackQuery);
            return;
        }

        // Handle rebalance callbacks (start)
        if (data.startsWith('rebalance_') && !data.startsWith('rebalance_retry_') && !data.startsWith('rebalance_newrange_')) {
            handleRebalanceCallback(bot, callbackQuery);
            return;
        }

        // Handle rebalance with new range callback
        if (data.startsWith('rebalance_newrange_')) {
            handleRebalanceNewRangeCallback(bot, callbackQuery);
            return;
        }

        // Handle rebalance retry callback
        if (data.startsWith('rebalance_retry_')) {
            handleRebalanceRetryCallback(bot, callbackQuery);
            return;
        }

        // Handle add more liquidity callback (from rebalance)
        if (data.startsWith('addliq_')) {
            handleAddMoreLiquidityCallback(bot, callbackQuery);
            return;
        }

        // Handle positions refresh callback
        if (data === 'positions_refresh') {
            handlePositionsRefresh(bot, callbackQuery);
            return;
        }
        // Handle pool ticker buttons (no-op for now)
        if (data.startsWith('pool_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '📊 Pool filters coming soon' });
            return;
        }
        // Handle toggle proximity in positions list
        if (data.startsWith('toggle_proximity_')) {
            const { handleToggleProximity } = await import('./handlers/positions.handler.js');
            handleToggleProximity(bot, callbackQuery);
            return;
        }

        // Handle proximity setup callbacks
        if (data.startsWith('proximity_select_')) {
            handleProximitySelect(bot, callbackQuery);
            return;
        }
        if (data.startsWith('proximity_threshold_')) {
            handleProximitySetThreshold(bot, callbackQuery);
            return;
        }
        if (data.startsWith('proximity_disable_')) {
            const { setProximityEnabled } = await import('../services/alert.service.js');
            const positionId = parseInt(data.replace('proximity_disable_', ''));
            try {
                await setProximityEnabled(positionId, false);
                await bot.answerCallbackQuery(callbackQuery.id, { text: '🔕 Proximity off' });
            } catch (err) {
                await bot.answerCallbackQuery(callbackQuery.id, { text: `❌ ${err?.message || err}` });
            }
            return;
        }

        // Handle rewards refresh callback
        if (data === 'rewards_refresh') {
            handleRewardsRefresh(bot, callbackQuery);
            return;
        }

        // Handle rewards reset stats callback
        if (data === 'rewards_reset_stats') {
            handleRewardsResetStats(bot, callbackQuery);
            return;
        }

        // Handle stats refresh callback
        if (data === 'stats_refresh') {
            handleStatsRefresh(bot, callbackQuery);
            return;
        }

        // Handle stats callback (from buttons)
        if (data === 'stats') {
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handleStats(bot, syntheticMsg);
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        // Handle per-position alert toggle
        if (data.startsWith('toggle_alerts_')) {
            const { handleToggleAlerts } = await import('./handlers/positions.handler.js');
            handleToggleAlerts(bot, callbackQuery);
            return;
        }

        // Handle auto-rebalance toggle (initial, confirmation, info, and claim toggle within menu)
        if (data.startsWith('toggle_autorebalance_') || data.startsWith('autorebalance_info_') || data.startsWith('toggle_claim_in_autorebalance_')) {
            handleToggleAutoRebalance(bot, callbackQuery);
            return;
        }

        // Handle standalone claim-before-rebalance toggle (initial and confirmation)
        if (data.startsWith('toggle_claim_before_rebalance_')) {
            handleToggleClaimBeforeRebalance(bot, callbackQuery);
            return;
        }

        // Handle position rewards callback
        if (data.startsWith('position_rewards_')) {
            // Answer the callback query first
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '💰 Checking rewards...'
            });
            
            // Create synthetic message to call rewards handler
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handleRewards(bot, syntheticMsg);
            return;
        }

        // Handle close position callback (shows confirmation)
        if (data.startsWith('position_close_')) {
            handleClosePositionCallback(bot, callbackQuery);
            return;
        }

        // Handle confirm close position callback (executes transaction)
        if (data.startsWith('confirm_close_')) {
            handleConfirmClosePosition(bot, callbackQuery);
            return;
        }

        // Handle cancel close position callback
        if (data === 'cancel_close') {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '✅ Cancelled'
            });
            
            try {
                await bot.editMessageText(
                    '❌ Position close cancelled.',
                    {
                        chat_id: chatId,
                        message_id: callbackQuery.message.message_id,
                        parse_mode: 'Markdown'
                    }
                );
            } catch (error) {
                // Ignore - message may already be deleted
            }
            return;
        }

        // Handle link previous stats callbacks (both prompt and direct)
        if (data.startsWith('link_stats_')) {
            handleLinkPreviousStats(bot, callbackQuery);
            return;
        }

        if (data.startsWith('position_details_')) {
            bot.answerCallbackQuery(callbackQuery.id, {
                text: '📊 Position details feature coming soon!',
                show_alert: true
            });
        } else if (data === 'no_rewards') {
            bot.answerCallbackQuery(callbackQuery.id, {
                text: '✅ No rewards available to claim',
                show_alert: false
            });
            return;
        }

        // Handle simple command callbacks
        if (data === 'balance') {
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handleBalance(bot, syntheticMsg);
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        if (data === 'rewards') {
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handleRewards(bot, syntheticMsg);
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        if (data === 'newwallet') {
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handleNewWallet(bot, syntheticMsg);
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        if (data === 'importwallet') {
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handleImportWallet(bot, syntheticMsg);
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        if (data === 'help') {
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handleHelp(bot, syntheticMsg);
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        if (data === 'positions') {
            // Delete the current menu message (if it exists)
            try {
                await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            } catch (error) {
                // Ignore - message may already be deleted
            }
            
            // Show positions list
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            await handlePositions(bot, syntheticMsg);
            await bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        if (data === 'wallets') {
            const syntheticMsg = {
                chat: { id: chatId },
                from: { id: callbackQuery.from.id }
            };
            handleWalletsList(bot, syntheticMsg);
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }

        if (data === 'addposition') {
            handleAddPositionCallback(bot, callbackQuery);
            return;
        }
        
        // Handle addposition retry callback (same settings)
        if (data === 'addposition_retry') {
            const { handleAddPositionRetry } = await import('./handlers/addposition.handler.js');
            handleAddPositionRetry(bot, callbackQuery);
            return;
        }

        // Handle addposition pool quick-select callbacks
        if (data.startsWith('addposition_pool_')) {
            const { handleAddPositionPoolSelect } = await import('./handlers/addposition.handler.js');
            handleAddPositionPoolSelect(bot, callbackQuery);
            return;
        }

        // Handle addposition cancel callback
        if (data === 'addposition_cancel') {
            const { handleAddPositionCancel } = await import('./handlers/addposition.handler.js');
            handleAddPositionCancel(bot, callbackQuery);
            return;
        }

        // Handle topup callback
        if (data.startsWith('topup_')) {
            handleTopUpCallback(bot, callbackQuery);
            return;
        }

        // Handle other callbacks
        if (data === 'no_rewards') {
            bot.answerCallbackQuery(callbackQuery.id, {
                text: '✅ No rewards available to claim',
                show_alert: false
            });
        } else if (data.startsWith('positions_')) {
            bot.answerCallbackQuery(callbackQuery.id, {
                text: '📊 Positions feature coming soon!',
                show_alert: true
            });
        } else {
            if (process.env.LOG_LEVEL === 'debug') {
                console.log('⚠️ Unknown callback data:', data);
            }
        }
    });

    // Handle general messages (for private key import, label editing, wallet button taps)
    bot.on('message', async (msg) => {
        const telegramId = msg.from.id;

        // Check if user has pending wallet import
        if (hasPendingImport(telegramId) && msg.text && !msg.text.startsWith('/')) {
            handlePrivateKeyMessage(bot, msg);
            return;
        }

        // Check if user has pending EVM wallet import
        if (hasPendingEvmImport(telegramId) && msg.text && !msg.text.startsWith('/')) {
            handleEvmAddressMessage(bot, msg);
            return;
        }

        // Check if user has pending label edit
        if (hasPendingLabelEdit(telegramId) && msg.text && !msg.text.startsWith('/')) {
            handleLabelMessage(bot, msg);
            return;
        }

        // Check if user has pending add position operation
        if (hasPendingAddPosition(telegramId) && msg.text && !msg.text.startsWith('/')) {
            handleAddPositionMessage(bot, msg);
            return;
        }

        // Check if user has pending top-up operation
        if (hasPendingTopUp(telegramId) && msg.text && !msg.text.startsWith('/')) {
            handleTopUpMessage(bot, msg);
            return;
        }

        // Check if user has pending claim address operation
        if (hasPendingClaimAddress(telegramId) && msg.text && !msg.text.startsWith('/')) {
            handleClaimAddressMessage(bot, msg);
            return;
        }

        // Check if user has pending rebalance range input
        if (hasPendingRebalanceRange(telegramId) && msg.text && !msg.text.startsWith('/')) {
            handleRebalanceRangeMessage(bot, msg);
            return;
        }

        // Handle pool reply-keyboard taps and wallet reply-keyboard taps (non-command plain text)
        if (msg.text && !msg.text.startsWith('/')) {
            // If it's a pool label tap or LPs reset, handle filter
            try {
                const text = msg.text.trim();
                // crude detection: label like "SOL-USDC" contains '-'
                if (text === '💧LPs') {
                    // Clear filter and show all
                    const syntheticMsg = { chat: { id: msg.chat.id }, from: { id: msg.from.id } };
                    const { handlePositions, clearSelectedPoolFilter } = await import('./handlers/positions.handler.js');
                    clearSelectedPoolFilter(msg.chat.id);
                    await handlePositions(bot, syntheticMsg);
                    return;
                }
                if (/^[A-Za-z0-9.]+-[A-Za-z0-9.]+$/.test(text)) {
                    await bot.sendChatAction(msg.chat.id, 'typing');
                    // Trigger positions with filter (keep keyboard persistent)
                    const syntheticMsg = { chat: { id: msg.chat.id }, from: { id: msg.from.id } };
                    const { handlePositions } = await import('./handlers/positions.handler.js');
                    await handlePositions(bot, syntheticMsg, { poolLabel: text });
                    return;
                }
            } catch (_) {}

            let walletId = resolveWalletButton(telegramId, msg.text.trim());
            if (!walletId) {
                walletId = await resolveWalletButtonAsync(telegramId, msg.text.trim());
            }
            if (walletId) {
                try {
                    const newActiveWallet = await switchActiveWallet(telegramId, walletId);
                    const shortAddress = formatShortAddress(newActiveWallet.wallet_address);
                    const isEvm = isEvmWallet(newActiveWallet.wallet_address);

                    if (isEvm) {
                        await bot.sendMessage(
                            msg.chat.id,
                            `✅ Switched active wallet to *${newActiveWallet.label}* 🔷 (\`${shortAddress}\`)\n\n_Read-only EVM wallet_`,
                            { parse_mode: 'Markdown' }
                        );

                        const keyboard = await buildWalletKeyboard(telegramId);
                        if (keyboard) {
                            await bot.sendMessage(msg.chat.id, '💼 *Loading positions...*', {
                                parse_mode: 'Markdown',
                                reply_markup: keyboard
                            });
                        }

                        const syntheticMsg = { chat: { id: msg.chat.id }, from: { id: telegramId } };
                        await handlePositions(bot, syntheticMsg);
                    } else {
                        const inlineKeyboard = {
                            inline_keyboard: [
                                [
                                    { text: '🎁 Rewards', callback_data: 'quick_rewards' },
                                    { text: '💧 Positions', callback_data: 'quick_positions' }
                                ]
                            ]
                        };

                        await bot.sendMessage(
                            msg.chat.id,
                            `✅ Switched active wallet to *${newActiveWallet.label}* (\`${shortAddress}\`)`,
                            { parse_mode: 'Markdown', reply_markup: inlineKeyboard }
                        );

                        const keyboard = await buildWalletKeyboard(telegramId);
                        if (keyboard) {
                            await bot.sendMessage(msg.chat.id, '💼 *Loading positions...*', {
                                parse_mode: 'Markdown',
                                reply_markup: keyboard
                            });
                        }

                        const syntheticMsg = { chat: { id: msg.chat.id }, from: { id: telegramId } };
                        await handlePositions(bot, syntheticMsg);
                    }
                } catch (err) {
                    await bot.sendMessage(
                        msg.chat.id,
                        `❌ Failed to switch wallet: ${err?.message || err}`,
                        { parse_mode: 'Markdown' }
                    );
                }
                return;
            }
        }

        // Handle unknown commands
        if (msg.text && msg.text.startsWith('/')) {
            const command = msg.text.split(' ')[0];
            const knownCommands = [
                '/start', '/help', '/rewards', '/newwallet', '/importwallet',
                '/wallet', '/wallets', '/balance', '/exportkey', '/auditlog', '/walletaudit', '/claim', '/compound', '/positions', '/proximity', '/cancel', '/addposition', '/rebalance', '/stats'
            ];

            if (!knownCommands.includes(command)) {
                bot.sendMessage(
                    msg.chat.id,
                    '❌ Unknown command. Use /help to see available commands.',
                    { parse_mode: 'Markdown' }
                );
            }
        }
    });

    // Error handling
    bot.on('polling_error', (error) => {
        console.error('❌ Polling error:', error.code, error.message);

        // Specific handling for common errors
        if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
            console.error('⚠️  ERROR: Another bot instance is already running with this token!');
            console.error('⚠️  Please stop all other instances or there is a webhook configured.');
        } else if (error.code === 'EFATAL') {
            console.error('⚠️  FATAL ERROR: Bot polling has stopped. Restart required.');
        }
    });

    return bot;
}
