-- Migration: Add SOL price at open for P/L tracking
-- Stores SOL/USD price when position was first opened to enable:
-- 1. Proper lifetime P/L calculation
-- 2. Hypothetical worth calculation at initial SOL price

ALTER TABLE position_statistics ADD COLUMN sol_price_at_open REAL;
