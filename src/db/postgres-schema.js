import { pgTable, text, integer, serial, timestamp, boolean } from 'drizzle-orm/pg-core';

/**
 * Postgres Schema
 *
 * CRITICAL: This schema must match schema.js EXACTLY
 * but uses pgTable instead of sqliteTable
 *
 * ONLY includes:
 * - wallets
 */

/**
 * Wallets Table (Postgres version)
 * Must match src/db/schema.js wallets table exactly
 */
export const wallets = pgTable('wallets', {
    id: serial('id').primaryKey(),
    user_telegram_id: integer('user_telegram_id').notNull(),
    wallet_address: text('wallet_address').notNull().unique(),
    encrypted_private_key: text('encrypted_private_key').notNull(),
    nonce: text('nonce').notNull(),
    salt: text('salt').notNull(),
    label: text('label').notNull().default('My Wallet'),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow()
});
