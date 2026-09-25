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
 * Initialize database with migrations
 * Auto-applies all pending migrations from ./drizzle folder
 *
 * Schema changes are managed via:
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
        if (error.cause?.code === 'SQLITE_ERROR' && error.cause?.message?.includes('duplicate column')) {
            console.log('⚠️  Migration skipped (column already exists)');
        } else {
            console.error('❌ Migration failed:', error.message);
            throw error;
        }
    }

    // Ensure positions table has is_hidden column
    try {
        const positionsCols = sqlite.prepare("PRAGMA table_info(positions)").all();
        if (!positionsCols.some(c => c.name === 'is_hidden')) {
            sqlite.exec("ALTER TABLE positions ADD COLUMN is_hidden INTEGER DEFAULT 0 NOT NULL");
            console.log('✅ Added is_hidden column to positions table');
        }
    } catch (colErr) {
        console.warn('⚠️ Column check for is_hidden:', colErr.message);
    }
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
