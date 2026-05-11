CREATE TABLE `alert_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer NOT NULL,
	`alert_type` text NOT NULL,
	`price_at_alert` real,
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
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `positions_nft_mint_unique` ON `positions` (`nft_mint`);--> statement-breakpoint
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_wallet_address_unique` ON `wallets` (`wallet_address`);