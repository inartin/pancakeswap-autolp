import { db } from '../db/index.js';
import { postgresDb } from '../db/postgres.js';
import { atomicWrite } from '../db/atomicWrite.js';
import { wallets, users, positions, position_statistics } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { encryptPrivateKey, decryptPrivateKey } from '../utils/encryption.util.js';
import { env } from '../config/env.js';

/**
 * Wallet Service
 * Handles wallet CRUD operations and multi-wallet management
 *
 * STATUS: ✅ ACTIVE (Phase 2)
 *
 * PHASE: Phase 2 - Core Functionality
 *
 * CURRENT USE:
 * - Multi-wallet management (up to 3 wallets per user)
 * - Private key encryption/decryption (libsodium)
 * - Active wallet switching
 * - Wallet creation, import, export, deletion
 *
 * HANDLERS USING THIS:
 * - newwallet.handler.js - Creates encrypted wallets
 * - importwallet.handler.js - Imports existing wallets
 * - exportkey.handler.js - Exports private keys securely
 * - walletinfo.handler.js - Shows wallet details
 * - rewards.handler.js - Gets active wallet for rewards
 * - start.handler.js - Checks wallet existence
 */

/**
 * Create new wallet for user
 * Uses atomic write to ensure wallet is stored in BOTH databases (production)
 * before returning success to the caller
 *
 * CRITICAL: Private key is only shown to user AFTER this function returns successfully,
 * which means it's guaranteed to be in both databases
 *
 * @param {number} telegramId - Telegram user ID
 * @param {string} walletAddress - Solana wallet address
 * @param {string} privateKey - Unencrypted private key (base58)
 * @param {string} label - Wallet label (optional)
 * @returns {Promise<Object>} Created wallet (without private key)
 */
export async function createWallet(telegramId, walletAddress, privateKey, label = 'My Wallet') {
    // Encrypt private key BEFORE any database writes
    const { encryptedKey, nonce, salt } = encryptPrivateKey(privateKey, env.MASTER_PASSWORD);

    const walletData = {
        user_telegram_id: telegramId,
        wallet_address: walletAddress,
        encrypted_private_key: encryptedKey,
        nonce: nonce,
        salt: salt,
        label: label,
        is_active: true
    };

    // Deactivate all other wallets for this user BEFORE atomic write
    await db.update(wallets)
        .set({ is_active: false })
        .where(eq(wallets.user_telegram_id, telegramId));

    // Atomic write to both databases (or SQLite only in dev)
    const wallet = await atomicWrite({
        operationName: 'Wallet creation',

        writeToSqlite: async () => {
            const result = await db.insert(wallets)
                .values(walletData)
                .returning();
            return result[0];
        },

        writeToPostgres: async (createdWallet) => {
            // Write to Postgres with only the data fields (let Postgres auto-generate id and timestamps)
            await postgresDb.insert(wallets)
                .values(walletData)
                .onConflictDoNothing();
        },

        rollbackSqlite: async (createdWallet) => {
            await db.delete(wallets)
                .where(eq(wallets.id, createdWallet.id));
        }
    });

    // Update user's active_wallet_id (only after atomic write succeeds)
    await db.update(users)
        .set({ active_wallet_id: wallet.id })
        .where(eq(users.telegram_id, telegramId));

    // Return wallet without private key
    // Handler will show private key to user ONLY after this returns
    const { encrypted_private_key, nonce: _, salt: __, ...safeWallet } = wallet;
    return safeWallet;
}

/**
 * Create a read-only EVM wallet for user
 * No private key — stores placeholder encryption fields
 *
 * @param {number} telegramId - Telegram user ID
 * @param {string} evmAddress - Checksummed EVM address (0x...)
 * @param {string} label - Wallet label
 * @returns {Promise<Object>} Created wallet (without encryption fields)
 */
export async function createEvmWallet(telegramId, evmAddress, label = 'EVM Wallet') {
    const walletData = {
        user_telegram_id: telegramId,
        wallet_address: evmAddress,
        encrypted_private_key: 'readonly',
        nonce: 'readonly',
        salt: 'readonly',
        label: label,
        is_active: true
    };

    // Deactivate all other wallets for this user
    await db.update(wallets)
        .set({ is_active: false })
        .where(eq(wallets.user_telegram_id, telegramId));

    const wallet = await atomicWrite({
        operationName: 'EVM Wallet creation',

        writeToSqlite: async () => {
            const result = await db.insert(wallets)
                .values(walletData)
                .returning();
            return result[0];
        },

        writeToPostgres: async (createdWallet) => {
            await postgresDb.insert(wallets)
                .values(walletData)
                .onConflictDoNothing();
        },

        rollbackSqlite: async (createdWallet) => {
            await db.delete(wallets)
                .where(eq(wallets.id, createdWallet.id));
        }
    });

    await db.update(users)
        .set({ active_wallet_id: wallet.id })
        .where(eq(users.telegram_id, telegramId));

    const { encrypted_private_key, nonce: _, salt: __, ...safeWallet } = wallet;
    return safeWallet;
}

/**
 * Get wallet by ID
 *
 * @param {number} walletId - Wallet ID
 * @returns {Promise<Object|null>} Wallet object (without private key) or null
 */
export async function getWalletById(walletId) {
    const result = await db.select()
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

    if (result.length === 0) return null;

    const { encrypted_private_key, nonce, salt, ...safeWallet } = result[0];
    return safeWallet;
}

/**
 * Get all wallets for a user
 *
 * @param {number} telegramId - Telegram user ID
 * @returns {Promise<Array>} Array of wallets (without private keys)
 */
export async function getUserWallets(telegramId) {
    const result = await db.select()
        .from(wallets)
        .where(eq(wallets.user_telegram_id, telegramId));

    // Strip private key data
    return result.map(({ encrypted_private_key, nonce, salt, ...safeWallet }) => safeWallet);
}

/**
 * Get active wallet for user
 *
 * @param {number} telegramId - Telegram user ID
 * @returns {Promise<Object|null>} Active wallet or null
 */
export async function getActiveWallet(telegramId) {
    const result = await db.select()
        .from(wallets)
        .where(and(
            eq(wallets.user_telegram_id, telegramId),
            eq(wallets.is_active, true)
        ))
        .limit(1);

    if (result.length === 0) return null;

    const { encrypted_private_key, nonce, salt, ...safeWallet } = result[0];
    return safeWallet;
}

/**
 * Get active wallet WITH encryption data (for transaction signing)
 * SECURITY: Only use this for handlers that need to decrypt the private key
 *
 * @param {number} telegramId - Telegram user ID
 * @returns {Promise<Object|null>} Active wallet with encryption fields or null
 */
export async function getActiveWalletWithEncryption(telegramId) {
    const result = await db.select()
        .from(wallets)
        .where(and(
            eq(wallets.user_telegram_id, telegramId),
            eq(wallets.is_active, true)
        ))
        .limit(1);

    if (result.length === 0) return null;

    return result[0]; // Return full wallet including encryption fields
}

/**
 * Get wallet by ID WITH encryption data (for transaction signing)
 * SECURITY: Only use this for internal services that need to sign transactions
 *
 * @param {number} walletId - Wallet ID
 * @returns {Promise<Object|null>} Wallet with encryption fields or null
 */
export async function getWalletByIdWithEncryption(walletId) {
    const result = await db.select()
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

    if (result.length === 0) return null;

    return result[0]; // Return full wallet including encryption fields
}

/**
 * Switch active wallet for user
 *
 * @param {number} telegramId - Telegram user ID
 * @param {number} walletId - Wallet ID to activate
 * @returns {Promise<Object>} Newly active wallet
 */
export async function switchActiveWallet(telegramId, walletId) {
    // Verify wallet belongs to user
    const wallet = await db.select()
        .from(wallets)
        .where(and(
            eq(wallets.id, walletId),
            eq(wallets.user_telegram_id, telegramId)
        ))
        .limit(1);

    if (wallet.length === 0) {
        throw new Error('Wallet not found or does not belong to user');
    }

    // Deactivate all wallets for this user
    await db.update(wallets)
        .set({ is_active: false })
        .where(eq(wallets.user_telegram_id, telegramId));

    // Activate selected wallet
    const result = await db.update(wallets)
        .set({
            is_active: true,
            updated_at: new Date()
        })
        .where(eq(wallets.id, walletId))
        .returning();

    // Update user's active_wallet_id
    await db.update(users)
        .set({ active_wallet_id: walletId })
        .where(eq(users.telegram_id, telegramId));

    const { encrypted_private_key, nonce, salt, ...safeWallet } = result[0];
    return safeWallet;
}

/**
 * Get decrypted private key for wallet
 * SECURITY: Only call this when absolutely necessary (for signing transactions)
 *
 * @param {number} walletId - Wallet ID
 * @returns {Promise<string>} Decrypted private key (base58)
 */
export async function getWalletPrivateKey(walletId) {
    const result = await db.select()
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

    if (result.length === 0) {
        throw new Error('Wallet not found');
    }

    const wallet = result[0];

    // Decrypt private key
    const privateKey = decryptPrivateKey(
        wallet.encrypted_private_key,
        wallet.nonce,
        wallet.salt,
        env.MASTER_PASSWORD
    );

    return privateKey;
}

/**
 * Update wallet label
 *
 * @param {number} walletId - Wallet ID
 * @param {string} newLabel - New wallet label
 * @returns {Promise<Object>} Updated wallet
 */
export async function updateWalletLabel(walletId, newLabel) {
    const result = await db.update(wallets)
        .set({
            label: newLabel,
            updated_at: new Date()
        })
        .where(eq(wallets.id, walletId))
        .returning();

    const { encrypted_private_key, nonce, salt, ...safeWallet } = result[0];
    return safeWallet;
}

/**
 * Delete wallet
 * WARNING: This will also delete all associated positions, alerts, and transactions
 *
 * @param {number} walletId - Wallet ID
 * @param {number} telegramId - Telegram user ID (for verification)
 * @returns {Promise<void>}
 */
export async function deleteWallet(walletId, telegramId) {
    // Verify ownership
    const wallet = await db.select()
        .from(wallets)
        .where(and(
            eq(wallets.id, walletId),
            eq(wallets.user_telegram_id, telegramId)
        ))
        .limit(1);

    if (wallet.length === 0) {
        throw new Error('Wallet not found or does not belong to user');
    }

    // Delete wallet (cascade will handle related data)
    await db.delete(wallets)
        .where(eq(wallets.id, walletId));

    // If this was the active wallet, set another as active
    const remainingWallets = await getUserWallets(telegramId);
    if (remainingWallets.length > 0) {
        await switchActiveWallet(telegramId, remainingWallets[0].id);
    } else {
        // No wallets left, clear active_wallet_id
        await db.update(users)
            .set({ active_wallet_id: null })
            .where(eq(users.telegram_id, telegramId));
    }
}

/**
 * Check if wallet address exists
 *
 * @param {string} walletAddress - Wallet address to check
 * @returns {Promise<boolean>} True if wallet exists
 */
export async function walletExists(walletAddress) {
    const result = await db.select()
        .from(wallets)
        .where(eq(wallets.wallet_address, walletAddress))
        .limit(1);

    return result.length > 0;
}

/**
 * Update wallet's claim address
 *
 * @param {number} walletId - Wallet ID
 * @param {string|null} claimAddress - Solana address for claiming rewards (or null to clear)
 * @returns {Promise<Object>} Updated wallet
 */
export async function updateWalletClaimAddress(walletId, claimAddress) {
    const result = await db.update(wallets)
        .set({
            claim_address: claimAddress,
            updated_at: new Date()
        })
        .where(eq(wallets.id, walletId))
        .returning();

    const { encrypted_private_key, nonce, salt, ...safeWallet } = result[0];
    return safeWallet;
}

/**
 * Get wallet's claim address
 *
 * @param {number} walletId - Wallet ID
 * @returns {Promise<string|null>} Claim address or null if not set
 */
export async function getWalletClaimAddress(walletId) {
    const result = await db.select()
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

    if (result.length === 0) return null;

    return result[0].claim_address || null;
}

/**
 * Toggle wallet's split strategy
 *
 * @param {number} walletId - Wallet ID
 * @returns {Promise<Object>} Updated wallet with new split_strategy value
 */
export async function toggleSplitStrategy(walletId) {
    // Get current value
    const result = await db.select()
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

    if (result.length === 0) {
        throw new Error('Wallet not found');
    }

    const currentValue = result[0].split_strategy;
    const newValue = !currentValue;

    // Update the value
    const updated = await db.update(wallets)
        .set({
            split_strategy: newValue,
            updated_at: new Date()
        })
        .where(eq(wallets.id, walletId))
        .returning();

    const { encrypted_private_key, nonce, salt, ...safeWallet } = updated[0];
    return safeWallet;
}

/**
 * Get total claimed rewards for all ACTIVE positions under a wallet
 * Only counts active positions to avoid double-counting after rebalances
 * (statistics are carried over to new positions, so closed ones would duplicate)
 * 
 * @param {number} walletId - Wallet ID
 * @returns {Promise<number>} Total claimed USD across active positions
 */
export async function getWalletTotalClaimedUsd(walletId) {
    const result = await db.select({
        total: sql`COALESCE(SUM(${position_statistics.total_claimed_usd}), 0)`
    })
    .from(positions)
    .innerJoin(position_statistics, eq(positions.id, position_statistics.position_id))
    .where(and(
        eq(positions.wallet_id, walletId),
        eq(positions.status, 'active')
    ));

    return Number(result[0]?.total) || 0;
}

/**
 * Reset wallet rewards counter
 * Stores current total as snapshot, future reads will show delta from this point
 * 
 * @param {number} walletId - Wallet ID
 * @returns {Promise<Object>} Updated wallet with reset timestamp
 */
export async function resetWalletRewardsCounter(walletId) {
    const currentTotal = await getWalletTotalClaimedUsd(walletId);

    const updated = await db.update(wallets)
        .set({
            rewards_at_last_reset_usd: currentTotal,
            rewards_reset_at: new Date(),
            updated_at: new Date()
        })
        .where(eq(wallets.id, walletId))
        .returning();

    if (updated.length === 0) {
        throw new Error('Wallet not found');
    }

    const { encrypted_private_key, nonce, salt, ...safeWallet } = updated[0];
    return safeWallet;
}

/**
 * Get rewards earned since last reset
 * 
 * @param {number} walletId - Wallet ID
 * @returns {Promise<{rewardsSinceReset: number, totalRewards: number, resetAt: Date|null}>}
 */
export async function getWalletRewardsSinceReset(walletId) {
    const wallet = await db.select()
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

    if (wallet.length === 0) {
        throw new Error('Wallet not found');
    }

    const totalRewards = await getWalletTotalClaimedUsd(walletId);
    const snapshotAtReset = wallet[0].rewards_at_last_reset_usd || 0;
    const rewardsSinceReset = totalRewards - snapshotAtReset;

    return {
        rewardsSinceReset,
        totalRewards,
        resetAt: wallet[0].rewards_reset_at || null
    };
}
