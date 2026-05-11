/**
 * Stats Handler
 * 
 * Handles the /stats command - displays position statistics including:
 * - Time in/out of range
 * - Rebalance counts
 * - Costs and P/L
 * 
 * @module stats.handler
 */

import { createSolanaConnection } from '../../utils/rpc.util.js';
import { findPositions } from '../../utils/positions.util.js';
import { fetchPositionRangeData } from '../../utils/range.util.js';
import { getActiveWallet } from '../../services/wallet.service.js';
import { getPositionStatistics } from '../../services/position-statistics.service.js';
import { formatErrorMessage, formatLoadingMessage } from '../formatters/message.formatter.js';
import { formatCurrency, formatTokenAmount } from '../../utils/format.util.js';
import { getTokenSymbol, KNOWN_TOKENS } from '../../config/constants.js';
import { getTokenInfo, getTokenInfoBatch } from '../../utils/token.util.js';
import { gatherDecreaseLiquidityAccounts } from '../../utils/accounts.util.js';
import { simulateDecreaseLiquidityV2 } from '../../utils/rewards.util.js';
import { parseTransferChecked } from '../../utils/transfers.util.js';
import { db } from '../../db/index.js';
import { positions as positionsTable } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Format milliseconds into human-readable duration
 * Examples: "13.4h", "45m", "2d 5h"
 * 
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration
 */
function formatDuration(ms) {
    if (!ms || ms < 0) return '0m';
    
    const minutes = Math.floor(ms / (1000 * 60));
    const hours = ms / (1000 * 60 * 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
        const remainingHours = (hours % 24).toFixed(1);
        return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
    }
    
    if (hours >= 1) {
        return `${hours.toFixed(1)}h`;
    }
    
    return `${minutes}m`;
}

/**
 * Format a single position's statistics message
 * 
 * @param {Object} position - Position data (from DB or on-chain)
 * @param {Object} stats - Position statistics from DB
 * @param {Object} rangeData - Current range data from on-chain
 * @param {number} index - Position index (1-based)
 * @param {number|null} currentSolPrice - Current SOL price for P/L calculation
 * @param {Object|null} rewardsData - Pending rewards data {transfers, tokenPrices, totalUsd}
 * @returns {string} Formatted message section
 */
function formatPositionStats(position, stats, rangeData, index, currentSolPrice = null, rewardsData = null) {
    const poolName = position.token0_symbol && position.token1_symbol
        ? `${position.token0_symbol}-${position.token1_symbol}`
        : `Position #${index}`;
    
    let message = `📊 *Stats: ${poolName}* (#${index})\n\n`;
    
    if (!stats) {
        message += `⚠️ No statistics recorded yet.\n`;
        message += `_Statistics are recorded when position is monitored._\n`;
        return message;
    }
    
    // Time tracking
    const totalTimeMs = stats.time_in_range_ms + stats.time_out_of_range_ms;
    const timeInRangePct = totalTimeMs > 0 
        ? ((stats.time_in_range_ms / totalTimeMs) * 100).toFixed(1) 
        : '100.0';
    
    const timeInStr = formatDuration(stats.time_in_range_ms);
    const timeOutStr = formatDuration(stats.time_out_of_range_ms);
    const totalTimeStr = formatDuration(totalTimeMs);
    
    message += `⏱️ *In Range:* ${timeInRangePct}% (${totalTimeStr} total)\n`;
    message += `   ${timeInStr} in / ${timeOutStr} out\n`;
    
    // Current status
    const inRange = rangeData?.inRange ?? stats.in_range;
    const statusEmoji = inRange ? '✅' : '❌';
    const statusText = inRange ? 'In Range' : 'Out of Range';
    message += `📍 *Status:* ${statusEmoji} ${statusText}\n\n`;
    
    // Rebalance stats
    const rebalancesTotal = stats.rebalances_count_lifetime || 0;
    const rebalancesToday = stats.rebalances_today || 0;
    message += `⚖️ *Rebalances:* ${rebalancesTotal} total | ${rebalancesToday} today\n`;
    
    // Costs
    const totalCost = stats.total_rebalance_cost_usd || 0;
    message += `💸 *Cost:* ${formatCurrency(totalCost)}\n`;
    
    // Pending Rewards section
    if (rewardsData && rewardsData.transfers && rewardsData.transfers.length > 0) {
        message += `\n🎁 *Pending Rewards*`;
        if (rewardsData.totalUsd > 0) {
            message += ` (${formatCurrency(rewardsData.totalUsd)})`;
        }
        message += `\n`;
        
        // Group transfers by token
        const tokenGroups = {};
        rewardsData.transfers.forEach(transfer => {
            if (!tokenGroups[transfer.token]) {
                tokenGroups[transfer.token] = {
                    token: transfer.token,
                    totalAmount: 0,
                    decimals: transfer.decimals
                };
            }
            tokenGroups[transfer.token].totalAmount += parseFloat(transfer.uiAmount);
        });
        
        // Display each token
        Object.values(tokenGroups).forEach(group => {
            const priceData = rewardsData.tokenPrices?.[group.token];
            const ticker = priceData?.ticker || 'Unknown';
            const priceUsd = priceData?.priceUsd ? parseFloat(priceData.priceUsd) : 0;
            const valueUsd = group.totalAmount * priceUsd;
            
            message += `• ${formatTokenAmount(group.totalAmount)} ${ticker.toUpperCase()}`;
            if (valueUsd > 0) {
                message += ` (~${formatCurrency(valueUsd)})`;
            }
            message += `\n`;
        });
    } else {
        message += `\n🎁 *Pending Rewards:* None\n`;
    }
    
    // P/L section (if we have initial values)
    if (stats.usd_value_on_open > 0 && rangeData?.liquidityValueUsd != null) {
        const currentValue = rangeData.liquidityValueUsd;
        const initialValue = stats.usd_value_on_open;
        const feesEarned = stats.total_fees_earned_usd || 0;
        const compounded = stats.total_compounded_usd || 0;
        const rebalanceCost = stats.total_rebalance_cost_usd || 0;
        
        // Net P/L = (current value - initial value) + fees earned + compounded - costs
        const netPL = (currentValue - initialValue) + feesEarned + compounded - rebalanceCost;
        const roiPercent = (netPL / initialValue) * 100;
        const plSign = netPL >= 0 ? '+' : '';
        
        message += `\n📈 *P/L (Lifetime)*\n`;
        message += `• Net: ${plSign}${formatCurrency(netPL)} (${plSign}${roiPercent.toFixed(1)}% ROI)\n`;
        message += `• Current: ${formatCurrency(currentValue)} | Entry: ${formatCurrency(initialValue)}\n`;
        
        // Show worth at entry SOL price if we have the data
        if (stats.sol_price_at_open != null && currentSolPrice != null && rangeData) {
            const worthAtEntrySol = calculateWorthAtEntrySolPrice(
                position,
                rangeData,
                stats.sol_price_at_open,
                currentSolPrice
            );
            if (worthAtEntrySol != null) {
                message += `• Worth at Entry SOL ($${stats.sol_price_at_open.toFixed(0)}): ${formatCurrency(worthAtEntrySol)}\n`;
            }
        }
    }
    
    // Historical Earnings tracking
    if (stats.total_fees_earned_usd > 0 || stats.total_compounded_usd > 0 || stats.total_claimed_usd > 0) {
        message += `\n💰 *Lifetime Earnings*\n`;
        if (stats.total_fees_earned_usd > 0) {
            message += `• Fees Earned: ${formatCurrency(stats.total_fees_earned_usd)}\n`;
        }
        if (stats.total_compounded_usd > 0) {
            message += `• Compounded: ${formatCurrency(stats.total_compounded_usd)}\n`;
        }
        if (stats.total_claimed_usd > 0) {
            message += `• Claimed: ${formatCurrency(stats.total_claimed_usd)}\n`;
        }
    }
    
    return message;
}

/**
 * Calculate what position would be worth if SOL returned to entry price
 * 
 * @param {Object} position - Position from DB
 * @param {Object} rangeData - Current range data from fetchPositionRangeData
 * @param {number} solPriceAtOpen - SOL price when position was opened
 * @param {number} currentSolPrice - Current SOL price
 * @returns {number|null} Worth at entry SOL price, or null if not calculable
 */
function calculateWorthAtEntrySolPrice(position, rangeData, solPriceAtOpen, currentSolPrice) {
    if (!rangeData || !solPriceAtOpen || !currentSolPrice) return null;
    
    const solMint = KNOWN_TOKENS.SOL.mint;
    
    // Determine which token is SOL (if any)
    const token0IsSol = position.token0_mint === solMint;
    const token1IsSol = position.token1_mint === solMint;
    
    if (!token0IsSol && !token1IsSol) {
        // Neither token is SOL, can't calculate
        return null;
    }
    
    // Get current amounts
    const amount0 = rangeData.amount0Human || 0;
    const amount1 = rangeData.amount1Human || 0;
    const price0 = rangeData.token0PriceUsd || 0;
    const price1 = rangeData.token1PriceUsd || 0;
    
    let worthAtEntrySol;
    
    if (token0IsSol) {
        // Token0 is SOL - use entry SOL price for token0, current price for token1
        worthAtEntrySol = (amount0 * solPriceAtOpen) + (amount1 * price1);
    } else {
        // Token1 is SOL - use current price for token0, entry SOL price for token1
        worthAtEntrySol = (amount0 * price0) + (amount1 * solPriceAtOpen);
    }
    
    return worthAtEntrySol;
}

/**
 * Handles the /stats command
 * Shows position statistics
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleStats(bot, msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

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

        // Send loading message
        const loadingMsg = await bot.sendMessage(
            chatId,
            formatLoadingMessage(walletAddress, wallet.label),
            { parse_mode: 'Markdown' }
        );

        try {
            // Connect to Solana
            const connection = createSolanaConnection();

            // Find all positions for the wallet
            const positions = await findPositions(connection, walletAddress);

            if (positions.length === 0) {
                await bot.editMessageText(
                    `📊 *Position Statistics*\n\n` +
                    `No positions found for this wallet.\n\n` +
                    `Use /addposition to create a new position.`,
                    {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id,
                        parse_mode: 'Markdown'
                    }
                );
                return;
            }

            // Get current SOL price for P/L calculation
            let currentSolPrice = null;
            try {
                const solInfo = await getTokenInfo(KNOWN_TOKENS.SOL.mint);
                currentSolPrice = solInfo.price;
            } catch (error) {
                console.warn('Failed to fetch SOL price for P/L:', error.message);
            }

            // Process each position
            const messages = [];

            for (let i = 0; i < positions.length; i++) {
                const position = positions[i];
                
                try {
                    // Get position from DB
                    const dbPositions = await db.select()
                        .from(positionsTable)
                        .where(eq(positionsTable.nft_mint, position.mintAddress))
                        .limit(1);
                    
                    const dbPosition = dbPositions[0];
                    
                    if (!dbPosition) {
                        messages.push(`📊 *Position #${i + 1}*\n\n⚠️ Position not tracked in database.\nUse /positions to sync.`);
                        continue;
                    }
                    
                    // Get statistics
                    const stats = await getPositionStatistics(dbPosition.id);
                    
                    // Fetch current range data for live status
                    let rangeData = null;
                    try {
                        rangeData = await fetchPositionRangeData(connection, position.positionPda);
                    } catch (rangeError) {
                        console.warn(`Failed to fetch range data for position ${position.mintAddress}:`, rangeError.message);
                    }
                    
                    // Fetch pending rewards
                    let rewardsData = null;
                    try {
                        const accounts = await gatherDecreaseLiquidityAccounts(
                            connection,
                            walletAddress,
                            position.mintAddress
                        );
                        
                        const simulationResult = await simulateDecreaseLiquidityV2(
                            connection,
                            accounts,
                            walletAddress
                        );
                        
                        const transfers = parseTransferChecked(simulationResult, accounts);
                        
                        if (transfers && transfers.length > 0) {
                            // Get token prices
                            const tokenAddresses = [...new Set(transfers.map(t => t.token))];
                            const tokenInfos = await getTokenInfoBatch(tokenAddresses);
                            
                            const tokenPrices = tokenAddresses.reduce((map, address, idx) => {
                                const info = tokenInfos[idx];
                                map[address] = {
                                    ticker: info?.ticker || null,
                                    priceUsd: info?.price ? info.price.toString() : null
                                };
                                return map;
                            }, {});
                            
                            // Calculate total USD value
                            let totalUsd = 0;
                            transfers.forEach(transfer => {
                                const priceData = tokenPrices[transfer.token];
                                const priceUsd = priceData?.priceUsd ? parseFloat(priceData.priceUsd) : 0;
                                totalUsd += parseFloat(transfer.uiAmount) * priceUsd;
                            });
                            
                            rewardsData = { transfers, tokenPrices, totalUsd };
                        }
                    } catch (rewardsError) {
                        console.warn(`Failed to fetch rewards for position ${position.mintAddress}:`, rewardsError.message);
                    }
                    
                    // Format message
                    const message = formatPositionStats(dbPosition, stats, rangeData, i + 1, currentSolPrice, rewardsData);
                    messages.push(message);
                    
                } catch (error) {
                    console.error(`Error processing position ${position.mintAddress}:`, error);
                    messages.push(`📊 *Position #${i + 1}*\n\n❌ Error: ${error.message}`);
                }
            }

            // Combine all messages
            const LINE_DIVIDER = "═══════════════════════════";
            let fullMessage = `📊 *Position Statistics*\n\n`;
            fullMessage += messages.join(`\n${LINE_DIVIDER}\n\n`);

            // Create keyboard
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '💧 Positions', callback_data: 'positions' },
                        { text: '🔄 Refresh', callback_data: 'stats_refresh' }
                    ]
                ]
            };

            await bot.editMessageText(
                fullMessage,
                {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: keyboard,
                    disable_web_page_preview: true
                }
            );

        } catch (error) {
            console.error('Error in stats handler:', error);

            await bot.editMessageText(
                formatErrorMessage(`Failed to fetch statistics: ${error.message}`),
                {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown'
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
 * Handle stats refresh callback
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleStatsRefresh(bot, callbackQuery) {
    // Answer the callback query first
    await bot.answerCallbackQuery(callbackQuery.id, {
        text: '🔄 Refreshing statistics...'
    });

    // Create synthetic message to reuse handleStats
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

    // Call handleStats to show fresh data
    await handleStats(bot, syntheticMsg);
}
