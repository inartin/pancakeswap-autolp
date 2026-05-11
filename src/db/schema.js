import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Database schemas for PancakeSwap Autofarmer
 *
 * Architecture:
 * - Users can have multiple wallets
 * - Each wallet has independent automation settings
 * - Positions are tracked per wallet
 * - Alerts are configured per position
 * - Transaction history per wallet
 */

// ============================================================================
// USERS TABLE
// ============================================================================

/**
 * User profiles (identified by Telegram ID)
 * Each user can have multiple wallets
 */
export const users = sqliteTable('users', {
    telegram_id: integer('telegram_id').primaryKey(),
    active_wallet_id: integer('active_wallet_id'), // FK to wallets, nullable
    created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// ============================================================================
// WALLETS TABLE
// ============================================================================

/**
 * Wallet storage with encrypted private keys
 * Multiple wallets per user, one active at a time
 */
export const wallets = sqliteTable('wallets', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_telegram_id: integer('user_telegram_id').notNull(), // FK to users
    wallet_address: text('wallet_address').notNull().unique(),
    encrypted_private_key: text('encrypted_private_key').notNull(), // Encrypted with MASTER_PASSWORD
    nonce: text('nonce').notNull(), // Encryption nonce (base64)
    salt: text('salt').notNull(), // Key derivation salt (base64)
    label: text('label').notNull().default('My Wallet'), // User-friendly name
    is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true), // Currently selected wallet
    claim_address: text('claim_address'), // Optional: Alternative address for claiming rewards (per-wallet)
    split_strategy: integer('split_strategy', { mode: 'boolean' }).notNull().default(false), // Split strategy for compounding (false = all to one position, true = split between positions)
    rewards_at_last_reset_usd: real('rewards_at_last_reset_usd').notNull().default(0), // Snapshot of total rewards at last reset
    rewards_reset_at: integer('rewards_reset_at', { mode: 'timestamp' }), // When rewards counter was last reset
    created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// ============================================================================
// POSITIONS TABLE
// ============================================================================

/**
 * Tracked PancakeSwap liquidity positions
 * Linked to a specific wallet
 */
export const positions = sqliteTable('positions', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    wallet_id: integer('wallet_id').notNull(), // FK to wallets
    nft_mint: text('nft_mint').notNull().unique(), // Position NFT mint address
    pool_address: text('pool_address').notNull(),
    token0_mint: text('token0_mint').notNull(),
    token1_mint: text('token1_mint').notNull(),
    token0_symbol: text('token0_symbol'),
    token1_symbol: text('token1_symbol'),
    fee_tier: real('fee_tier'), // e.g., 0.0025 for 0.25%
    lower_price: real('lower_price'),
    upper_price: real('upper_price'),
    current_price: real('current_price'),
    liquidity_value_usd: real('liquidity_value_usd'),
    range_percent: real('range_percent'), // Price range percentage used (e.g., 3.0 for ±3%)
    auto_rebalance_enabled: integer('auto_rebalance_enabled', { mode: 'boolean' }).notNull().default(false), // Per-position auto-rebalance toggle
    claim_before_rebalance: integer('claim_before_rebalance', { mode: 'boolean' }).notNull().default(true), // Claim rewards before rebalancing (auto & manual)
    
    // Manual override protection (Phase 5: New Strategy)
    last_rebalance_type: text('last_rebalance_type').default('auto'), // 'auto' | 'manual' - tracks who triggered last rebalance
    manual_range_locked: integer('manual_range_locked', { mode: 'boolean' }).default(false), // Lock range if user manually set <1%
    
    status: text('status').notNull().default('active'), // active, closed
    created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// ============================================================================
// PROXIMITY ALERTS TABLE
// ============================================================================

/**
 * Proximity alert configurations per position
 * Alerts user before position goes out of range
 */
export const proximity_alerts = sqliteTable('proximity_alerts', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    position_id: integer('position_id').notNull(), // FK to positions
    threshold_percentage: real('threshold_percentage').notNull(), // e.g., 10.0 for 10%
    lower_alert_price: real('lower_alert_price').notNull(), // Calculated trigger price
    upper_alert_price: real('upper_alert_price').notNull(), // Calculated trigger price
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    // Out-of-range alert configuration
    out_of_range_enabled: integer('out_of_range_enabled', { mode: 'boolean' }).notNull().default(true),
    out_of_range_cooldown_minutes: integer('out_of_range_cooldown_minutes').notNull().default(60),
    last_triggered_at: integer('last_triggered_at', { mode: 'timestamp' }), // null if never triggered
    created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// ============================================================================
// ALERT HISTORY TABLE
// ============================================================================

/**
 * Log of all triggered alerts
 * Tracks user responses and actions taken
 */
export const alert_history = sqliteTable('alert_history', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    position_id: integer('position_id').notNull(), // FK to positions
    alert_type: text('alert_type').notNull(), // proximity, out_of_range, reward_threshold
    price_at_alert: real('price_at_alert'),
    proximity_threshold_percent: real('proximity_threshold_percent'), // Threshold % when proximity alert triggered (e.g., 10.0)
    message_sent: integer('message_sent', { mode: 'boolean' }).notNull().default(false),
    user_action: text('user_action'), // rebalanced, snoozed, ignored, null
    triggered_at: integer('triggered_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// ============================================================================
// AUTOMATION SETTINGS TABLE
// ============================================================================

/**
 * Automation configuration per wallet
 * Controls auto-compound and auto-rebalance behavior
 */
export const automation_settings = sqliteTable('automation_settings', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    wallet_id: integer('wallet_id').notNull().unique(), // FK to wallets (one config per wallet)

    // Auto-compound settings
    auto_compound_enabled: integer('auto_compound_enabled', { mode: 'boolean' }).notNull().default(false),
    compound_frequency_value: integer('compound_frequency_value').default(1), // e.g., 1, 6, 12, 24
    compound_frequency_unit: text('compound_frequency_unit').default('days'), // hours, days, weeks
    compound_threshold_usd: real('compound_threshold_usd').default(25.0), // Min USD to trigger compound

    // Auto-rebalance settings
    auto_rebalance_enabled: integer('auto_rebalance_enabled', { mode: 'boolean' }).notNull().default(false),
    rebalance_strategy: text('rebalance_strategy').default('centered'), // centered, aggressive, conservative

    created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// ============================================================================
// TRANSACTIONS TABLE
// ============================================================================

/**
 * Transaction history for all wallet operations
 * Tracks claims, compounds, rebalances, and position closures
 */
export const transactions = sqliteTable('transactions', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    wallet_id: integer('wallet_id').notNull(), // FK to wallets
    position_id: integer('position_id'), // FK to positions (nullable for wallet-level txs)
    tx_signature: text('tx_signature').notNull().unique(), // Solana transaction signature
    tx_type: text('tx_type').notNull(), // claim, compound, rebalance, close, open
    token_amounts: text('token_amounts'), // JSON: { token0: amount, token1: amount, ... }
    fee_amount_sol: real('fee_amount_sol'), // Transaction fee paid
    status: text('status').notNull().default('pending'), // pending, success, failed
    error_message: text('error_message'), // Error details if failed
    executed_at: integer('executed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// ============================================================================
// SECURITY AUDIT LOG TABLE
// ============================================================================

/**
 * Security audit log for sensitive operations
 * Tracks private key exports and other security-critical actions
 */
export const security_audit_log = sqliteTable('security_audit_log', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_telegram_id: integer('user_telegram_id').notNull(), // FK to users
    wallet_id: integer('wallet_id').notNull(), // FK to wallets
    action_type: text('action_type').notNull(), // private_key_export, wallet_deleted, etc.
    metadata: text('metadata'), // JSON: Additional context (e.g., { telegram_username: 'user123' })
    created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

/**
 * Position statistics and automation state
 * Tracks metrics for monitoring and auto-rebalance decisions
 */
export const position_statistics = sqliteTable('position_statistics', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    position_id: integer('position_id').notNull().unique(), // FK to positions (1-to-1)
    
    // ============================================================================
    // TIME TRACKING
    // ============================================================================
    first_monitored_at: integer('first_monitored_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    last_price_check_at: integer('last_price_check_at', { mode: 'timestamp' }),
    
    // Accumulated time (in milliseconds for precision)
    time_in_range_ms: integer('time_in_range_ms').notNull().default(0),
    time_out_of_range_ms: integer('time_out_of_range_ms').notNull().default(0),
    
    // Current OOR episode tracking
    current_oor_started_at: integer('current_oor_started_at', { mode: 'timestamp' }), // null if in range
    in_range: integer('in_range', { mode: 'boolean' }).notNull().default(true),
    
    // ============================================================================
    // REBALANCE TRACKING
    // ============================================================================
    last_rebalance_at: integer('last_rebalance_at', { mode: 'timestamp' }),
    rebalances_count_lifetime: integer('rebalances_count_lifetime').notNull().default(0),
    rebalances_today: integer('rebalances_today').notNull().default(0),
    daily_reset_at: integer('daily_reset_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`), // Last UTC midnight
    
    // ============================================================================
    // CHOP CONTROL (Section 4 of your plan)
    // ============================================================================
    crossbacks_90m: integer('crossbacks_90m').notNull().default(0), // How many re-entries in last 90min
    last_crossback_at: integer('last_crossback_at', { mode: 'timestamp' }),
    
    // ============================================================================
    // LEARNED WIDTH TRACKING
    // ============================================================================
    learned_minimum_width: real('learned_minimum_width'), // Minimum width needed based on crossback history
    learned_width_updated_at: integer('learned_width_updated_at', { mode: 'timestamp' }), // When learning was updated
    recent_crossback_widths: text('recent_crossback_widths'), // JSON: [[width, timestamp], ...] for learning
    
    // ============================================================================
    // MODE STATE MACHINE (Section 2 of your plan)
    // ============================================================================
    current_mode: text('current_mode').notNull().default('TIGHT'), // TIGHT, WIDE, TURBO, GUARD_ONLY
    mode_changed_at: integer('mode_changed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    active_width_pct: real('active_width_pct').notNull().default(0.6), // Current position width
    guard_width_pct: real('guard_width_pct').notNull().default(0.9), // Guard band width (1.5x active)
    
    // ============================================================================
    // FINANCIAL TRACKING
    // ============================================================================
    usd_value_on_open: real('usd_value_on_open').notNull().default(0), // Initial position value
    sol_price_at_open: real('sol_price_at_open'), // SOL/USD price when position first opened (for P/L calculation)
    total_claimed_usd: real('total_claimed_usd').notNull().default(0), // Lifetime claimed rewards
    total_compounded_usd: real('total_compounded_usd').notNull().default(0), // Lifetime compounded
    total_fees_earned_usd: real('total_fees_earned_usd').notNull().default(0), // Estimated trading fees
    total_rebalance_cost_usd: real('total_rebalance_cost_usd').notNull().default(0), // Cumulative rebalance costs
    last_rebalance_cost_usd: real('last_rebalance_cost_usd'), // Most recent rebalance cost
    
    // Rebalance P/L tracking (from worth tracking system)
    cumulative_rebalance_pl_usd: real('cumulative_rebalance_pl_usd').notNull().default(0), // Cumulative P/L from all rebalances (negative = loss, positive = gain)
    last_rebalance_pl_usd: real('last_rebalance_pl_usd'), // P/L from most recent rebalance
    
    // Transaction fee tracking (SOL spent on blockchain transactions)
    total_claim_fees_sol: real('total_claim_fees_sol').notNull().default(0), // Cumulative claim transaction fees
    total_compound_fees_sol: real('total_compound_fees_sol').notNull().default(0), // Cumulative compound transaction fees
    last_claim_fee_sol: real('last_claim_fee_sol'), // Most recent claim transaction fee
    last_compound_fee_sol: real('last_compound_fee_sol'), // Most recent compound total fee
    compound_transactions_count: integer('compound_transactions_count').notNull().default(0), // Number of compound operations
    claim_transactions_count: integer('claim_transactions_count').notNull().default(0), // Number of claim operations
    
    // ============================================================================
    // PERFORMANCE METRICS (Useful for analysis)
    // ============================================================================
    net_pnl_usd: real('net_pnl_usd').notNull().default(0), // (fees_earned + compounded) - rebalance_costs - transaction_fees
    roi_percent: real('roi_percent'), // (net_pnl / initial_value) * 100
    time_in_range_percent: real('time_in_range_percent'), // (time_in_range / total_time) * 100
    total_transaction_fees_usd: real('total_transaction_fees_usd').notNull().default(0), // (claim_fees + compound_fees) in USD
    
    created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// ============================================================================
// INDEXES FOR PERFORMANCE
// ============================================================================

// ============================================================================
// PRICE HISTORY TABLE (for auto-rebalancing)
// ============================================================================

/**
 * SOL/USD price history for market data analysis
 * 
 * Stores 1-minute candles for TWAP, ATR, and drift calculations
 * Retention: 2 hours rolling window (120 candles)
 */
export const price_history = sqliteTable('price_history', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: integer('timestamp').notNull().unique(), // Unix timestamp in seconds (candle open time)
    open: real('open').notNull(),       // Opening price
    high: real('high').notNull(),       // Highest price in candle
    low: real('low').notNull(),         // Lowest price in candle
    close: real('close').notNull(),     // Closing price
    volume: real('volume').notNull(),   // Trading volume
    created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// ============================================================================
// POSITION APR HISTORY TABLE (for average APR tracking)
// ============================================================================

/**
 * Position APR history for calculating daily/monthly averages
 * 
 * Records APR snapshots periodically (every ~4 hours) to enable
 * average APR calculations over time.
 * Retention: 45 days rolling window
 */
export const position_apr_history = sqliteTable('position_apr_history', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    position_id: integer('position_id').notNull(), // FK to positions
    recorded_at: integer('recorded_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    position_apr: real('position_apr'),           // Calculated position-specific APR
    pool_apr: real('pool_apr'),                   // Pool baseline APR
    in_range: integer('in_range', { mode: 'boolean' }).notNull(), // Whether position was in range
    position_value_usd: real('position_value_usd'), // Position value at recording time
    range_percent: real('range_percent')          // Position range width percentage (e.g., 0.6 for ±0.6%)
});

/**
 * Recommended indexes (to be created in migration):
 *
 * CREATE INDEX idx_wallets_user_id ON wallets(user_telegram_id);
 * CREATE INDEX idx_wallets_active ON wallets(user_telegram_id, is_active);
 * CREATE INDEX idx_positions_wallet_id ON positions(wallet_id);
 * CREATE INDEX idx_positions_status ON positions(wallet_id, status);
 * CREATE INDEX idx_proximity_alerts_position ON proximity_alerts(position_id);
 * CREATE INDEX idx_alert_history_position ON alert_history(position_id);
 * CREATE INDEX idx_alert_history_date ON alert_history(triggered_at);
 * CREATE INDEX idx_transactions_wallet ON transactions(wallet_id);
 * CREATE INDEX idx_transactions_signature ON transactions(tx_signature);
 * CREATE INDEX idx_security_audit_user ON security_audit_log(user_telegram_id);
 * CREATE INDEX idx_security_audit_wallet ON security_audit_log(wallet_id);
 * CREATE INDEX idx_security_audit_action ON security_audit_log(action_type);
 * CREATE INDEX idx_security_audit_date ON security_audit_log(created_at);
 * CREATE UNIQUE INDEX idx_price_history_timestamp ON price_history(timestamp);
 * CREATE INDEX idx_price_history_time_desc ON price_history(timestamp DESC);
 * CREATE INDEX idx_apr_history_position_time ON position_apr_history(position_id, recorded_at DESC);
 * CREATE INDEX idx_apr_history_recorded_at ON position_apr_history(recorded_at);
 */
