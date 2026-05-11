import { PositionMonitorService } from './position-monitor.service.js';
import { migrateOutOfRangeCooldownToOneMinute } from './alert.service.js';
import NotificationQueueService from './notification-queue.service.js';
import { getPancakeSwapPoolUrl, formatShortAddress } from '../utils/format.util.js';
import { POSITION_MONITOR_INTERVAL_MS, getTokenSymbol, RANGE_PERCENT_PRECISION, KNOWN_TOKENS, LAMPORTS_PER_SOL, IDLE_FUNDS_RECOVERY_MIN_USD, DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS } from '../config/constants.js';
import { db } from '../db/index.js';
import { wallets, positions } from '../db/schema.js';
import { eq, and, inArray, like, sql } from 'drizzle-orm';
import { resetDailyCounters, recordAprForAllActivePositions, cleanupOldAprHistory } from './position-statistics.service.js';
import { getMarketMetrics_WS, getDataStats, initializePriceHistory } from './market-data-ws.service.js';
import { checkAllPositionsForRebalance } from './auto-rebalance.service.js';
import { startPriceWebSocket, stopPriceWebSocket, getSolPrice, getCakePrice } from './jupiter-price-ws.service.js';
import { isRebalanceActive, isWithinSafetyWindow, RECOVERY_SAFETY_WINDOW_MINUTES } from './rebalance-lock.service.js';
import { createSolanaConnection } from '../utils/rpc.util.js';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { getMintTokenProgram } from '../utils/token.util.js';
import { getTokenInfo } from '../utils/token.util.js';
import { getEvmUniswapPositions } from '../utils/evm.util.js';

/**
 * Initialize market data on bot startup
 * 
 * Ensures we have fresh price history before starting monitoring.
 * Starts Jupiter WebSocket for real-time price updates.
 * Useful when bot has been offline for a while.
 * 
 * @param {boolean} [force=true] - Force fetch even if rate limited
 * @returns {Promise<void>}
 */
export async function initializeMarketData(force = true) {
    try {
        console.log('📊 Initializing market data system...');
        
        // Step 1: Backfill any missing price history from HTTP API
        // This fills gaps when bot was offline
        await initializePriceHistory();
        
        // Step 2: Start Jupiter WebSocket for real-time updates
        // This feeds price history continuously going forward
        await startPriceWebSocket();
        
        // Wait a moment for WebSocket to connect
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Show metrics availability
        const metrics = await getMarketMetrics_WS();
        if (metrics.atr15) {
            console.log(`   📊 ATR (15m): ${metrics.atr15.atrPercent.toFixed(2)}%`);
        }
        if (metrics.twap5) {
            console.log(`   📊 TWAP (5m): $${metrics.twap5.toFixed(2)}`);
        }
        
        console.log('✅ Market data system ready\n');
        
    } catch (error) {
        console.error('❌ Market data initialization failed:', error.message);
        console.error('   Bot will continue, but market data may be unavailable\n');
    }
}

/**
 * Scheduler Service
 * Runs the position monitor periodically and sends Telegram notifications
 * to position owners using the NotificationQueueService for rate limiting.
 *
 * Alerts are sent to the user who owns the wallet that owns the position.
 *
 * Now also collects SOL/USD price history every 30s for auto-rebalancing.
 */
export function startMonitoring(bot, options = {}) {
    const queue = new NotificationQueueService();
    const monitor = new PositionMonitorService({ emitProximity: true });

    console.log('\n🚀 Monitoring Started');
    console.log('   Checking positions every 30 seconds...\n');

    const run = async () => {
        try {
            // Market data now comes from WebSocket (no polling needed)
            // Price history is fed automatically by jupiter-price-ws.service.js

            const triggered = await monitor.checkAllPositions();
            
            if (triggered.length > 0) {
                console.log(`📍 Monitoring: ${triggered.length} alert(s) triggered`);
            }
            
            // Auto-rebalance check (per-position control)
            void checkAndExecuteAutoRebalances(bot).catch(err => {
                console.error('❌ Auto-rebalance check failed:', err.message);
            });

            // Optimization: Batch fetch all wallets to avoid N+1 query problem
            // Extract unique wallet IDs from triggered alerts
            const uniqueWalletIds = [...new Set(triggered.map(t => t.walletId))];

            // Batch query #1: Fetch all wallets needed for this cycle
            const walletsMap = new Map();
            if (uniqueWalletIds.length > 0) {
                const walletRows = await db.select()
                    .from(wallets)
                    .where(inArray(wallets.id, uniqueWalletIds));

                walletRows.forEach(w => walletsMap.set(w.id, w));
            }

            // Batch query #2: Get wallet counts per user for multi-wallet detection
            const uniqueUserIds = [...new Set(
                Array.from(walletsMap.values()).map(w => w.user_telegram_id)
            )];
            const userWalletCounts = new Map();

            for (const userId of uniqueUserIds) {
                const countResult = await db.select({ count: sql`count(*)` })
                    .from(wallets)
                    .where(eq(wallets.user_telegram_id, userId));
                userWalletCounts.set(userId, Number(countResult[0]?.count) || 0);
            }

            // Process alerts with pre-fetched data (no more queries per alert)
            for (const t of triggered) {
                // Look up wallet from pre-fetched map
                const wallet = walletsMap.get(t.walletId);

                if (!wallet) {
                    console.warn(`Wallet ${t.walletId} not found for position ${t.positionId}`);
                    continue;
                }

                const ownerTelegramId = wallet.user_telegram_id;

                if (!ownerTelegramId) {
                    console.warn(`Wallet ${t.walletId} has no telegram_id for position ${t.positionId}`);
                    continue;
                }

                // Fetch position row once (used for pool label and proximity keyboard)
                let position = null;
                try {
                    const positionRows = await db.select()
                        .from(positions)
                        .where(eq(positions.id, t.positionId))
                        .limit(1);
                    position = positionRows && positionRows[0];
                } catch (_) {
                    // ignore DB errors for message enrichment
                }

                // Compute pool label from token tickers if available
                let poolLabel = null;
                if (position) {
                    const sym0 = position.token0_symbol || getTokenSymbol(position.token0_mint);
                    const sym1 = position.token1_symbol || getTokenSymbol(position.token1_mint);
                    if (sym0 && sym1) {
                        poolLabel = `${sym0}/${sym1}`;
                    }
                }

                // Compute wallet info for multi-wallet users (using pre-fetched data)
                let walletInfo = null;
                const userWalletCount = userWalletCounts.get(ownerTelegramId) || 1;

                if (userWalletCount > 1) {
                    // User has multiple wallets - include wallet identifier
                    if (wallet.label && wallet.label !== 'My Wallet') {
                        walletInfo = wallet.label;
                    } else {
                        // Use formatted short address
                        walletInfo = formatShortAddress(wallet.wallet_address);
                    }
                }

                // Build the alert message (prefer poolLabel over address when present)
                // Enrich with range percent for out-of-range and back-in-range alerts
                let rangePercent = null;
                if (position && position.range_percent != null) {
                    rangePercent = position.range_percent;
                } else if (
                    typeof t.lowerPrice === 'number' && t.lowerPrice > 0 &&
                    typeof t.upperPrice === 'number' && t.upperPrice > 0
                ) {
                    const priceRatio = t.upperPrice / t.lowerPrice;
                    if (Number.isFinite(priceRatio) && priceRatio > 0) {
                        const spreadFraction = (priceRatio - 1) / (priceRatio + 1);
                        if (Number.isFinite(spreadFraction) && spreadFraction > 0) {
                            const percent = spreadFraction * 100;
                            const roundedUp = Math.ceil(percent * RANGE_PERCENT_PRECISION) / RANGE_PERCENT_PRECISION;
                            if (roundedUp > 0) {
                                rangePercent = roundedUp;
                            }
                        }
                    }
                }

                const labelForAlerts = (poolLabel && rangePercent)
                    ? `${poolLabel} (±${rangePercent}%)`
                    : poolLabel;

                // Add walletInfo to the message data
                const tForMessage = (t.type === 'out_of_range' || t.type === 'back_in_range')
                    ? (labelForAlerts ? { ...t, poolLabel: labelForAlerts, walletInfo } : { ...t, walletInfo })
                    : (poolLabel ? { ...t, poolLabel, walletInfo } : { ...t, walletInfo });

                const text = t.type === 'back_in_range'
                    ? buildBackInRangeMessage(tForMessage)
                    : (t.type === 'proximity' ? buildProximityMessage(tForMessage) : buildOutOfRangeMessage(tForMessage));

                // Prepare message options (proximity and out-of-range alerts get rebalance and close buttons)
                const baseOptions = { parse_mode: 'Markdown', disable_web_page_preview: true };
                let messageOptions = baseOptions;
                
                if (t.type === 'proximity' || t.type === 'out_of_range') {
                    // Use previously fetched position to get NFT mint
                    const nftMint = position?.nft_mint;
                    const canRebalance = position?.range_percent && nftMint;

                    // Build keyboard with rebalance and close buttons
                    const keyboard = [];

                    // First row: Rebalance and Close buttons (if applicable)
                    const firstRow = [];
                    if (canRebalance) {
                        firstRow.push({
                            text: '⚖️ Rebalance',
                            callback_data: `rebalance_${nftMint}`
                        });
                    }
                    if (nftMint) {
                        firstRow.push({
                            text: '🔴 Close',
                            callback_data: `position_close_${nftMint}`
                        });
                    }

                    if (firstRow.length > 0) {
                        keyboard.push(firstRow);
                    }

                    // Add view positions button on a new row
                    keyboard.push([
                        { text: '📊 View Positions', callback_data: 'positions' }
                    ]);

                    messageOptions = {
                        ...baseOptions,
                        reply_markup: { inline_keyboard: keyboard }
                    };
                } else {
                    // Back-in-range gets both Rewards and View Positions; others keep View Positions only
                    if (t.type === 'back_in_range') {
                        messageOptions = {
                            ...baseOptions,
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: '💰 Rewards', callback_data: 'rewards' },
                                        { text: '📊 Positions', callback_data: 'positions' }
                                    ]
                                ]
                            }
                        };
                    } else {
                        messageOptions = {
                            ...baseOptions,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📊 View Positions', callback_data: 'positions' }]
                                ]
                            }
                        };
                    }
                }

                // Send to position owner
                queue.add(async () => {
                    try {
                        await bot.sendMessage(ownerTelegramId, text, messageOptions);
                    } catch (err) {
                        console.error(`Failed to send alert to user ${ownerTelegramId}:`, err?.message || err);
                    }
                });
            }
        } catch (err) {
            console.error('Monitor error:', err?.message || err);
        }
    };

    // Prefer cron-like cadence if available via options
    const intervalMs = options.intervalMs ?? POSITION_MONITOR_INTERVAL_MS;

    // One-time migration to ensure per-position cooldown is 1 minute
    void migrateOutOfRangeCooldownToOneMinute();
    // Kick off immediately, then on interval
    void run();
    const timer = setInterval(run, intervalMs);

    return () => clearInterval(timer);
}

function buildOutOfRangeMessage(t) {
    const lower = typeof t.lowerPrice === 'number' ? t.lowerPrice : null;
    const upper = typeof t.upperPrice === 'number' ? t.upperPrice : null;
    const statusDir = t.direction === 'below' ? 'Below' : 'Above';

    const lines = [];
    lines.push('⚠️ *Out of Range Alert*');
    lines.push(`Pool: \`${t.poolLabel || t.poolAddress}\``);
    
    // Add wallet info if present (multi-wallet users only)
    if (t.walletInfo) {
        lines.push(`Wallet: \`${t.walletInfo}\``);
    }
    
    lines.push(`Current Price: *${formatNumberMaybe(t.currentPrice)}*`);
    if (lower != null && upper != null) {
        lines.push(`Range: ${formatNumberMaybe(lower)} - ${formatNumberMaybe(upper)}`);
    }
    lines.push(`Status: ❌ Out of Range (${statusDir})`);

    // Helpful link to the pool
    try {
        const url = getPancakeSwapPoolUrl(t.poolAddress);
        if (url) lines.push(`\n[Open Pool on PancakeSwap](${url})`);
    } catch (_) {
        // ignore url build errors
    }

    return lines.join('\n');
}

function formatNumberMaybe(n) {
    if (typeof n !== 'number' || !isFinite(n)) return 'N/A';
    if (n >= 1) return n.toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
    return n.toPrecision(6);
}

function buildBackInRangeMessage(t) {
    const lines = [];
    lines.push('✅ *Back In Range*');
    lines.push(`Pool: \`${t.poolLabel || t.poolAddress}\``);
    
    // Add wallet info if present (multi-wallet users only)
    if (t.walletInfo) {
        lines.push(`Wallet: \`${t.walletInfo}\``);
    }
    
    lines.push(`Price: *${formatNumberMaybe(t.currentPrice)}*`);
    if (typeof t.lowerPrice === 'number' && typeof t.upperPrice === 'number') {
        lines.push(`Range: ${formatNumberMaybe(t.lowerPrice)} - ${formatNumberMaybe(t.upperPrice)}`);
    }
    try {
        const url = getPancakeSwapPoolUrl(t.poolAddress);
        if (url) lines.push(`\n[Open Pool on PancakeSwap](${url})`);
    } catch (_) {
        // ignore url build errors
    }

    return lines.join('\n');
}

function buildProximityMessage(t) {
    const lower = typeof t.lowerPrice === 'number' ? t.lowerPrice : null;
    const upper = typeof t.upperPrice === 'number' ? t.upperPrice : null;
    const lowerAlert = typeof t.lowerAlertPrice === 'number' ? t.lowerAlertPrice : null;
    const upperAlert = typeof t.upperAlertPrice === 'number' ? t.upperAlertPrice : null;

    const lines = [];
    lines.push('🎚️ *Proximity Alert*');
    lines.push(`Pool: \`${t.poolLabel || t.poolAddress}\``);
    
    // Add wallet info if present (multi-wallet users only)
    if (t.walletInfo) {
        lines.push(`Wallet: \`${t.walletInfo}\``);
    }
    
    lines.push(`Current Price: *${formatNumberMaybe(t.currentPrice)}*`);
    if (lower != null && upper != null) {
        lines.push(`Range: ${formatNumberMaybe(lower)} - ${formatNumberMaybe(upper)}`);
    }
    if (lowerAlert != null && upperAlert != null) {
        lines.push(`Alert triggers at: ${formatNumberMaybe(lowerAlert)} or ${formatNumberMaybe(upperAlert)}`);
    }

    try {
        const url = getPancakeSwapPoolUrl(t.poolAddress);
        if (url) lines.push(`\n[Open Pool on PancakeSwap](${url})`);
    } catch (_) {
        // ignore url build errors
    }

    return lines.join('\n');
}

/**
 * Check positions for auto-rebalance opportunities and execute them
 * 
 * This is called by the monitoring loop when AUTO_REBALANCE_ENABLED is true.
 * It checks all positions and triggers rebalances for those that meet criteria.
 * 
 * @param {TelegramBot} bot - Telegram bot instance for notifications
 * @returns {Promise<void>}
 */
async function checkAndExecuteAutoRebalances(bot) {
    try {
        const rebalanceOpportunities = await checkAllPositionsForRebalance();
        
        if (rebalanceOpportunities.length === 0) {
            return; // Nothing to do (already logged in checkAllPositionsForRebalance if positions exist)
        }
        
        // Already logged in checkAllPositionsForRebalance
        
        // Execute rebalances sequentially (to avoid race conditions)
        for (const opportunity of rebalanceOpportunities) {
            try {
                console.log(`🔄 Auto-rebalancing position ${opportunity.positionId} (${opportunity.nftMint})...`);
                console.log(`   Mode: ${opportunity.decision.data.mode}, Width: ${opportunity.decision.data.rangeWidth}%`);
                console.log(`   Reason: ${opportunity.decision.reason}`);
                
                // Import the rebalance handler dynamically to avoid circular dependencies
                const { executeAutoRebalance } = await import('../bot/handlers/rebalance.handler.js');
                
                // Execute rebalance (this will handle all the transaction logic)
                const result = await executeAutoRebalance(
                    bot,
                    opportunity.positionId,
                    opportunity.nftMint,
                    opportunity.decision.data
                );
                
                // if (result.success) {
                //     console.log(`✅ Auto-rebalance completed for position ${opportunity.positionId}`);
                // } else {
                //     console.error(`❌ Auto-rebalance failed for position ${opportunity.positionId}: ${result.error}`);
                // }
                
                // Small delay between rebalances (500ms)
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.error(`❌ Error auto-rebalancing position ${opportunity.positionId}:`, error.message);
                // Continue with next position (don't let one failure stop others)
            }
        }
        
    } catch (error) {
        console.error('❌ Error in auto-rebalance check:', error.message);
    }
}

/**
 * Daily Reset Job
 * Resets daily rebalance counters at UTC midnight
 * 
 * This enforces the daily cap from Section 5 of the automation plan:
 * - Max 20 rebalances per day per position (with smart exceptions)
 * - Resets at UTC 00:00
 * 
 * @returns {Function} Cleanup function to stop the job
 */
export function startDailyResetJob() {
    let lastResetDate = null;
    
    const checkAndReset = async () => {
        try {
            const now = new Date();
            const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
            
            // Check if we've crossed into a new UTC day
            if (lastResetDate !== currentDate) {
                // Check if it's actually a new day (not first run)
                if (lastResetDate !== null) {
                    console.log(`🔄 UTC midnight reached, resetting daily rebalance counters...`);
                    await resetDailyCounters();
                    console.log(`✅ Daily counters reset for ${currentDate}`);
                }
                
                lastResetDate = currentDate;
            }
        } catch (err) {
            console.error('❌ Failed to reset daily counters:', err?.message || err);
        }
    };
    
    // Check every minute
    const timer = setInterval(checkAndReset, 60000);
    
    // Run immediately on startup to initialize lastResetDate
    void checkAndReset();
    
    console.log('📅 Daily reset job started (checks every 60s for UTC midnight)');
    
    return () => {
        clearInterval(timer);
        console.log('📅 Daily reset job stopped');
    };
}

/**
 * APR History Recording Job
 * Records APR snapshots for all active positions every 4 hours
 * 
 * This builds historical data for calculating average daily/monthly APR.
 * Also handles cleanup of old records (45 day retention).
 * 
 * @returns {Function} Cleanup function to stop the job
 */
export function startAprHistoryJob() {
    const APR_RECORD_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
    let lastCleanup = 0;
    
    const recordAprSnapshots = async () => {
        try {
            // Dynamically import to avoid circular dependencies
            const { calculateCompleteApr } = await import('../utils/apr.util.js');
            const { fetchPositionRangeData } = await import('../utils/range.util.js');
            const { findPositions } = await import('../utils/positions.util.js');
            const { createSolanaConnection } = await import('../utils/rpc.util.js');
            const { PublicKey } = await import('@solana/web3.js');
            
            const connection = createSolanaConnection();
            
            // Wrapper function to fetch range data with proper connection
            const fetchRangeData = async (nftMint) => {
                try {
                    const mintPk = new PublicKey(nftMint);
                    return await fetchPositionRangeData(connection, mintPk);
                } catch (error) {
                    console.error(`Failed to fetch range data for ${nftMint}:`, error.message);
                    return null;
                }
            };
            
            await recordAprForAllActivePositions(calculateCompleteApr, fetchRangeData, findPositions, connection);
            
            // Run cleanup once per day
            const now = Date.now();
            if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
                await cleanupOldAprHistory();
                lastCleanup = now;
            }
            
        } catch (error) {
            console.error('❌ APR history recording failed:', error.message);
        }
    };
    
    // Run on interval
    const timer = setInterval(recordAprSnapshots, APR_RECORD_INTERVAL_MS);
    
    // Run once 30 seconds after startup (give time for market data to initialize)
    setTimeout(recordAprSnapshots, 30 * 1000);
    
    console.log('📊 APR history job started (records every 4 hours)');
    
    return () => {
        clearInterval(timer);
        console.log('📊 APR history job stopped');
    };
}

/**
 * Idle Funds Recovery Job
 * 
 * Recovers funds stuck in wallets after failed rebalances.
 * Checks for closed positions with idle token balances and attempts
 * to add liquidity to existing positions or create new ones.
 * 
 * Safety checks:
 * 1. Position must have been updated > RECOVERY_SAFETY_WINDOW_MINUTES ago (default 15 min)
 * 2. Wallet must not have an active rebalance in progress
 * 3. Wallet must have sufficient token balances (>= IDLE_FUNDS_RECOVERY_MIN_USD)
 * 
 * Recovery strategy:
 * 1. First check if there's an active position for the same pool - add liquidity to it
 * 2. If no active position exists, create a new one using the closed position's settings
 * 
 * @param {TelegramBot} bot - Telegram bot instance
 * @returns {Function} Cleanup function to stop the job
 */
export function startIdleFundsRecoveryJob(bot) {
    const RECOVERY_INTERVAL_MS = 10 * 60 * 1000; // Check every 10 minutes
    const isDebug = process.env.LOG_LEVEL === 'debug';
    
    const checkAndRecover = async () => {
        try {
            // Find all closed positions
            const closedPositions = await db
                .select()
                .from(positions)
                .where(eq(positions.status, 'closed'));
            
            if (closedPositions.length === 0) {
                return; // No closed positions
            }
            
            // console.log(`🔍 Recovery job: Found ${closedPositions.length} closed position(s)`);
            
            for (const position of closedPositions) {
                try {
                    // Get the wallet for this position
                    const walletResult = await db
                        .select()
                        .from(wallets)
                        .where(eq(wallets.id, position.wallet_id))
                        .limit(1);
                    
                    if (walletResult.length === 0) {
                        // console.log(`   ⚠️  Wallet not found for position ${position.id}, skipping`);
                        continue;
                    }
                    
                    const wallet = walletResult[0];
                    
                    // Check 1: Safety window - don't recover if recently updated
                    if (isWithinSafetyWindow(position.updated_at)) {
                        // console.log(`   ⏳ Position ${position.id} updated recently (within ${RECOVERY_SAFETY_WINDOW_MINUTES} min), skipping`);
                        continue;
                    }
                    
                    // Check 2: Active rebalance lock
                    if (isRebalanceActive(wallet.wallet_address)) {
                        // console.log(`   🔒 Wallet ${wallet.wallet_address.slice(0, 8)}... has active rebalance, skipping`);
                        continue;
                    }
                    
                    // Check 3: Query wallet balances to see if there are idle funds
                    const connection = createSolanaConnection();
                    const walletPk = new PublicKey(wallet.wallet_address);
                    
                    const mint0 = new PublicKey(position.token0_mint);
                    const mint1 = new PublicKey(position.token1_mint);
                    const mint0Program = await getMintTokenProgram(connection, mint0);
                    const mint1Program = await getMintTokenProgram(connection, mint1);
                    
                    const ata0 = await getAssociatedTokenAddress(mint0, walletPk, false, mint0Program);
                    const ata1 = await getAssociatedTokenAddress(mint1, walletPk, false, mint1Program);
                    
                    // Check if token accounts exist before querying balances (avoids RPC errors)
                    const [ata0Info, ata1Info] = await Promise.all([
                        connection.getAccountInfo(ata0),
                        connection.getAccountInfo(ata1)
                    ]);

                    const [bal0Res, bal1Res] = await Promise.all([
                        ata0Info ? connection.getTokenAccountBalance(ata0).catch(() => null) : null,
                        ata1Info ? connection.getTokenAccountBalance(ata1).catch(() => null) : null
                    ]);
                    
                    let token0Amount = parseFloat(bal0Res?.value?.uiAmount || '0');
                    let token1Amount = parseFloat(bal1Res?.value?.uiAmount || '0');
                    
                    // Check native SOL if token is SOL
                    const isToken0Sol = position.token0_mint === KNOWN_TOKENS.SOL.mint;
                    const isToken1Sol = position.token1_mint === KNOWN_TOKENS.SOL.mint;
                    
                    if (isToken0Sol && token0Amount === 0) {
                        const solBalance = await connection.getBalance(walletPk);
                        token0Amount = Math.max(0, (solBalance / LAMPORTS_PER_SOL) - 0.05);
                    }
                    if (isToken1Sol && token1Amount === 0) {
                        const solBalance = await connection.getBalance(walletPk);
                        token1Amount = Math.max(0, (solBalance / LAMPORTS_PER_SOL) - 0.05);
                    }
                    
                    // Get token prices to estimate USD value
                    const token0Info = await getTokenInfo(position.token0_mint);
                    const token1Info = await getTokenInfo(position.token1_mint);
                    const token0Usd = token0Amount * (token0Info?.price || 0);
                    const token1Usd = token1Amount * (token1Info?.price || 0);
                    const totalUsd = token0Usd + token1Usd;
                    
                    if (totalUsd < IDLE_FUNDS_RECOVERY_MIN_USD) {
                        // Mark as recovered to stop querying this position (no funds to recover)
                        await db.update(positions)
                            .set({ status: 'recovered', updated_at: new Date() })
                            .where(eq(positions.id, position.id));
                        if (isDebug) console.log(`   💰 Position ${position.id} marked as recovered (insufficient funds: $${totalUsd.toFixed(2)} < $${IDLE_FUNDS_RECOVERY_MIN_USD})`);
                        continue;
                    }
                    
                    if (isDebug) {
                        console.log(`🔄 Recovery: Found idle funds for closed position ${position.id}`);
                        console.log(`   Balances: ${token0Amount.toFixed(4)} ${position.token0_symbol}, ${token1Amount.toFixed(4)} ${position.token1_symbol}`);
                        console.log(`   Total: $${totalUsd.toFixed(2)}`);
                    }
                    
                    // Check 4: Look for an existing ACTIVE position for the same pool and wallet
                    const existingActivePositions = await db
                        .select()
                        .from(positions)
                        .where(and(
                            eq(positions.wallet_id, position.wallet_id),
                            eq(positions.pool_address, position.pool_address),
                            eq(positions.status, 'active')
                        ));
                    
                    // Get wallet with encryption for the recovery
                    const { getWalletByIdWithEncryption } = await import('./wallet.service.js');
                    const walletWithKey = await getWalletByIdWithEncryption(wallet.id);
                    
                    if (!walletWithKey) {
                        if (isDebug) console.log(`   ⚠️  Could not get wallet encryption for position ${position.id}`);
                        continue;
                    }
                    
                    if (existingActivePositions.length > 0) {
                        // Option A: Add liquidity to existing active position
                        const activePosition = existingActivePositions[0];
                        if (isDebug) console.log(`   📍 Found active position ${activePosition.id} for same pool, adding liquidity...`);
                        
                        const { addLiquidity } = await import('../utils/add-liquidity.util.js');
                        const { decryptPrivateKey } = await import('../utils/encryption.util.js');
                        const { Keypair } = await import('@solana/web3.js');
                        const bs58 = await import('bs58');
                        const { env } = await import('../config/env.js');
                        
                        // Decrypt private key
                        const privateKey = decryptPrivateKey(
                            walletWithKey.encrypted_private_key,
                            walletWithKey.nonce,
                            walletWithKey.salt,
                            env.MASTER_PASSWORD
                        );
                        const keypair = Keypair.fromSecretKey(bs58.default.decode(privateKey));
                        
                        // Add liquidity to the active position
                        const positionMintPk = new PublicKey(activePosition.nft_mint);
                        const addOptions = {
                            amount0: token0Amount,
                            amount1: token1Amount,
                            slippageBps: DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS
                        };
                        
                        const addResult = await addLiquidity(connection, keypair, positionMintPk, addOptions);
                        
                        if (addResult.success) {
                            if (isDebug) console.log(`   ✅ Added liquidity to position ${activePosition.id}: $${addResult.totalUsd?.toFixed(2) || totalUsd.toFixed(2)}`);
                            
                            // Delete the closed position record since funds are now in active position
                            await db.delete(positions).where(eq(positions.id, position.id));
                            if (isDebug) console.log(`   🗑️  Removed closed position record ${position.id}`);
                            
                            // Notify user
                            try {
                                await bot.sendMessage(wallet.user_telegram_id,
                                    `✅ *Idle Funds Recovered*\n\n` +
                                    `Added $${addResult.totalUsd?.toFixed(2) || totalUsd.toFixed(2)} to your existing position.\n\n` +
                                    `*Position:* \`${formatShortAddress(activePosition.nft_mint)}\`\n` +
                                    `*Pool:* ${position.token0_symbol}/${position.token1_symbol}`,
                                    { parse_mode: 'Markdown' }
                                );
                            } catch (notifyErr) {
                                if (isDebug) console.warn(`   ⚠️  Failed to notify user: ${notifyErr.message}`);
                            }
                        } else {
                            if (isDebug) console.log(`   ⚠️  Failed to add liquidity: ${addResult.error}`);
                        }
                        
                    } else {
                        // Option B: No active position - create a new one
                        if (isDebug) console.log(`   📍 No active position for pool, creating new position...`);
                        
                        // Trigger recovery via continueRebalanceFromWalletBalances
                        const { continueRebalanceFromWalletBalances } = await import('../bot/handlers/rebalance.handler.js');
                        
                        // Use the wallet's telegram ID for the recovery (notifications go to owner)
                        await continueRebalanceFromWalletBalances(
                            bot,
                            wallet.user_telegram_id, // chatId
                            wallet.user_telegram_id, // telegramId
                            position,
                            walletWithKey // walletOverride for auto-recovery
                        );
                        
                        if (isDebug) console.log(`   ✅ Recovery initiated for position ${position.id}`);
                    }
                    
                    // Small delay between recoveries
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                } catch (posError) {
                   console.error(`   ❌ Recovery failed for position ${position.id}:`, posError.message);
                }
            }
            
        } catch (error) {
            console.error('❌ Error in idle funds recovery job:', error.message);
        }
    };
    
    // Run every 10 minutes
    const timer = setInterval(checkAndRecover, RECOVERY_INTERVAL_MS);

    // Run once after 2 minutes on startup (give time for bot to stabilize)
    setTimeout(checkAndRecover, 2 * 60 * 1000);

    if (isDebug) console.log(`🔄 Idle funds recovery job started (checks every ${RECOVERY_INTERVAL_MS / 60000} min, min $${IDLE_FUNDS_RECOVERY_MIN_USD})`);

    return () => {
        clearInterval(timer);
        if (isDebug) console.log('🔄 Idle funds recovery job stopped');
    };
}

/**
 * EVM Out-of-Range Monitor Job
 * Checks every 5 minutes if any EVM wallet positions are out of range.
 * Sends a simple alert message to the wallet owner for each out-of-range position.
 * Skips silently if no EVM wallets exist or no positions are found.
 *
 * @param {TelegramBot} bot - Telegram bot instance
 * @returns {Function} Cleanup function to stop the job
 */
export function startEvmOutOfRangeJob(bot) {
    const EVM_MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    // Tracks per-position out-of-range state: key = `${walletAddress}_${tokenId}`, value = boolean (true = currently out of range)
    const evmRangeState = new Map();

    const checkEvmPositions = async () => {
        try {
            // Query all EVM wallets (addresses start with 0x)
            const evmWallets = await db.select()
                .from(wallets)
                .where(like(wallets.wallet_address, '0x%'));

            if (evmWallets.length === 0) return;

            for (const wallet of evmWallets) {
                try {
                    const evmPositions = await getEvmUniswapPositions(wallet.wallet_address);

                    if (evmPositions.length === 0) continue;

                    for (const pos of evmPositions) {
                        const stateKey = `${wallet.wallet_address}_${pos.tokenId}`;
                        const wasOutOfRange = evmRangeState.get(stateKey);

                        if (!pos.inRange) {
                            // Only notify on first detection of out-of-range
                            if (wasOutOfRange !== true) {
                                evmRangeState.set(stateKey, true);
                                await bot.sendMessage(
                                    wallet.user_telegram_id,
                                    `⭕️ ${pos.poolLabel}\nOut of range`
                                );
                            }
                        } else {
                            // Back in range — notify only if we previously sent an out-of-range alert
                            if (wasOutOfRange === true) {
                                evmRangeState.set(stateKey, false);
                                await bot.sendMessage(
                                    wallet.user_telegram_id,
                                    `✅ ${pos.poolLabel}\nBack in range`
                                );
                            } else if (wasOutOfRange === undefined) {
                                // First time we see this position and it's in range — just record state
                                evmRangeState.set(stateKey, false);
                            }
                        }
                    }
                } catch (err) {
                    console.error(`EVM monitor: Error checking wallet ${wallet.wallet_address}:`, err?.message || err);
                }
            }
        } catch (err) {
            console.error('EVM out-of-range monitor error:', err?.message || err);
        }
    };

    const timer = setInterval(checkEvmPositions, EVM_MONITOR_INTERVAL_MS);

    console.log('🔷 EVM out-of-range monitor started (checks every 5 min)');

    return () => {
        clearInterval(timer);
        console.log('🔷 EVM out-of-range monitor stopped');
    };
}
