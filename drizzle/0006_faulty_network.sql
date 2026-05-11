ALTER TABLE `position_statistics` ADD `total_claim_fees_sol` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `position_statistics` ADD `total_compound_fees_sol` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `position_statistics` ADD `last_claim_fee_sol` real;--> statement-breakpoint
ALTER TABLE `position_statistics` ADD `last_compound_fee_sol` real;--> statement-breakpoint
ALTER TABLE `position_statistics` ADD `compound_transactions_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `position_statistics` ADD `claim_transactions_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `position_statistics` ADD `total_transaction_fees_usd` real DEFAULT 0 NOT NULL;