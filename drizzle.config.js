import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit Configuration
 *
 * This config enables Drizzle's migration system:
 * - Generate migrations: pnpm db:generate
 * - View database: pnpm db:studio
 * - Migrations auto-apply on app startup
 */
export default defineConfig({
    // Database dialect
    dialect: 'sqlite',

    // Schema location (source of truth)
    schema: './src/db/schema.js',

    // Migration files output directory
    out: './drizzle',

    // Database connection
    dbCredentials: {
        url: './data/autofarmer.db'
    },

    // Options
    verbose: true,  // Print SQL statements
    strict: true    // Enable strict mode
});
