import { getUserWallets } from '../services/wallet.service.js';
import { formatShortAddress } from '../utils/format.util.js';
import { findPositions, getDistinctPoolsFromPositions } from '../utils/positions.util.js';
import { fetchPositionRangeData } from '../utils/range.util.js';
import { createSolanaConnection } from '../utils/rpc.util.js';

// Per-user mapping of button text -> walletId for reply keyboard taps
const userKeyboardMaps = new Map();

// Track keyboard message IDs per chat to enable updates
// Structure: Map<chatId, { messageId: number, walletAddress: string, timestamp: number }>
const keyboardMessageTracking = new Map();

function computeButtonTexts(wallets) {
    const baseTexts = wallets.map((w) => w.label && w.label.trim().length > 0
        ? w.label.trim()
        : formatShortAddress(w.wallet_address));

    // Count duplicates to disambiguate
    const counts = new Map();
    baseTexts.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));

    return wallets.map((w, idx) => {
        let text = baseTexts[idx];
        if ((counts.get(text) || 0) > 1) {
            const last6 = w.wallet_address.slice(-6);
            text = `${text} • ${last6}`;
        }
        // Mark active wallet with a check emoji
        if (w.is_active) {
            text = `✅ ${text}`;
        }
        return text;
    });
}

export async function buildWalletKeyboard(telegramId) {
    // return null;// Will get back to this in v2
    const wallets = await getUserWallets(telegramId);
    if (!wallets || wallets.length === 0) {
        // Clear mapping if no wallets
        userKeyboardMaps.delete(telegramId);
        return undefined;
    }

    const buttonTexts = computeButtonTexts(wallets);

    // Build mapping for this user
    const map = new Map();
    buttonTexts.forEach((text, i) => {
        map.set(text, wallets[i].id);
    });
    userKeyboardMaps.set(telegramId, map);

    return {
        keyboard: [buttonTexts],
        resize_keyboard: true,
        is_persistent: true,
        one_time_keyboard: false
    };
}

export function resolveWalletButton(telegramId, text) {
    const map = userKeyboardMaps.get(telegramId);
    if (!map) return null;
    return map.get(text) || null;
}

function normalizeButtonText(text) {
    if (!text) return '';
    let t = text.trim();
    // Remove active check prefix if present
    t = t.replace(/^✅\s*/, '');
    // Remove trailing disambiguation suffix " • abc123"
    t = t.replace(/\s•\s[0-9A-Za-z]{6}$/, '');
    return t.trim();
}

export async function resolveWalletButtonAsync(telegramId, text) {
    const direct = resolveWalletButton(telegramId, text);
    if (direct) return direct;

    // Try normalized text against current map
    const map = userKeyboardMaps.get(telegramId);
    const normalized = normalizeButtonText(text);
    if (map) {
        for (const [key, value] of map.entries()) {
            if (normalizeButtonText(key) === normalized) return value;
        }
    }

    // As a fallback, rebuild mapping from current wallets and try again
    const wallets = await getUserWallets(telegramId);
    if (!wallets || wallets.length === 0) return null;

    const buttonTexts = computeButtonTexts(wallets);
    const newMap = new Map();
    buttonTexts.forEach((t, i) => newMap.set(t, wallets[i].id));
    userKeyboardMaps.set(telegramId, newMap);

    // Try exact, then normalized match
    if (newMap.has(text)) return newMap.get(text);
    for (const [key, value] of newMap.entries()) {
        if (normalizeButtonText(key) === normalized) return value;
    }

    // Also try matching directly to label or short address without suffix
    for (const w of wallets) {
        const label = (w.label || '').trim();
        const short = formatShortAddress(w.wallet_address);
        if (label && label === normalized) return w.id;
        if (short === normalized) return w.id;
    }

    return null;
}

export function getCancelOnlyKeyboard() {
    return {
        keyboard: [['/cancel']],
        resize_keyboard: true,
        is_persistent: false,
        one_time_keyboard: true
    };
}

/**
 * Build persistent reply keyboard with pools list
 * Optionally accepts pre-fetched positionsData to avoid redundant RPC calls
 *
 * @param {string} walletAddress - Wallet address to fetch positions from
 * @param {Array<Object>} [positionsData] - Optional pre-fetched positions data with range info
 * @returns {Promise<Object|null>} Reply keyboard object or null if no positions
 */
export async function buildPoolsReplyKeyboard(walletAddress, positionsData = null) {
    return;// TO DO: Get back to this in v2

    try {
        let poolsData = positionsData;

        // If positionsData not provided, fetch fresh
        if (!poolsData) {
            console.log(`🔄 buildPoolsReplyKeyboard: Fetching positions fresh from RPC for ${walletAddress}`);
            const connection = createSolanaConnection();
            
            // Find all positions for the wallet
            const positions = await findPositions(connection, walletAddress);
            console.log(`🔄 buildPoolsReplyKeyboard: Found ${positions.length} positions on-chain`);
            
            if (positions.length === 0) {
                console.log(`🔄 buildPoolsReplyKeyboard: No positions found, returning minimal keyboard`);
                return {
                    keyboard: [['💧LPs']],
                    resize_keyboard: true,
                    is_persistent: true,
                    one_time_keyboard: false
                };
            }

            // Fetch range data for each position to get pool info
            poolsData = [];
            for (const position of positions) {
                try {
                    const rangeData = await fetchPositionRangeData(
                        connection,
                        position.positionPda
                    );
                    poolsData.push({
                        ...rangeData,
                        success: true
                    });
                } catch (error) {
                    // Skip positions that fail to fetch range data
                    console.warn(`Failed to fetch range data for position ${position.mintAddress}:`, error.message);
                }
            }
        }
        
        // Extract distinct pools from provided or fetched data
        const poolsForReplyKb = getDistinctPoolsFromPositions(poolsData);
        console.log(`🔄 buildPoolsReplyKeyboard: Extracted ${poolsForReplyKb.length} distinct pools`);
        
        const MAX_PER_ROW = 4;
        const labelsAll = Array.isArray(poolsForReplyKb) ? poolsForReplyKb.map(p => p.label) : [];
        const labels = labelsAll.slice(0, 32);
        const rows = [];
        
        // First row with 💧LPs button
        const firstRow = ['💧LPs'];
        while (firstRow.length < MAX_PER_ROW && labels.length > 0) {
            firstRow.push(labels.shift());
        }
        rows.push(firstRow);
        
        // Additional rows if needed
        while (labels.length > 0) {
            rows.push(labels.splice(0, MAX_PER_ROW));
        }

        return {
            keyboard: rows.length > 0 ? rows : [['💧LPs']],
            resize_keyboard: true,
            is_persistent: true,
            one_time_keyboard: false
        };
    } catch (error) {
        console.error('Failed to build pools reply keyboard:', error.message);
        // Return minimal fallback keyboard
        return {
            keyboard: [['💧LPs']],
            resize_keyboard: true,
            is_persistent: true,
            one_time_keyboard: false
        };
    }
}

/**
 * Update persistent reply keyboard with fresh pools list
 * 
 * Sends a single elegant message with the updated keyboard.
 * Telegram naturally replaces the old keyboard with the new one.
 * 
 * @param {TelegramBot} bot - Bot instance
 * @param {number} chatId - Chat ID to update keyboard for
 * @param {string} walletAddress - Wallet address to fetch positions from
 * @returns {Promise<void>}
 */
export async function updatePoolsReplyKeyboard(bot, chatId, walletAddress) {
    return;// TO DO: Get back to this in v2
    try {
        console.log(`🔄 updatePoolsReplyKeyboard: Starting for wallet ${walletAddress}`);
        
        // Build the fresh keyboard with current positions
        const poolsReplyKb = await buildPoolsReplyKeyboard(walletAddress);
        if (!poolsReplyKb) {
            console.warn(`updatePoolsReplyKeyboard: No keyboard built for wallet ${walletAddress}`);
            return;
        }

        console.log(`🔄 Sending fresh keyboard with updated pools`);
        
        // Send one elegant message with the updated keyboard
        // Telegram naturally replaces the old persistent keyboard
        const newMsg = await bot.sendMessage(chatId, '✅ Data up to date', {
            reply_markup: poolsReplyKb
        });
        
        // Track for cleanup/debugging
        storeKeyboardMessageId(chatId, newMsg.message_id, walletAddress);
        console.log(`✅ Fresh keyboard sent for chat ${chatId}, message ID: ${newMsg.message_id}`);
        
    } catch (error) {
        console.error(`Failed to update pools keyboard for chat ${chatId}:`, error.message);
        // Non-critical - don't throw, just log
    }
}

export function clearSelectedPoolFilter(chatId) {
    return;// TO DO: Get back to this in v2
    try {
        _selectedPoolLabelByChatId.delete(chatId);
    } catch (_) {}
}

/**
 * Store the keyboard message ID for a chat
 * This allows us to update the keyboard later using editMessageReplyMarkup
 * 
 * @param {number} chatId - Telegram chat ID
 * @param {number} messageId - Message ID of the keyboard message
 * @param {string} walletAddress - Wallet address associated with this keyboard
 */
export function storeKeyboardMessageId(chatId, messageId, walletAddress) {
    keyboardMessageTracking.set(chatId, {
        messageId,
        walletAddress,
        timestamp: Date.now()
    });
}

/**
 * Retrieve stored keyboard message ID for a chat
 * 
 * @param {number} chatId - Telegram chat ID
 * @returns {Object|null} Keyboard message tracking data or null
 */
export function getKeyboardMessageId(chatId) {
    return keyboardMessageTracking.get(chatId) || null;
}

/**
 * Clear stored keyboard message ID for a chat
 * 
 * @param {number} chatId - Telegram chat ID
 */
export function clearKeyboardMessageId(chatId) {
    keyboardMessageTracking.delete(chatId);
}


