import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

import * as schema from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database file path (data directory in project root)
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_PATH = join(DATA_DIR, 'autofarmer.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('📁 Created data directory');
}

// Initialize SQLite connection
const sqlite = new Database(DB_PATH);

// Enable foreign keys and WAL mode for better performance
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('journal_mode = WAL');

// Initialize Drizzle ORM
export const db = drizzle(sqlite, { schema });

console.log(`📦 Database connected: ${DB_PATH}`);

/**
 * Apply manual schema updates for columns added outside of Drizzle migrations
 * This handles columns that may be missing due to migration sync issues or
 * databases copied from older environments
 */
function applyManualSchemaUpdates() {
    try {
        let updatesApplied = 0;
        
        // ============================================================
        // POSITIONS TABLE
        // ============================================================
        const positionsColumns = sqlite.prepare("PRAGMA table_info(positions)").all();
        const posHas = (name) => positionsColumns.some(col => col.name === name);
        
        // Add auto_rebalance_enabled if missing (from migration 0010)
        if (!posHas('auto_rebalance_enabled')) {
            console.log('🔧 Adding auto_rebalance_enabled column to positions table...');
            sqlite.exec("ALTER TABLE positions ADD COLUMN auto_rebalance_enabled INTEGER DEFAULT 0 NOT NULL");
            console.log('✅ Added auto_rebalance_enabled column');
            updatesApplied++;
        }
        
        // Add claim_before_rebalance if missing (from migration 0011)
        if (!posHas('claim_before_rebalance')) {
            console.log('🔧 Adding claim_before_rebalance column to positions table...');
            sqlite.exec("ALTER TABLE positions ADD COLUMN claim_before_rebalance INTEGER DEFAULT 1 NOT NULL");
            console.log('✅ Added claim_before_rebalance column');
            updatesApplied++;
        }
        
        if (!posHas('last_rebalance_type')) {
            console.log('🔧 Adding last_rebalance_type column to positions table...');
            sqlite.exec("ALTER TABLE positions ADD COLUMN last_rebalance_type TEXT DEFAULT 'auto'");
            console.log('✅ Added last_rebalance_type column');
            updatesApplied++;
        }
        
        if (!posHas('manual_range_locked')) {
            console.log('🔧 Adding manual_range_locked column to positions table...');
            sqlite.exec("ALTER TABLE positions ADD COLUMN manual_range_locked INTEGER DEFAULT 0");
            console.log('✅ Added manual_range_locked column');
            updatesApplied++;
        }
        
        // ============================================================
        // POSITION_STATISTICS TABLE
        // ============================================================
        const statsColumns = sqlite.prepare("PRAGMA table_info(position_statistics)").all();
        const statsHas = (name) => statsColumns.some(col => col.name === name);
        
        // Add learned width columns if missing (from migration 0012)
        if (!statsHas('learned_minimum_width')) {
            console.log('🔧 Adding learned_minimum_width column to position_statistics table...');
            sqlite.exec("ALTER TABLE position_statistics ADD COLUMN learned_minimum_width REAL DEFAULT NULL");
            console.log('✅ Added learned_minimum_width column');
            updatesApplied++;
        }
        
        if (!statsHas('learned_width_updated_at')) {
            console.log('🔧 Adding learned_width_updated_at column to position_statistics table...');
            sqlite.exec("ALTER TABLE position_statistics ADD COLUMN learned_width_updated_at INTEGER DEFAULT NULL");
            console.log('✅ Added learned_width_updated_at column');
            updatesApplied++;
        }
        
        if (!statsHas('recent_crossback_widths')) {
            console.log('🔧 Adding recent_crossback_widths column to position_statistics table...');
            sqlite.exec("ALTER TABLE position_statistics ADD COLUMN recent_crossback_widths TEXT DEFAULT NULL");
            console.log('✅ Added recent_crossback_widths column');
            updatesApplied++;
        }
        
        // Add rebalance P/L tracking columns if missing (from migration 0015)
        if (!statsHas('cumulative_rebalance_pl_usd')) {
            console.log('🔧 Adding cumulative_rebalance_pl_usd column to position_statistics table...');
            sqlite.exec("ALTER TABLE position_statistics ADD COLUMN cumulative_rebalance_pl_usd REAL DEFAULT 0 NOT NULL");
            console.log('✅ Added cumulative_rebalance_pl_usd column');
            updatesApplied++;
        }
        
        if (!statsHas('last_rebalance_pl_usd')) {
            console.log('🔧 Adding last_rebalance_pl_usd column to position_statistics table...');
            sqlite.exec("ALTER TABLE position_statistics ADD COLUMN last_rebalance_pl_usd REAL DEFAULT NULL");
            console.log('✅ Added last_rebalance_pl_usd column');
            updatesApplied++;
        }
        
        // ============================================================
        // WALLETS TABLE
        // ============================================================
        const walletsColumns = sqlite.prepare("PRAGMA table_info(wallets)").all();
        const walletHas = (name) => walletsColumns.some(col => col.name === name);
        
        // Add rewards reset columns if missing (from migration 0013)
        if (!walletHas('rewards_at_last_reset_usd')) {
            console.log('🔧 Adding rewards_at_last_reset_usd column to wallets table...');
            sqlite.exec("ALTER TABLE wallets ADD COLUMN rewards_at_last_reset_usd REAL DEFAULT 0 NOT NULL");
            console.log('✅ Added rewards_at_last_reset_usd column');
            updatesApplied++;
        }
        
        if (!walletHas('rewards_reset_at')) {
            console.log('🔧 Adding rewards_reset_at column to wallets table...');
            sqlite.exec("ALTER TABLE wallets ADD COLUMN rewards_reset_at INTEGER DEFAULT NULL");
            console.log('✅ Added rewards_reset_at column');
            updatesApplied++;
        }
        
        if (updatesApplied === 0) {
            console.log('✅ All manual schema updates already applied');
        }
    } catch (error) {
        console.error('❌ Manual schema update failed:', error.message);
        throw error;
    }
}

/**
 * Initialize database with migrations
 * Auto-applies all pending migrations from ./drizzle folder
 *
 * This replaces the old manual CREATE TABLE approach.
 * Schema changes are now managed via:
 * 1. Update schema.js
 * 2. Run: pnpm db:generate
 * 3. Migrations auto-apply on next startup
 */
function initializeDatabase() {
    try {
        console.log('🔧 Applying database migrations...');

        migrate(db, {
            migrationsFolder: join(__dirname, '..', '..', 'drizzle')
        });

        console.log('✅ Database migrations applied successfully');
    } catch (error) {
        // Handle "duplicate column" errors gracefully - column already exists
        if (error.cause?.code === 'SQLITE_ERROR' && error.cause?.message?.includes('duplicate column')) {
            console.log('⚠️  Migration skipped (columns already exist) - continuing with manual schema updates');
        } else {
            console.error('❌ Migration failed:', error.message);
            throw error;
        }
    }
    
    // Always apply manual schema updates - handles missing columns safely
    applyManualSchemaUpdates();
}

/**
 * Close database connection gracefully
 */
export function closeDatabase() {
    sqlite.close();
    console.log('📦 Database connection closed');
}

// Auto-initialize on import (maintains automation)
initializeDatabase();
