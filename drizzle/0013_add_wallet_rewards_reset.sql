-- Migration: Add rewards reset tracking to wallets table
-- Tracks total rewards claimed since last user reset

ALTER TABLE wallets ADD COLUMN rewards_at_last_reset_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE wallets ADD COLUMN rewards_reset_at INTEGER;

