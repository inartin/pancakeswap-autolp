import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit Configuration for Postgres
 *
 * This config is specifically for Postgres migrations
 * ONLY includes the wallets table
 * All other tables remain in SQLite only
 */
export default defineConfig({
    // Database dialect
    dialect: 'postgresql',

    // Schema location - uses postgres-schema.js which only exports wallets
    schema: './src/db/postgres-schema.js',

    // Migration files output directory (separate from SQLite)
    out: './drizzle-postgres',

    // Database connection
    dbCredentials: {
        url: process.env.POSTGRES_URI
    },

    // Options
    verbose: true,  // Print SQL statements
    strict: true    // Enable strict mode
});
