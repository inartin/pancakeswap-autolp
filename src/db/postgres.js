import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { wallets } from './postgres-schema.js';
import { env } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Postgres Database Connection
 *
 * ONLY includes:
 * - wallets table
 *
 * All other tables remain in SQLite only
 * Only initializes when NODE_ENV=production
 */

let postgresDb = null;
let postgresSql = null;

if (env.NODE_ENV === 'production') {
    try {
        // Validate POSTGRES_URI exists
        if (!env.POSTGRES_URI) {
            throw new Error('POSTGRES_URI is required when NODE_ENV=production');
        }

        // Create Postgres connection
        postgresSql = postgres(env.POSTGRES_URI, {
            max: 10, // Connection pool size
            idle_timeout: 20,
            connect_timeout: 10,
        });

        // Initialize Drizzle ORM with ONLY wallets
        postgresDb = drizzle(postgresSql, {
            schema: { wallets }
        });

        console.log('📦 Postgres connection initialized');

        // Auto-apply migrations (creates tables if they don't exist)
        try {
            console.log('🔧 Applying Postgres migrations...');

            const migrationsFolder = join(__dirname, '..', '..', 'drizzle-postgres');
            migrate(postgresDb, { migrationsFolder });

            console.log('✅ Postgres migrations applied successfully');
        } catch (migrationError) {
            console.error('❌ Postgres migration failed:', migrationError.message);
            console.error('   Tables may not exist. Run: pnpm drizzle-kit generate --config=drizzle-postgres.config.js');
            throw migrationError;
        }

        console.log('✅ Postgres connected (wallets only)');

    } catch (error) {
        console.error('❌ Failed to initialize Postgres:', error.message);
        console.error('   Dual-database writes will NOT work in production!');
        throw error;
    }

} else {
    console.log('📦 Postgres disabled (development mode - SQLite only)');
}

/**
 * Get Postgres database connection
 * Returns null in development mode
 *
 * @returns {Object|null} Drizzle Postgres instance or null
 */
export function getPostgresDb() {
    return postgresDb;
}

/**
 * Get raw Postgres SQL connection
 * Returns null in development mode
 *
 * @returns {Object|null} Postgres.js instance or null
 */
export function getPostgresSql() {
    return postgresSql;
}

/**
 * Close Postgres connection gracefully
 * Only closes in production mode
 */
export async function closePostgres() {
    if (postgresSql) {
        await postgresSql.end();
        console.log('📦 Postgres connection closed');
    }
}

export { postgresDb, postgresSql };
