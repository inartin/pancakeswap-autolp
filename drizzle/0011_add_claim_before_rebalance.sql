-- Migration: Add claim_before_rebalance to positions table
-- Adds per-position control for claiming rewards before rebalancing
-- Default: true (enabled by default)

ALTER TABLE positions ADD COLUMN claim_before_rebalance INTEGER DEFAULT 1 NOT NULL;

