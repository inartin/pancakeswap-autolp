CREATE TABLE `meteora_fee_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_address` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`fee_x` text NOT NULL,
	`fee_y` text NOT NULL,
	`decimals_x` integer NOT NULL,
	`decimals_y` integer NOT NULL,
	`price_x` real,
	`price_y` real,
	`position_value_usd` real,
	`in_range` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_meteora_fee_samples_position_time` ON `meteora_fee_samples` (`position_address`,`recorded_at`);