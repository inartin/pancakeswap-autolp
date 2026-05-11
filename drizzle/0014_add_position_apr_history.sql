-- Migration: Add position APR history table for tracking daily/monthly averages
-- Records APR snapshots periodically to calculate average APR over time

CREATE TABLE IF NOT EXISTS position_apr_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
    position_apr REAL,           -- Calculated position-specific APR
    pool_apr REAL,               -- Pool baseline APR
    in_range INTEGER NOT NULL,   -- Whether position was in range (0/1)
    position_value_usd REAL,     -- Position value at recording time
    range_percent REAL           -- Position range width percentage (e.g., 0.6 for ±0.6%)
);

-- Index for efficient queries by position and time
CREATE INDEX IF NOT EXISTS idx_apr_history_position_time ON position_apr_history(position_id, recorded_at DESC);

-- Index for cleanup queries (delete old records)
CREATE INDEX IF NOT EXISTS idx_apr_history_recorded_at ON position_apr_history(recorded_at);


