-- Migration: Add learned width tracking to position_statistics table
-- Tracks minimum width needed based on crossback history

ALTER TABLE position_statistics ADD COLUMN learned_minimum_width REAL;
ALTER TABLE position_statistics ADD COLUMN learned_width_updated_at INTEGER;
ALTER TABLE position_statistics ADD COLUMN recent_crossback_widths TEXT;

