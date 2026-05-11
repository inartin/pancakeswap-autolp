import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * User Service
 * Handles user CRUD operations
 *
 * STATUS: ✅ ACTIVE (Phase 2)
 *
 * PHASE: Phase 2 - Core Functionality
 *
 * CURRENT USE:
 * - User creation and management
 * - Active wallet tracking
 * - User lookup and validation
 *
 * HANDLERS USING THIS:
 * - newwallet.handler.js - Creates user on first wallet generation
 * - importwallet.handler.js - Gets/creates user on wallet import
 */

/**
 * Get user by Telegram ID
 *
 * @param {number} telegramId - Telegram user ID
 * @returns {Promise<Object|null>} User object or null if not found
 */
export async function getUserByTelegramId(telegramId) {
    const result = await db.select()
        .from(users)
        .where(eq(users.telegram_id, telegramId))
        .limit(1);

    return result[0] || null;
}

/**
 * Create new user
 *
 * @param {number} telegramId - Telegram user ID
 * @returns {Promise<Object>} Created user
 */
export async function createUser(telegramId) {
    const result = await db.insert(users)
        .values({
            telegram_id: telegramId
        })
        .returning();

    return result[0];
}

/**
 * Get or create user
 * Convenience function for user initialization
 *
 * @param {number} telegramId - Telegram user ID
 * @returns {Promise<Object>} User object
 */
export async function getOrCreateUser(telegramId) {
    let user = await getUserByTelegramId(telegramId);

    if (!user) {
        user = await createUser(telegramId);
    }

    return user;
}

/**
 * Update user's active wallet
 *
 * @param {number} telegramId - Telegram user ID
 * @param {number} walletId - Wallet ID to set as active
 * @returns {Promise<Object>} Updated user
 */
export async function setActiveWallet(telegramId, walletId) {
    const result = await db.update(users)
        .set({
            active_wallet_id: walletId,
            updated_at: new Date()
        })
        .where(eq(users.telegram_id, telegramId))
        .returning();

    return result[0];
}

/**
 * Check if user exists
 *
 * @param {number} telegramId - Telegram user ID
 * @returns {Promise<boolean>} True if user exists
 */
export async function userExists(telegramId) {
    const user = await getUserByTelegramId(telegramId);
    return user !== null;
}
