CREATE TABLE `terms_acceptance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_telegram_id` integer NOT NULL,
	`tos_version` text NOT NULL,
	`tos_url` text NOT NULL,
	`accepted_at` integer DEFAULT (unixepoch()) NOT NULL,
	`acceptance_method` text DEFAULT 'telegram_button' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terms_acceptance_user_telegram_id_unique` ON `terms_acceptance` (`user_telegram_id`);