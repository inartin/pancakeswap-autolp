/**
 * Rebalance Lock Service
 * 
 * Tracks in-progress rebalances to prevent race conditions between:
 * - Auto-rebalance operations
 * - Recovery job for idle funds
 * - Manual rebalance commands
 * 
 * Uses in-memory Set for simplicity (no database overhead).
 * Combined with time-based safety window for robustness.
 * 
 * @module rebalance-lock.service
 */

// In-memory set of wallet addresses currently being rebalanced
const activeRebalances = new Set();

// Safety window: Don't recover funds updated less than this many minutes ago
export const RECOVERY_SAFETY_WINDOW_MINUTES = 15;

// Debug logging flag
const isDebug = process.env.LOG_LEVEL === 'debug';

/**
 * Mark a wallet as having an active rebalance in progress
 * @param {string} walletAddress - Wallet public key
 */
export function lockRebalance(walletAddress) {
    if (!walletAddress) return;
    activeRebalances.add(walletAddress);
    if (isDebug) console.log(`🔒 Rebalance lock acquired: ${walletAddress.slice(0, 8)}...`);
}

/**
 * Release the rebalance lock for a wallet
 * @param {string} walletAddress - Wallet public key
 */
export function unlockRebalance(walletAddress) {
    if (!walletAddress) return;
    activeRebalances.delete(walletAddress);
    if (isDebug) console.log(`🔓 Rebalance lock released: ${walletAddress.slice(0, 8)}...`);
}

/**
 * Check if a wallet has an active rebalance in progress
 * @param {string} walletAddress - Wallet public key
 * @returns {boolean} True if rebalance is in progress
 */
export function isRebalanceActive(walletAddress) {
    if (!walletAddress) return false;
    return activeRebalances.has(walletAddress);
}

/**
 * Get all wallets with active rebalances
 * @returns {string[]} Array of wallet addresses
 */
export function getActiveRebalances() {
    return Array.from(activeRebalances);
}

/**
 * Clear all rebalance locks (use with caution, e.g., on bot restart)
 */
export function clearAllLocks() {
    const count = activeRebalances.size;
    activeRebalances.clear();
    if (count > 0 && isDebug) {
        console.log(`🔓 Cleared ${count} stale rebalance lock(s)`);
    }
}

/**
 * Check if a position was updated recently (within safety window)
 * @param {Date|number} updatedAt - Position's updated_at timestamp
 * @returns {boolean} True if updated within safety window
 */
export function isWithinSafetyWindow(updatedAt) {
    if (!updatedAt) return false;
    const updatedTime = updatedAt instanceof Date ? updatedAt.getTime() : updatedAt * 1000;
    const now = Date.now();
    const minutesAgo = (now - updatedTime) / (1000 * 60);
    return minutesAgo < RECOVERY_SAFETY_WINDOW_MINUTES;
}

export default {
    lockRebalance,
    unlockRebalance,
    isRebalanceActive,
    getActiveRebalances,
    clearAllLocks,
    isWithinSafetyWindow,
    RECOVERY_SAFETY_WINDOW_MINUTES
};

