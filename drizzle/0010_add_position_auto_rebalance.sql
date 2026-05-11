-- Add auto_rebalance_enabled column to positions table
-- This enables per-position control of auto-rebalance feature
-- Default: false (disabled) - users must explicitly enable per position

ALTER TABLE positions ADD COLUMN auto_rebalance_enabled INTEGER DEFAULT 0 NOT NULL;

