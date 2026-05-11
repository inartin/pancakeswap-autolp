CREATE TABLE `alert_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`alert_type` text NOT NULL,
	`price_at_alert` real,
	`proximity_threshold_percent` real,
	`message_sent` integer DEFAULT false NOT NULL,
	`user_action` text,
	`triggered_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `automation_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet_id` integer NOT NULL,
	`auto_compound_enabled` integer DEFAULT false NOT NULL,
	`compound_frequency_value` integer DEFAULT 1,
	`compound_frequency_unit` text DEFAULT 'days',
	`compound_threshold_usd` real DEFAULT 25,
	`auto_rebalance_enabled` integer DEFAULT false NOT NULL,
	`rebalance_strategy` text DEFAULT 'centered',
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_settings_wallet_id_unique` ON `automation_settings` (`wallet_id`);--> statement-breakpoint
CREATE TABLE `position_apr_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch()) NOT NULL,
	`position_apr` real,
	`pool_apr` real,
	`in_range` integer NOT NULL,
	`position_value_usd` real,
	`range_percent` real
);
--> statement-breakpoint
CREATE INDEX `idx_apr_history_position_time` ON `position_apr_history` (`position_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `idx_apr_history_recorded_at` ON `position_apr_history` (`recorded_at`);--> statement-breakpoint
CREATE TABLE `position_statistics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`first_monitored_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_price_check_at` integer,
	`time_in_range_ms` integer DEFAULT 0 NOT NULL,
	`time_out_of_range_ms` integer DEFAULT 0 NOT NULL,
	`current_oor_started_at` integer,
	`in_range` integer DEFAULT true NOT NULL,
	`last_rebalance_at` integer,
	`rebalances_count_lifetime` integer DEFAULT 0 NOT NULL,
	`rebalances_today` integer DEFAULT 0 NOT NULL,
	`daily_reset_at` integer DEFAULT (unixepoch()) NOT NULL,
	`crossbacks_90m` integer DEFAULT 0 NOT NULL,
	`last_crossback_at` integer,
	`learned_minimum_width` real,
	`learned_width_updated_at` integer,
	`recent_crossback_widths` text,
	`current_mode` text DEFAULT 'TIGHT' NOT NULL,
	`mode_changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`active_width_pct` real DEFAULT 0.6 NOT NULL,
	`guard_width_pct` real DEFAULT 0.9 NOT NULL,
	`usd_value_on_open` real DEFAULT 0 NOT NULL,
	`sol_price_at_open` real,
	`total_claimed_usd` real DEFAULT 0 NOT NULL,
	`total_compounded_usd` real DEFAULT 0 NOT NULL,
	`total_fees_earned_usd` real DEFAULT 0 NOT NULL,
	`total_rebalance_cost_usd` real DEFAULT 0 NOT NULL,
	`last_rebalance_cost_usd` real,
	`cumulative_rebalance_pl_usd` real DEFAULT 0 NOT NULL,
	`last_rebalance_pl_usd` real,
	`total_claim_fees_sol` real DEFAULT 0 NOT NULL,
	`total_compound_fees_sol` real DEFAULT 0 NOT NULL,
	`last_claim_fee_sol` real,
	`last_compound_fee_sol` real,
	`compound_transactions_count` integer DEFAULT 0 NOT NULL,
	`claim_transactions_count` integer DEFAULT 0 NOT NULL,
	`net_pnl_usd` real DEFAULT 0 NOT NULL,
	`roi_percent` real,
	`time_in_range_percent` real,
	`total_transaction_fees_usd` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `position_statistics_position_id_unique` ON `position_statistics` (`position_id`);--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet_id` integer NOT NULL,
	`nft_mint` text NOT NULL,
	`pool_address` text NOT NULL,
	`token0_mint` text NOT NULL,
	`token1_mint` text NOT NULL,
	`token0_symbol` text,
	`token1_symbol` text,
	`fee_tier` real,
	`lower_price` real,
	`upper_price` real,
	`current_price` real,
	`liquidity_value_usd` real,
	`range_percent` real,
	`auto_rebalance_enabled` integer DEFAULT false NOT NULL,
	`claim_before_rebalance` integer DEFAULT true NOT NULL,
	`last_rebalance_type` text DEFAULT 'auto',
	`manual_range_locked` integer DEFAULT false,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `positions_nft_mint_unique` ON `positions` (`nft_mint`);--> statement-breakpoint
CREATE TABLE `price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_history_timestamp_unique` ON `price_history` (`timestamp`);--> statement-breakpoint
CREATE TABLE `proximity_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`threshold_percentage` real NOT NULL,
	`lower_alert_price` real NOT NULL,
	`upper_alert_price` real NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`out_of_range_enabled` integer DEFAULT true NOT NULL,
	`out_of_range_cooldown_minutes` integer DEFAULT 60 NOT NULL,
	`last_triggered_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `security_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_telegram_id` integer NOT NULL,
	`wallet_id` integer NOT NULL,
	`action_type` text NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet_id` integer NOT NULL,
	`position_id` integer,
	`tx_signature` text NOT NULL,
	`tx_type` text NOT NULL,
	`token_amounts` text,
	`fee_amount_sol` real,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`executed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_tx_signature_unique` ON `transactions` (`tx_signature`);--> statement-breakpoint
CREATE TABLE `users` (
	`telegram_id` integer PRIMARY KEY NOT NULL,
	`active_wallet_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_telegram_id` integer NOT NULL,
	`wallet_address` text NOT NULL,
	`encrypted_private_key` text NOT NULL,
	`nonce` text NOT NULL,
	`salt` text NOT NULL,
	`label` text DEFAULT 'My Wallet' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`claim_address` text,
	`split_strategy` integer DEFAULT false NOT NULL,
	`rewards_at_last_reset_usd` real DEFAULT 0 NOT NULL,
	`rewards_reset_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_wallet_address_unique` ON `wallets` (`wallet_address`);