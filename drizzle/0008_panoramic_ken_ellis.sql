ALTER TABLE `wallets` ADD `claim_address` text;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `claim_address`;