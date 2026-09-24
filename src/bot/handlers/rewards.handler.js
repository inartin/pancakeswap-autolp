import { createSolanaConnection } from '../../utils/rpc.util.js';
import { findPositions } from '../../utils/positions.util.js';
import { gatherDecreaseLiquidityAccounts } from '../../utils/accounts.util.js';
import { simulateDecreaseLiquidityV2 } from '../../utils/rewards.util.js';
import { parseTransferChecked } from '../../utils/transfers.util.js';
import { formatRewardsMessage, formatErrorMessage, formatLoadingMessage } from '../formatters/message.formatter.js';
import { getActiveWallet, resetWalletRewardsCounter, getWalletRewardsSinceReset } from '../../services/wallet.service.js';
import { calculateTokenAmounts, toBigInt, toNumberUnits } from '../../utils/range.util.js';
import { getTokenInfo, getTokenInfoBatch } from '../../utils/token.util.js';
import { fetchMeteoraDlmmPositions } from '../../utils/meteora-dlmm.util.js';

/**
 * Handles the /rewards command
 * Now uses active wallet instead of requiring address argument
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export async function handleRewards(bot, msg) {
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

        // Fetch claimed rewards since last reset
        const { rewardsSinceReset } = await getWalletRewardsSinceReset(wallet.id);

        // Find all PancakeSwap and Meteora DLMM positions for the wallet
        const [positions, meteoraPositions] = await Promise.all([
            findPositions(connection, walletAddress).catch(err => {
                console.warn('Failed to find PancakeSwap positions for rewards:', err.message);
                return [];
            }),
            fetchMeteoraDlmmPositions(walletAddress, connection).catch(err => {
                console.warn('Failed to find Meteora positions for rewards:', err.message);
                return [];
            })
        ]);

        if (positions.length === 0 && meteoraPositions.length === 0) {
            await bot.editMessageText(
                formatRewardsMessage(walletAddress, [], rewardsSinceReset, wallet.split_strategy),
                {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                }
            );
            return;
        }

        // Process each position
        const positionsData = [];

        for (const position of positions) {
            try {
                // Gather accounts for the position
                const accounts = await gatherDecreaseLiquidityAccounts(
                    connection,
                    walletAddress,
                    position.mintAddress
                );

                // Simulate the transaction
                const simulationResult = await simulateDecreaseLiquidityV2(
                    connection,
                    accounts,
                    walletAddress
                );

                // Parse transfers
                const transfers = parseTransferChecked(simulationResult, accounts);

                // Calculate liquidity value from existing account data
                let liquidityValueUsd = null;
                let mint0Ticker = null;
                let mint1Ticker = null;
                if (accounts.positionData && accounts.poolData) {
                    try {
                        // Calculate token amounts using Uniswap V3 math
                        const { amount0, amount1 } = calculateTokenAmounts(
                            toBigInt(accounts.positionData.liquidity),
                            toBigInt(accounts.poolData.sqrtPriceX64),
                            accounts.poolData.tickCurrent,
                            accounts.positionData.tickLowerIndex,
                            accounts.positionData.tickUpperIndex
                        );

                        // Convert to human-readable amounts
                        const amount0Human = toNumberUnits(amount0, accounts.poolData.mintDecimals0);
                        const amount1Human = toNumberUnits(amount1, accounts.poolData.mintDecimals1);

                        // Get USD prices AND tickers for both tokens in single batch call
                        const [token0Info, token1Info] = await getTokenInfoBatch([
                            accounts.poolData.tokenMint0,
                            accounts.poolData.tokenMint1
                        ]);
                        const token0PriceUsd = token0Info?.price;
                        const token1PriceUsd = token1Info?.price;

                        // Calculate total liquidity value in USD
                        const amount0Usd = token0PriceUsd != null ? amount0Human * token0PriceUsd : 0;
                        const amount1Usd = token1PriceUsd != null ? amount1Human * token1PriceUsd : 0;
                        liquidityValueUsd = amount0Usd + amount1Usd;
                        
                        // Also extract tickers (already fetched above)
                        mint0Ticker = token0Info?.ticker || null;
                        mint1Ticker = token1Info?.ticker || null;
                    } catch (calcError) {
                        console.error('Error calculating liquidity value:', calcError);
                        // Continue without liquidity value if calculation fails
                    }
                }

                // Pool token mints for position data
                let mint0 = accounts.poolData?.tokenMint0 || null;
                let mint1 = accounts.poolData?.tokenMint1 || null;

                positionsData.push({
                    mintAddress: position.mintAddress,
                    positionPda: position.positionPda,
                    poolState: accounts.pool_state,
                    transfers,
                    liquidityValueUsd,
                    mint0,
                    mint1,
                    mint0Ticker,
                    mint1Ticker,
                    success: true
                });

            } catch (error) {
                positionsData.push({
                    mintAddress: position.mintAddress,
                    error: error.message,
                    success: false
                });
            }
        }

        // Collect all unique token addresses from all positions
        const allTokenAddresses = new Set();
        positionsData.forEach(position => {
            if (position.transfers) {
                position.transfers.forEach(transfer => {
                    allTokenAddresses.add(transfer.token);
                });
            }
        });

        // Fetch all token prices in single batch call (optimized)
        let tokenPricesMap = {};
        if (allTokenAddresses.size > 0) {
            try {
                const addressArray = Array.from(allTokenAddresses);
                const tokenInfos = await getTokenInfoBatch(addressArray);
                
                tokenPricesMap = addressArray.reduce((map, address, index) => {
                    const info = tokenInfos[index];
                    map[address] = {
                        mintAddress: address,
                        ticker: info?.ticker || null,
                        priceUsd: info?.price ? info.price.toString() : null
                    };
                    return map;
                }, {});
            } catch (error) {
                console.error('Error fetching token prices:', error);
            }
        }

        // Add token prices to each PancakeSwap position
        positionsData.forEach(position => {
            position.tokenPrices = tokenPricesMap;
        });

        // Add Meteora DLMM positions to positionsData
        for (const mPos of meteoraPositions) {
            positionsData.push(mPos);
        }

        // Format and send the results
        const message = formatRewardsMessage(walletAddress, positionsData, rewardsSinceReset, wallet.split_strategy);

        // Create inline keyboard with per-position Claim and Compound buttons
        const keyboard = {
            inline_keyboard: []
        };

        // Add claim and compound buttons for each position that has rewards
        positionsData.forEach((position, index) => {
            // Read-only Meteora DLMM: add view link instead of write actions
            if (position.protocol === 'meteora' || position.isReadOnly) {
                if (position.unclaimedFeesUsd > 0 || position.unclaimedFeeToken0 > 0 || position.unclaimedFeeToken1 > 0) {
                    keyboard.inline_keyboard.push([
                        {
                            text: `🪐 View on Meteora #${index + 1}`,
                            url: position.poolUrl || `https://app.meteora.ag/dlmm/${position.poolId}`
                        }
                    ]);
                }
                return;
            }

            if (position.success && position.transfers && position.transfers.length > 0) {
                keyboard.inline_keyboard.push([
                    {
                        text: `💰 Claim LP #${index + 1}`,
                        callback_data: `claim_${position.mintAddress}`
                    },
                    {
                        text: `🔄 Compound LP #${index + 1}`,
                        callback_data: `compound_${position.mintAddress}`
                    }
                ]);
            }
        });

        // If no positions have rewards, add a disabled message
        if (keyboard.inline_keyboard.length === 0) {
            keyboard.inline_keyboard.push([
                { text: '✅ No rewards to claim', callback_data: 'no_rewards' }
            ]);
        }

        // Add Reset Stats and Refresh buttons at the bottom
        if (keyboard.inline_keyboard.length > 0) {
            keyboard.inline_keyboard.push([
                { text: '🔁 Reset Stats', callback_data: 'rewards_reset_stats' },
                { text: '🔄 Refresh', callback_data: 'rewards_refresh' }
            ]);
        }

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

    } catch (error) {
        console.error('Error in rewards handler:', error);

        await bot.editMessageText(
            formatErrorMessage(`Failed to fetch rewards: ${error.message}`),
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
 * Handle rewards refresh callback
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleRewardsRefresh(bot, callbackQuery) {
    // Answer the callback query first
    await bot.answerCallbackQuery(callbackQuery.id, {
        text: '🔄 Refreshing rewards...'
    });

    // Create synthetic message to reuse handleRewards
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

    // Call handleRewards to show fresh data
    await handleRewards(bot, syntheticMsg);
}

/**
 * Handle reset stats callback
 * Resets the rewards counter for the active wallet
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} callbackQuery - Callback query object
 */
export async function handleRewardsResetStats(bot, callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const telegramId = callbackQuery.from.id;

    try {
        const wallet = await getActiveWallet(telegramId);

        if (!wallet) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ No wallet found',
                show_alert: true
            });
            return;
        }

        await resetWalletRewardsCounter(wallet.id);

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '✅ Claim Stats reset!',
            show_alert: false
        });

        // Refresh the rewards view
        const syntheticMsg = {
            chat: { id: chatId },
            from: { id: telegramId }
        };

        try {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
        } catch (error) {
            // Ignore
        }

        await handleRewards(bot, syntheticMsg);

    } catch (error) {
        console.error('Error resetting rewards stats:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Failed to reset stats',
            show_alert: true
        });
    }
}
