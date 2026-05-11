-- Migration: Add rebalance P/L tracking fields
-- Tracks profit/loss from rebalancing operations (slippage, fees, IL impact)

ALTER TABLE position_statistics ADD COLUMN cumulative_rebalance_pl_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE position_statistics ADD COLUMN last_rebalance_pl_usd REAL;
