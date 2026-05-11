import { db } from './index.js';
import { postgresDb } from './postgres.js';
import { env } from '../config/env.js';

/**
 * Atomic Write Helper
 *
 * Writes to both SQLite and Postgres with automatic rollback on failure.
 * Guarantees all-or-nothing semantics:
 * - Both databases get the data, OR
 * - Neither database gets the data (rollback)
 *
 * Use Cases:
 * - Wallet creation (must be in both DBs before showing private key)
 * - Any critical data that cannot afford to be lost
 *
 * Development Mode:
 * - Only writes to SQLite (Postgres is null)
 *
 * Production Mode:
 * - Writes to SQLite first, then Postgres
 * - If Postgres fails, rolls back SQLite
 * - Only succeeds if BOTH writes succeed
 */

/**
 * Atomic write to both databases with automatic rollback
 *
 * @param {Object} params
 * @param {Function} params.writeToSqlite - Async function that writes to SQLite, returns created record
 * @param {Function} params.writeToPostgres - Async function that writes to Postgres (receives SQLite record)
 * @param {Function} params.rollbackSqlite - Async function to rollback SQLite write (receives SQLite record)
 * @param {string} params.operationName - Name for logging (e.g., "wallet creation")
 * @returns {Promise<Object>} The created record from SQLite
 * @throws {Error} If any write fails (after rollback attempt)
 */
export async function atomicWrite({
    writeToSqlite,
    writeToPostgres,
    rollbackSqlite,
    operationName
}) {
    let sqliteRecord = null;
    let postgresWriteAttempted = false;

    try {
        // ========================================
        // STEP 1: Write to SQLite
        // ========================================
        console.log(`🔄 ${operationName}: Writing to SQLite...`);
        sqliteRecord = await writeToSqlite();
        console.log(`✅ ${operationName}: SQLite write successful`);

        // ========================================
        // STEP 2: Write to Postgres (production only)
        // ========================================
        if (env.NODE_ENV === 'production') {
            if (!postgresDb) {
                throw new Error('Postgres is not initialized in production mode!');
            }

            console.log(`🔄 ${operationName}: Writing to Postgres...`);
            postgresWriteAttempted = true;

            await writeToPostgres(sqliteRecord);
            console.log(`✅ ${operationName}: Postgres write successful`);

            console.log(`✅ ${operationName}: Complete (both databases updated)`);
        } else {
            console.log(`✅ ${operationName}: Complete (SQLite only - development mode)`);
        }

        // ========================================
        // SUCCESS: Both writes succeeded (or dev mode)
        // ========================================
        return sqliteRecord;

    } catch (error) {
        // ========================================
        // FAILURE: One of the writes failed
        // ========================================
        console.error(`❌ ${operationName}: Failed - ${error.message}`);

        // Rollback SQLite if it was written
        if (sqliteRecord && rollbackSqlite) {
            try {
                console.log(`🔄 ${operationName}: Rolling back SQLite write...`);
                await rollbackSqlite(sqliteRecord);
                console.log(`✅ ${operationName}: Rollback successful - data removed from SQLite`);
            } catch (rollbackError) {
                console.error(`❌ ${operationName}: Rollback failed - ${rollbackError.message}`);
                console.error(`⚠️  CRITICAL: Partial write detected for ${operationName}!`);
                console.error(`⚠️  Manual cleanup may be required for record:`, sqliteRecord);

                // This is a critical state - data is in SQLite but not in Postgres
                // and we couldn't remove it from SQLite
                // Log extra details for debugging
                console.error(`   SQLite record:`, JSON.stringify(sqliteRecord, null, 2));
                console.error(`   Postgres write attempted:`, postgresWriteAttempted);
                console.error(`   Original error:`, error.message);
            }
        }

        // Re-throw error with context so caller knows it failed
        throw new Error(`${operationName} failed: ${error.message}`);
    }
}

/**
 * Verify data consistency between SQLite and Postgres
 *
 * Useful for testing and debugging to ensure both databases have the same data
 *
 * @param {string} tableName - Table name to check
 * @param {Function} fetchFromSqlite - Async function to fetch record from SQLite
 * @param {Function} fetchFromPostgres - Async function to fetch record from Postgres
 * @returns {Promise<boolean>} True if data matches, false otherwise
 */
export async function verifyConsistency(tableName, fetchFromSqlite, fetchFromPostgres) {
    if (env.NODE_ENV !== 'production') {
        console.log(`⏭️  Consistency check skipped (development mode)`);
        return true;
    }

    if (!postgresDb) {
        console.warn(`⚠️  Cannot verify consistency - Postgres not initialized`);
        return false;
    }

    try {
        console.log(`🔍 Verifying consistency for ${tableName}...`);

        const sqliteData = await fetchFromSqlite();
        const postgresData = await fetchFromPostgres();

        // Compare JSON representations
        const sqliteJson = JSON.stringify(sqliteData, Object.keys(sqliteData).sort());
        const postgresJson = JSON.stringify(postgresData, Object.keys(postgresData).sort());

        if (sqliteJson === postgresJson) {
            console.log(`✅ Consistency verified for ${tableName}`);
            return true;
        } else {
            console.error(`❌ Consistency mismatch for ${tableName}:`);
            console.error(`   SQLite:`, sqliteJson);
            console.error(`   Postgres:`, postgresJson);
            return false;
        }
    } catch (error) {
        console.error(`❌ Consistency check failed for ${tableName}:`, error.message);
        return false;
    }
}
