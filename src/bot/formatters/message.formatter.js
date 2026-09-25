import { formatShortAddress, formatCurrency, formatPercentage, formatDecimal, formatTokenAmount, getPancakeSwapPositionUrl, getPancakeSwapPoolUrl } from '../../utils/format.util.js';
import { formatPositionVisualization } from '../../utils/visualization.util.js';
import { getTokenInfo } from '../../utils/token.util.js';
import { SPLIT_CLAIM_PERCENT, SPLIT_KEEP_PERCENT } from '../../config/constants.js';

/**
 * Formats rewards data into a Telegram message
 * Following UIX framework format (lines 416-435 in autofarmer_message_framework.md)
 *
 * @param {string} walletAddress - The wallet address
 * @param {Array<Object>} positionsData - Array of position data with transfers and prices
 * @returns {string} Formatted Telegram message
 */

const LINE_DIVIDER = "===========================";

/**
 * Format milliseconds into human-readable duration
 * Examples: "2h 15m", "45m", "1h 5m", "30s"
 * 
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration
 */
function formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
        const remainingHours = hours % 24;
        return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
    }
    
    if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    }
    
    if (minutes > 0) {
        return `${minutes}m`;
    }
    
    return `${seconds}s`;
}

export function formatRewardsMessage(walletAddress, positionsData, claimedSinceReset = null, splitStrategy = false) {
    if (!positionsData || positionsData.length === 0) {
        return `❌ *No Positions Found*\n\nNo PancakeSwap or Meteora DLMM positions detected for this wallet.\n\n*Make sure:*\n• Wallet has active liquidity positions\n• Positions are on Solana mainnet\n\n*Create a position:*\n• Visit [PancakeSwap](https://pancakeswap.finance)\n• Visit [Meteora](https://app.meteora.ag)\n\nTry again: /rewards`;
    }

    // Helper functions to check out of range & rewards
    const isPosOutOfRange = (pos) => pos.inRange === false || pos.isOutOfRange === true;
    const posHasRewards = (pos) => {
        if (pos.protocol === 'meteora') {
            return (pos.unclaimedFeesUsd > 0) || (pos.unclaimedFeeToken0 > 0) || (pos.unclaimedFeeToken1 > 0);
        }
        return Boolean(pos.transfers && pos.transfers.some(t => parseFloat(t.uiAmount) > 0));
    };

    // Calculate Meteora all-time fees across all positions in wallet
    const meteoraAllTimeFees = positionsData
        .filter(p => p.protocol === 'meteora')
        .reduce((sum, p) => sum + (parseFloat(p.allTimeFeesUsd) || 0), 0);

    // Filter out positions that are out of range and have no rewards
    const visiblePositions = positionsData.filter(pos => !(isPosOutOfRange(pos) && !posHasRewards(pos)));

    let message = `💰 *Claimable Rewards*\n\n`;
    let totalValueUsd = 0;

    if (visiblePositions.length === 0) {
        message += `No claimable rewards found.\n\n`;
    } else {
        visiblePositions.forEach((position, index) => {
            // Handle Meteora DLMM position (read-only)
            if (position.protocol === 'meteora') {
                const positionLabel = `🪐 [Meteora DLMM #${index + 1}](${position.poolUrl || `https://app.meteora.ag/dlmm/${position.poolId}`})`;
                message += `${positionLabel}  *${position.token0Symbol}/${position.token1Symbol}*\n`;

                const hasClaimable = (position.unclaimedFeesUsd > 0) || (position.unclaimedFeeToken0 > 0) || (position.unclaimedFeeToken1 > 0);
                if (hasClaimable) {
                    totalValueUsd += (position.unclaimedFeesUsd || 0);
                    message += `💰 Claimable: *${formatCurrency(position.unclaimedFeesUsd || 0)}*\n`;
                    if (position.unclaimedFeeToken0 > 0) {
                        message += `   • ${formatDecimal(position.unclaimedFeeToken0, 'auto')} ${position.token0Symbol}`;
                        if (position.unclaimedFeeToken0Usd > 0) message += ` (${formatCurrency(position.unclaimedFeeToken0Usd)})`;
                        message += `\n`;
                    }
                    if (position.unclaimedFeeToken1 > 0) {
                        message += `   • ${formatDecimal(position.unclaimedFeeToken1, 'auto')} ${position.token1Symbol}`;
                        if (position.unclaimedFeeToken1Usd > 0) message += ` (${formatCurrency(position.unclaimedFeeToken1Usd)})`;
                        message += `\n`;
                    }
                    message += `🔒 _Read-only (Claim via Meteora App)_\n\n`;
                } else {
                    message += `No claimable rewards\n🔒 _Read-only_\n\n`;
                }

                if (index < visiblePositions.length - 1) {
                    message += `${LINE_DIVIDER}\n\n`;
                }
                return;
            }
            // Create clickable PancakeSwap link if pool state is available
            const positionLabel = position.poolState && position.mintAddress
                ? `[LP #${index + 1}](https://pancakeswap.finance/liquidity/position/v3/solana/${position.poolState}/${position.mintAddress}?chain=sol&persistChain=1)`
                : `*LP #${index + 1}*`;

            message += `${positionLabel}`;

            // Try to construct pool name from available data
            const poolTokens = [];
            const tokenGroups = {};

            if (position.transfers && position.transfers.length > 0) {
                // Group transfers by token
                position.transfers.forEach(transfer => {
                    if (!tokenGroups[transfer.token]) {
                        tokenGroups[transfer.token] = {
                            token: transfer.token,
                            totalAmount: 0,
                            decimals: transfer.decimals,
                            transfers: []
                        };
                    }
                    tokenGroups[transfer.token].totalAmount += parseFloat(transfer.uiAmount);
                    tokenGroups[transfer.token].transfers.push(transfer);
                });

                // Collect token symbols for pool name
                Object.values(tokenGroups).forEach(group => {
                    const priceData = position.tokenPrices?.[group.token];
                    if (priceData?.ticker) {
                        poolTokens.push(priceData.ticker.toUpperCase());
                    }
                });
            }

            // Prefer pool tickers from handler (accurate pair), fall back to transfer-derived
            if (position.mint0Ticker && position.mint1Ticker) {
                message += `  *${position.mint0Ticker}/${position.mint1Ticker}*`;
            } else if (poolTokens.length >= 2) {
                message += `  *${poolTokens[0]}/${poolTokens[1]}*`;
            } else if (poolTokens.length === 1) {
                message += `  *${poolTokens[0]}*`;
            }

            // // Display liquidity value if available, otherwise show mint address
            // if (position.liquidityValueUsd && position.liquidityValueUsd > 0) {
            //     message += ` (${formatCurrency(position.liquidityValueUsd)})\n\n`;
            // } else {
            //     message += `\`${formatShortAddress(position.mintAddress)}\`\n\n`;
            // }

            if (position.error) {
                message += `❌ Error: ${position.error}\n\n`;
                if (index < visiblePositions.length - 1) {
                    message += `${LINE_DIVIDER}\n\n`;
                }
                return;
            }

            if (!position.transfers || position.transfers.length === 0) {
                message += `No claimable rewards\n\n`;
                if (index < visiblePositions.length - 1) {
                    message += `${LINE_DIVIDER}\n\n`;
                }
                return;
            }

            // Calculate position total value first
            let positionValueUsd = 0;
            Object.values(tokenGroups).forEach(group => {
                const priceData = position.tokenPrices?.[group.token];
                const priceUsd = priceData?.priceUsd ? parseFloat(priceData.priceUsd) : 0;
                const valueUsd = group.totalAmount * priceUsd;

                if (priceUsd > 0) {
                    positionValueUsd += valueUsd;
                }
            });

            // // Display header with position total
            // message += `*Pending Rewards* (${formatCurrency(positionValueUsd)}):\n`;
            // // Display individual tokens
            Object.values(tokenGroups).forEach(group => {
                const priceData = position.tokenPrices?.[group.token];
                // const ticker = priceData?.ticker || 'Unknown';
                const priceUsd = priceData?.priceUsd ? parseFloat(priceData.priceUsd) : 0;
                const valueUsd = group.totalAmount * priceUsd;

                if (priceUsd > 0) {
                    totalValueUsd += valueUsd;
                }

                // message += `• ${formatDecimal(group.totalAmount, 'auto')} ${ticker.toUpperCase()}`;

                // if (priceUsd > 0) {
                //     message += ` - ${formatCurrency(valueUsd)}`;
                // }

                // message += `\n`;
            });

            // message += `\n`;

            // Add separator between positions (except after last one)
            if (index < visiblePositions.length - 1) {
                message += `${LINE_DIVIDER}\n\n`;
            }
        });
    }

    message += `\n\n*💵 Pending Rewards:* *${formatCurrency(totalValueUsd)}*\n`;

    // Show claimed since last reset if available, adding Meteora all-time fees earned
    const totalClaimed = (claimedSinceReset !== null && claimedSinceReset !== undefined ? claimedSinceReset : 0) + meteoraAllTimeFees;
    if (claimedSinceReset !== null && claimedSinceReset !== undefined || meteoraAllTimeFees > 0) {
        message += `\n*🧾 Statistics*`;
        if (splitStrategy) {
            const claimedOut = totalClaimed * SPLIT_CLAIM_PERCENT;
            const compounded = totalClaimed * SPLIT_KEEP_PERCENT;
            message += `\n*Claimed:* ${formatCurrency(claimedOut)}\n`;
            message += `\n*Compounded:* ${formatCurrency(compounded)}\n`;
        } else {
            message += `\n*Claimed:* ${formatCurrency(totalClaimed)}\n`;
        }

        // Show separately for each position when there are multiple positions
        const positionClaimedItems = [];
        if (claimedSinceReset > 0) {
            positionClaimedItems.push({
                label: 'PancakeSwap',
                amount: claimedSinceReset
            });
        }
        positionsData.forEach((position, index) => {
            if (position.protocol === 'meteora') {
                const fees = parseFloat(position.allTimeFeesUsd) || 0;
                const pair = (position.token0Symbol && position.token1Symbol)
                    ? `${position.token0Symbol}/${position.token1Symbol}`
                    : `DLMM`;
                const isOutOfRange = position.inRange === false || position.isOutOfRange === true;
                const statusNote = isOutOfRange ? ' _(Out of Range)_' : '';
                positionClaimedItems.push({
                    label: `#${index + 1} ${pair}${statusNote}`,
                    amount: fees
                });
            }
        });

        if (positionClaimedItems.length > 1) {
            positionClaimedItems.forEach(item => {
                message += `   • ${item.label}: ${formatCurrency(item.amount)}\n`;
            });
        }
    }

    return message;
}

/**
 * Formats error message for Telegram
 * Converts technical errors into human-readable messages
 *
 * @param {string} errorMessage - The error message
 * @returns {string} Formatted error message
 */
export function formatErrorMessage(errorMessage) {
    return `❌ *Error*\n\n${errorMessage}`;
}

/**
 * Format technical error messages to be user-friendly
 * Converts technical errors into simple, actionable language
 * 
 * @param {string} errorMessage - Technical error message
 * @returns {string} Human-readable error message
 */
export function formatUserFriendlyError(errorMessage) {
  const msg = errorMessage.toLowerCase();
  
  // Common error patterns
  if (msg.includes('insufficient') && (msg.includes('balance') || msg.includes('funds'))) {
    return 'Insufficient balance to complete this transaction';
  }
  if (msg.includes('slippage') || msg.includes('price') && msg.includes('exceeded')) {
    return 'Price moved too much (slippage exceeded). Try again or increase range';
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return 'Transaction timed out. Network may be congested';
  }
  if (msg.includes('blockhash') || msg.includes('expired')) {
    return 'Transaction expired before confirmation. Please retry';
  }
  if (msg.includes('account') && msg.includes('not found')) {
    return 'Pool or account not found. Check the pool address';
  }
  if (msg.includes('invalid') && msg.includes('tick')) {
    return 'Invalid price range calculated. Try a different percentage';
  }
  if (msg.includes('no tokens available')) {
    return 'No tokens available for liquidity';
  }
  if (msg.includes('simulation failed') || msg.includes('preflight')) {
    return 'Transaction simulation failed. Check balance and pool status';
  }
  if (msg.includes('network') && msg.includes('error')) {
    return 'Network error. Please check your connection and retry';
  }
  if (msg.includes('rate limit')) {
    return 'Too many requests. Please wait a moment and try again';
  }
  
  // If no pattern matches, return first sentence or first 100 chars
  const firstSentence = errorMessage.split(/[.!?]/)[0];
  return firstSentence.length > 100 
    ? firstSentence.substring(0, 100) + '...'
    : firstSentence;
}

/**
 * Format open position error messages for display, removing verbose simulation logs
 * for expected errors. Makes it clear whether auto-retry will happen or user action is needed.
 * 
 * @param {string} error - Full error message from openPosition
 * @param {boolean} isAutoRebalance - Whether this is during auto-rebalance
 * @returns {string} Formatted error message suitable for user display
 */
export function formatOpenPositionError(error, isAutoRebalance = false) {
  if (!error) return 'Unknown error';
  
  // Price slippage errors (0x1785 = 6021 = PriceSlippageCheck)
  // These are expected during volatile markets but require manual retry
  if (error.includes('0x1785') || error.includes('PriceSlippageCheck') || error.includes('6021')) {
    if (isAutoRebalance) {
      // Concise but clear that it stopped (no automatic retry from scheduler)
      return 'Price slippage - market moved during transaction.\n\nAuto-rebalance stopped. Please retry manually.';
    }
    // More detailed for manual operations
    return 'Price slippage check failed.\n\nThe market price moved during the transaction. Please try again.';
  }
  
  // Insufficient funds - always show full message (important for user action)
  if (error.includes('insufficient funds') || error.includes('Insufficient SOL') || error.includes('Insufficient balance')) {
    // Extract just the meaningful part
    const lines = error.split('\n');
    const relevantLines = lines.filter(line => 
      line.includes('Insufficient') || 
      line.includes('Need at least') ||
      line.includes('balance')
    );
    return relevantLines.length > 0 ? relevantLines.join('\n') : error.split('\n')[0];
  }
  
  // For simulation failures with verbose logs, show concise version
  if (error.includes('Simulation failed') && error.includes('Logs:')) {
    const lines = error.split('\n');
    const messageLine = lines.find(line => line.includes('Message:')) || lines[0];
    
    // Extract error code if present
    const errorCodeMatch = error.match(/custom program error: (0x[0-9a-f]+)/i);
    const errorNumberMatch = error.match(/Error Number: (\d+)/i);
    
    if (errorCodeMatch || errorNumberMatch) {
      const code = errorCodeMatch ? errorCodeMatch[1] : errorNumberMatch ? errorNumberMatch[1] : 'unknown';
      const errorMessage = error.match(/Error Message: ([^.]+)/)?.[1] || 'Unknown error';
      return `${errorMessage} (${code})`;
    }
    
    // Fallback to first line
    return messageLine || 'Simulation failed';
  }
  
  // For other errors, show first line or first 200 chars
  const lines = error.split('\n');
  const firstLine = lines[0] || error;
  
  if (firstLine.length > 200) {
    return firstLine.substring(0, 200) + '...';
  }
  
  return firstLine;
}

/**
 * Formats loading message for Telegram
 *
 * @param {string} walletAddress - The wallet address
 * @param {string|null} walletLabel - The wallet label (optional)
 * @returns {string} Loading message
 */
export function formatLoadingMessage(walletAddress, walletLabel = null) {
    const formattedName = walletLabel ? `Wallet: ${walletLabel}` : `Wallet: \`${walletAddress}\``;
    return `🔍 *Scanning your positions*\n${formattedName}\n\nPlease wait...`;
}

/**
 * Formats positions list into a Telegram message
 * Following UIX framework format (lines 1245-1295 in autofarmer_message_framework.md)
 *
 * @param {Array<Object>} positionsData - Array of position data with range info
 * @returns {Promise<string>} Formatted Telegram message
 */
export async function formatPositionsListMessage(positionsData) {
    if (!positionsData || positionsData.length === 0) {
        return `❌ *No Positions Found*\n\nNo PancakeSwap or Meteora DLMM positions detected for this wallet.\n\n*Make sure:*\n• Wallet has active liquidity positions\n• Positions are on Solana mainnet\n\n*Create a position:*\n• Visit [PancakeSwap](https://pancakeswap.finance)\n• Visit [Meteora](https://app.meteora.ag)\n\nTry again: /positions or /addposition`;
    }

    let message = ``;

    for (const [index, position] of positionsData.entries()) {
        const isOutOfRange = position.inRange === false || position.isOutOfRange === true;
        const isHidden = isOutOfRange && !!position.is_hidden;

        // Position header
        const isMeteora = position.protocol === 'meteora';
        const positionIdStr = position.positionId ? ` (ID: ${position.positionId})` : '';
        const feeStr = position.feeTierPercent != null 
            ? ` Fee: ${(position.feeTierPercent * 100).toFixed(2)}%` 
            : '';
        
        // Get token symbols
        const token0Symbol = position.token0Symbol || (await getTokenInfo(position.mint0))?.ticker || 'T0';
        const token1Symbol = position.token1Symbol || (await getTokenInfo(position.mint1))?.ticker || 'T1';

        // Compact display for hidden out-of-range positions
        if (isHidden) {
            const header = isMeteora 
                ? `🪐 *Meteora DLMM Position #${index + 1}*${feeStr}`
                : `*Position #${index + 1}*${positionIdStr}${feeStr}`;
            const liqStr = position.liquidityValueUsd && position.liquidityValueUsd > 0
                ? ` (${formatCurrency(position.liquidityValueUsd)})`
                : '';
            
            message += `${header}\n💧 ${token0Symbol}/${token1Symbol}${liqStr} — ⭕ *Out of Range* _(Hidden)_\n`;

            if (index < positionsData.length - 1) {
                message += `\n${LINE_DIVIDER}\n\n`;
            }
            continue;
        }

        if (isMeteora) {
            message += `🪐 *Meteora DLMM Position #${index + 1}*${feeStr}\n\n`;
        } else {
            message += `*Position #${index + 1}*${positionIdStr}${feeStr}\n\n`;
        }

        // Pool name and fee tier
        message += `💧 ${token0Symbol}/${token1Symbol}`;

        // Liquidity status (show USD value if available, otherwise just show active status)
        if (position.liquidityValueUsd && position.liquidityValueUsd > 0) {
            message += ` (${formatCurrency(position.liquidityValueUsd)})\n`;
        }

        // Position visualization
        const visualization = formatPositionVisualization(position);
        message += `\n${visualization}\n`;

        if (isMeteora) {
            if (position.amount0Human != null && position.amount1Human != null) {
                message += `\n💎 *Liquidity:*\n`;
                message += `   ${formatDecimal(position.amount0Human, 'auto')} ${token0Symbol} | ${formatDecimal(position.amount1Human, 'auto')} ${token1Symbol}\n`;
            }
        }

        // APR information (if available)
        if (position.aprData) {
            const apr = position.aprData;
            message += `\n📈 *APR: *`;

            // Position APR (current)
            if (apr.positionApr != null) {
                message += ` ${formatPercentage(apr.positionApr)}`;
            } else {
                message += ` 0%`;
            }
            
            // Average APR (daily, monthly, and lifetime)
            if (position.avgAprData) {
                const { daily, monthly, lifetime } = position.avgAprData;
                
                // Show daily average if we have samples
                if (daily && daily.sampleCount > 0 && daily.avgPositionApr != null) {
                    let dailyLine = `\n\n📊 Avg 24h: ${formatPercentage(daily.avgPositionApr)}`;
                    if (daily.avgRangePercent != null) {
                        dailyLine += ` | Range: ±${daily.avgRangePercent.toFixed(1)}%`;
                    }
                    message += dailyLine;
                }
                
                // Show lifetime average if we have enough samples (at least 6 = ~1 day of 4-hour samples)
                if (lifetime && lifetime.sampleCount >= 6 && lifetime.avgPositionApr != null) {
                    let lifetimeLine = `\n📊 Avg All-Time: ${formatPercentage(lifetime.avgPositionApr)}`;
                    if (lifetime.avgRangePercent != null) {
                        lifetimeLine += ` | Range: ±${lifetime.avgRangePercent.toFixed(1)}%`;
                    }
                    if (lifetime.totalDays != null && lifetime.totalDays > 0) {
                        lifetimeLine += ` (${lifetime.totalDays}d)`;
                    }
                    message += lifetimeLine;
                }
            }
            
            message += `\n`;

            // Estimated income
            if (apr.estHourUsd != null && apr.estDayUsd != null) {
                message += `\n💵 *Estimated Income*:\n`;
                message += `${formatCurrency(apr.estHourUsd)}/hr · ${formatCurrency(apr.estDayUsd)}/day\n`;
            }
        }

        // Time in Range statistics (if available)
        if (position.statistics) {
            const stats = position.statistics;
            const totalTimeMs = stats.time_in_range_ms + stats.time_out_of_range_ms;
            
            if (totalTimeMs > 0) {
                const timeInRangePercent = (stats.time_in_range_ms / totalTimeMs) * 100;
                const inRangeDuration = formatDuration(stats.time_in_range_ms);
                const outOfRangeDuration = formatDuration(stats.time_out_of_range_ms);
                
                message += `\n⏱️ *Time in Range:* ${timeInRangePercent.toFixed(1)}%\n`;
                message += `   ${inRangeDuration} in range / ${outOfRangeDuration} out of range\n`;
                
                // Show rebalance count if available
                if (stats.rebalances_count_lifetime !== undefined && stats.rebalances_count_lifetime > 0) {
                    message += `\n⚖️ Rebalanced ${stats.rebalances_count_lifetime}x`;
                    if (stats.rebalances_today > 0) {
                        message += `\n    ${stats.rebalances_today} today`;
                    }

                    // Add time since last rebalance
                    if (stats.last_rebalance_at) {
                        const minutesAgo = Math.floor((Date.now() - new Date(stats.last_rebalance_at).getTime()) / (60 * 1000));
                        if (minutesAgo < 60) {
                            message += `, last ${minutesAgo}min ago`;
                        } else {
                            const hoursAgo = Math.floor(minutesAgo / 60);
                            message += `, last ${hoursAgo}h ago`;
                        }
                    }
                    message += `\n`;
                }
            } else {
                message += `\n⏱️ *Time in Range:* No data yet\n`;
            }
        } else if (!isMeteora) {
            message += `\n⏱️ *Time in Range:* No data yet\n`;
        }

        // Add links to position and pool
        if (isMeteora) {
            const meteoraUrl = position.poolUrl || `https://app.meteora.ag/dlmm/${position.poolId}`;
            const solscanUrl = `https://solscan.io/account/${position.mintAddress}`;
            message += `\n[View on Meteora →](${meteoraUrl})  |  [View on Solscan →](${solscanUrl})\n🔒 _Read-only (Meteora DLMM)_\n`;
        } else {
            const positionUrl = getPancakeSwapPositionUrl(position.poolId, position.mintAddress);
            const poolUrl = getPancakeSwapPoolUrl(position.poolId);
            message += `\n[View Position →](${positionUrl})  |  [View Pool →](${poolUrl})\n`;
        }

        // Add separator between positions (except after last one)
        if (index < positionsData.length - 1) {
            message += `\n${LINE_DIVIDER}\n\n`;
        }

    }

    return message;
}

/**
 * Formats the auto-rebalance explanation menu message
 * 
 * @param {boolean} autoRebalanceEnabled - Whether auto-rebalance is currently enabled
 * @param {boolean} claimBeforeRebalanceEnabled - Whether claim-before-rebalance is enabled
 * @returns {string} Formatted auto-rebalance explanation message
 */
export function formatAutoRebalanceMenuMessage(autoRebalanceEnabled, claimBeforeRebalanceEnabled) {
    const currentEmoji = autoRebalanceEnabled ? '🤖✅' : '🤖❌';
    const newStatus = autoRebalanceEnabled ? 'disabled' : 'enabled';
    const claimEmoji = claimBeforeRebalanceEnabled ? '💰✅' : '💰❌';
    const claimStatus = claimBeforeRebalanceEnabled ? 'ON' : 'OFF';
    
    return `${currentEmoji} *Auto-Rebalance*\n\n` +
        `Automatically reopens your position when price moves out of range.\n\n` +
        `*How it works:*\n` +
        `• Waits 3-15 minutes after going out of range\n` +
        `• Picks range width based on market volatility (0.3-3%)\n` +
        `• *Learns from history* - remembers which widths failed\n` +
        `• Uses wider ranges after repeated crossbacks\n` +
        `• Safety limit: max 4 rebalances per hour\n\n` +
        `*Smart Learning:*\n` +
        `• 📚 Records every failed width when position goes out of range\n` +
        `• 🧠 After 10 samples, calculates safe minimum width\n` +
        `• 📊 Overrides volatility estimate if learned width is wider\n` +
        `• 🎯 Stops churn by avoiding ranges that don't work\n\n` +
        `*Claim First:* ${claimEmoji} ${claimStatus} - Claims rewards before rebalancing\n\n` +
        `⚠️ *Note:* Works best with SOL-paired positions.\n\n` +
        `*Current Status:* ${autoRebalanceEnabled ? 'Enabled ✅' : 'Disabled ❌'}\n\n` +
        `Would you like to ${newStatus} auto-rebalance for this position?`;
}

/**
 * Creates the inline keyboard for the auto-rebalance menu
 * 
 * @param {boolean} autoRebalanceEnabled - Whether auto-rebalance is currently enabled
 * @param {boolean} claimBeforeRebalanceEnabled - Whether claim-before-rebalance is enabled
 * @param {number} positionId - Position ID for callback data
 * @returns {Object} Inline keyboard object
 */
export function createAutoRebalanceMenuKeyboard(autoRebalanceEnabled, claimBeforeRebalanceEnabled, positionId) {
    const currentEmoji = autoRebalanceEnabled ? '🤖✅' : '🤖❌';
    const claimEmoji = claimBeforeRebalanceEnabled ? '💰✅' : '💰❌';
    const claimStatus = claimBeforeRebalanceEnabled ? 'ON' : 'OFF';
    
    return {
        inline_keyboard: [
            [
                {
                    text: `${currentEmoji} Auto-Rebalance`,
                    callback_data: `toggle_autorebalance_confirm_${positionId}`
                }
            ],
            [
                {
                    text: `${claimEmoji} Claim First: ${claimStatus}`,
                    callback_data: `toggle_claim_in_autorebalance_${positionId}`
                }
            ],
            [
                { text: 'ℹ️ More Info', callback_data: `autorebalance_info_${positionId}` }
            ],
            [
                { text: '❌ Close', callback_data: 'positions' }
            ]
        ]
    };
}
