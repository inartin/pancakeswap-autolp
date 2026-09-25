import { db } from '../db/index.js';
import { positions, position_statistics } from '../db/schema.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import { initializePositionStatistics, getPositionStatistics, getPositionStatisticsWithMetrics } from './position-statistics.service.js';

/**
 * Position Service
 * Handles position tracking and management
 *
 * STATUS: ⏳ READY FOR PHASE 3 - Database schema created, service functions ready
 *
 * PHASE: Phase 3 - Automation (Planned)
 *
 * CURRENT USE:
 * - NOT YET INTEGRATED
 * - Positions are currently discovered on-the-fly via /rewards command
 * - No persistent position tracking in database
 * - Database table exists but remains empty
 *
 * HANDLERS USING THIS:
 * - None
 *
 * TODO (Phase 3):
 * - Create /positions command to list all tracked positions
 * - Integrate with rewards.handler.js to save discovered positions
 * - Add background job to refresh position data periodically
 * - Implement position monitoring system
 * - Track position status changes (active → closed)
 * - Store position metadata (liquidity value, price ranges, etc.)
 *
 * INTEGRATION POINTS:
 * - rewards.handler.js - After findPositions(), call upsertPosition() to save
 * - Create positions.handler.js - List wallet's tracked positions
 * - Add background job in src/jobs/position-monitor.js
 */

/**
 * Create or update position
 *
 * @param {Object} positionData - Position data
 * @param {Object} options - Additional options
 * @param {number|null} options.sol_price_at_open - SOL/USD price when position was opened (for P/L tracking)
 * @returns {Promise<Object>} Created/updated position
 */
export async function upsertPosition(positionData, options = {}) {
    const { sol_price_at_open = null } = options;
    
    // Check if position already exists
    const existing = await db.select()
        .from(positions)
        .where(eq(positions.nft_mint, positionData.nft_mint))
        .limit(1);

    let position;
    
    if (existing.length > 0) {
        // Update existing - preserve non-null values
        // Only update fields that have non-null values in positionData
        const existingPosition = existing[0];
        const updateData = { ...positionData };
        
        // Preserve existing non-null values when new data has null or undefined
        const fieldsToPreserve = [
            'token0_symbol', 
            'token1_symbol', 
            'fee_tier', 
            'range_percent',
            'is_hidden'
        ];
        
        for (const field of fieldsToPreserve) {
            if ((updateData[field] === null || updateData[field] === undefined) && existingPosition[field] !== null && existingPosition[field] !== undefined) {
                updateData[field] = existingPosition[field];
            }
        }
        
        const result = await db.update(positions)
            .set({
                ...updateData,
                updated_at: new Date()
            })
            .where(eq(positions.nft_mint, positionData.nft_mint))
            .returning();
        position = result[0];
    } else {
        // Create new
        const result = await db.insert(positions)
            .values(positionData)
            .returning();
        position = result[0];
    }
    
    // Auto-create statistics row if it doesn't exist
    try {
        const stats = await getPositionStatistics(position.id);
        
        if (!stats) {
            // Initialize statistics with USD value and SOL price from position data
            const initialUsdValue = positionData.liquidity_value_usd || 0;
            await initializePositionStatistics(position.id, initialUsdValue, sol_price_at_open);
            console.log(`✅ Auto-created statistics for position ${position.id} (${position.nft_mint})${sol_price_at_open ? ` [SOL: $${sol_price_at_open.toFixed(2)}]` : ''}`);
        }
    } catch (error) {
        // Don't fail position creation if stats creation fails
        console.error(`⚠️ Failed to auto-create statistics for position ${position.id}:`, error.message);
    }
    
    return position;
}

/**
 * Get all positions for a wallet
 *
 * @param {number} walletId - Wallet ID
 * @param {string} status - Filter by status (optional)
 * @returns {Promise<Array>} Array of positions
 */
export async function getWalletPositions(walletId, status = null) {
    if (status) {
        return await db.select()
            .from(positions)
            .where(and(
                eq(positions.wallet_id, walletId),
                eq(positions.status, status)
            ));
    }

    return await db.select()
        .from(positions)
        .where(eq(positions.wallet_id, walletId));
}

/**
 * Get position by NFT mint
 *
 * @param {string} nftMint - Position NFT mint address
 * @returns {Promise<Object|null>} Position or null
 */
export async function getPositionByNft(nftMint) {
    const result = await db.select()
        .from(positions)
        .where(eq(positions.nft_mint, nftMint))
        .limit(1);

    return result[0] || null;
}

/**
 * Update position status
 *
 * @param {string} nftMint - Position NFT mint
 * @param {string} status - New status
 * @returns {Promise<Object>} Updated position
 */
export async function updatePositionStatus(nftMint, status) {
    const result = await db.update(positions)
        .set({
            status,
            updated_at: new Date()
        })
        .where(eq(positions.nft_mint, nftMint))
        .returning();

    return result[0];
}

/**
 * Get most-used pools for a wallet (all-time, regardless of status)
 * Ranked by total count of records per pool_address
 *
 * @param {number} walletId - Wallet ID
 * @param {number} limit - Max number of pools to return (default 3)
 * @returns {Promise<Array<{ poolAddress:string, token0Symbol:string|null, token1Symbol:string|null, count:number }>>}
 */
export async function getMostUsedPoolsByWallet(walletId, limit = 3) {
    const rows = await db
        .select({
            poolAddress: positions.pool_address,
            token0Mint: sql`MAX(${positions.token0_mint})`,
            token1Mint: sql`MAX(${positions.token1_mint})`,
            token0: sql`MAX(${positions.token0_symbol})`,
            token1: sql`MAX(${positions.token1_symbol})`,
            cnt: sql`COUNT(*)`
        })
        .from(positions)
        .where(eq(positions.wallet_id, walletId))
        .groupBy(positions.pool_address)
        .orderBy(desc(sql`COUNT(*)`))
        .limit(limit);

    return rows.map((r) => ({
        poolAddress: r.poolAddress,
        token0Mint: r.token0Mint ?? null,
        token1Mint: r.token1Mint ?? null,
        token0Symbol: r.token0 ?? null,
        token1Symbol: r.token1 ?? null,
        count: Number(r.cnt)
    }));
}

/**
 * Get position with its statistics in one call (including calculated metrics)
 * Useful for monitoring and automation systems
 *
 * @param {string} nftMint - Position NFT mint address
 * @param {boolean} includeCalculatedMetrics - Whether to include derived metrics (time_in_range_percent, net_pnl_usd, roi_percent)
 * @returns {Promise<{position: Object, statistics: Object}|null>} Position and statistics or null
 */
export async function getPositionWithStatistics(nftMint, includeCalculatedMetrics = true) {
    const position = await getPositionByNft(nftMint);
    
    if (!position) {
        return null;
    }
    
    const statistics = includeCalculatedMetrics
        ? await getPositionStatisticsWithMetrics(position.id)
        : await getPositionStatistics(position.id);
    
    return {
        position,
        statistics
    };
}

/**
 * Get all active positions with their statistics (including calculated metrics)
 * Useful for automated monitoring loops
 *
 * @param {number} walletId - Wallet ID (optional, if null returns all active positions)
 * @param {boolean} includeCalculatedMetrics - Whether to include derived metrics (time_in_range_percent, net_pnl_usd, roi_percent)
 * @returns {Promise<Array<{position: Object, statistics: Object}>>}
 */
export async function getActivePositionsWithStatistics(walletId = null, includeCalculatedMetrics = true) {
    // Get all active positions
    const activePositions = walletId 
        ? await getWalletPositions(walletId, 'active')
        : await db.select().from(positions).where(eq(positions.status, 'active'));
    
    // Fetch statistics for each position
    const positionsWithStats = await Promise.all(
        activePositions.map(async (position) => {
            const statistics = includeCalculatedMetrics
                ? await getPositionStatisticsWithMetrics(position.id)
                : await getPositionStatistics(position.id);
            return {
                position,
                statistics
            };
        })
    );
    
    return positionsWithStats;
}

/**
 * Toggle auto-rebalance for a position
 * 
 * @param {number} positionId - Position database ID
 * @returns {Promise<boolean>} New enabled state (true = enabled, false = disabled)
 */
export async function togglePositionAutoRebalance(positionId) {
    // Get current state
    const result = await db.select()
        .from(positions)
        .where(eq(positions.id, positionId))
        .limit(1);
    
    if (!result || result.length === 0) {
        throw new Error('Position not found');
    }
    
    const currentEnabled = result[0].auto_rebalance_enabled;
    const newEnabled = !currentEnabled;
    
    // Update the flag
    await db.update(positions)
        .set({
            auto_rebalance_enabled: newEnabled,
            updated_at: new Date()
        })
        .where(eq(positions.id, positionId));
    
    return newEnabled;
}

/**
 * Get auto-rebalance status for a position
 * 
 * @param {number} positionId - Position database ID
 * @returns {Promise<boolean>} Whether auto-rebalance is enabled
 */
export async function getPositionAutoRebalanceStatus(positionId) {
    const result = await db.select({ auto_rebalance_enabled: positions.auto_rebalance_enabled })
        .from(positions)
        .where(eq(positions.id, positionId))
        .limit(1);
    
    if (!result || result.length === 0) {
        throw new Error('Position not found');
    }
    
    return !!result[0].auto_rebalance_enabled;
}

/**
 * Toggle claim-before-rebalance for a position
 * 
 * @param {number} positionId - Position database ID
 * @returns {Promise<boolean>} New enabled state (true = enabled, false = disabled)
 */
export async function togglePositionClaimBeforeRebalance(positionId) {
    // Get current state
    const result = await db.select()
        .from(positions)
        .where(eq(positions.id, positionId))
        .limit(1);
    
    if (!result || result.length === 0) {
        throw new Error('Position not found');
    }
    
    const currentEnabled = result[0].claim_before_rebalance;
    const newEnabled = !currentEnabled;
    
    // Update the flag
    await db.update(positions)
        .set({
            claim_before_rebalance: newEnabled,
            updated_at: new Date()
        })
        .where(eq(positions.id, positionId));
    
    return newEnabled;
}

/**
 * Get claim-before-rebalance status for a position
 * 
 * @param {number} positionId - Position database ID
 * @returns {Promise<boolean>} Whether claim-before-rebalance is enabled
 */
export async function getPositionClaimBeforeRebalanceStatus(positionId) {
    const result = await db.select({ claim_before_rebalance: positions.claim_before_rebalance })
        .from(positions)
        .where(eq(positions.id, positionId))
        .limit(1);
    
    if (!result || result.length === 0) {
        throw new Error('Position not found');
    }
    
    return !!result[0].claim_before_rebalance;
}

/**
 * Toggle hidden status for a position
 * 
 * @param {string|number} identifier - Position NFT mint address or database ID
 * @returns {Promise<boolean>} New hidden state (true = hidden, false = shown)
 */
export async function togglePositionHidden(identifier) {
    const isId = typeof identifier === 'number';
    const condition = isId 
        ? eq(positions.id, identifier)
        : eq(positions.nft_mint, identifier);
        
    const result = await db.select()
        .from(positions)
        .where(condition)
        .limit(1);

    if (!result || result.length === 0) {
        throw new Error('Position not found');
    }

    const currentHidden = !!result[0].is_hidden;
    const newHidden = !currentHidden;

    await db.update(positions)
        .set({
            is_hidden: newHidden,
            updated_at: new Date()
        })
        .where(condition);

    return newHidden;
}

/**
 * Get hidden status for a position
 * 
 * @param {string|number} identifier - Position NFT mint address or database ID
 * @returns {Promise<boolean>} Whether position is hidden
 */
export async function getPositionHiddenStatus(identifier) {
    const isId = typeof identifier === 'number';
    const condition = isId 
        ? eq(positions.id, identifier)
        : eq(positions.nft_mint, identifier);

    const result = await db.select({ is_hidden: positions.is_hidden })
        .from(positions)
        .where(condition)
        .limit(1);

    if (!result || result.length === 0) {
        return false;
    }

    return !!result[0].is_hidden;
}

