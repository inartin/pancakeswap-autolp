/**
 * Transaction Service
 * 
 * Handles transaction history recording and retrieval for claims, compounds, and rebalances.
 * Each transaction is stored individually for audit trail and historical analysis.
 * 
 * @module transaction.service
 */

import { db } from '../db/index.js';
import { transactions, positions } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';

/**
 * Record a claim transaction
 * 
 * Stores individual claim transaction with full details including:
 * - Transaction signature
 * - Tokens claimed (symbol, amount, USD value)
 * - Gas fees
 * - Timestamp
 * - Links to wallet and position
 * 
 * @param {number} walletId - Wallet ID that performed the claim
 * @param {number} positionId - Position ID that was claimed from
 * @param {Object} claimResult - Result object from claimRewards()
 * @param {string} claimResult.signature - Transaction signature
 * @param {number} claimResult.totalUsd - Total USD value claimed
 * @param {Array<Object>} claimResult.claimed - Array of claimed tokens
 * @param {number} claimResult.transactionFee - Gas fee in SOL
 * @returns {Promise<Object>} Inserted transaction record
 */
export async function recordClaimTransaction(walletId, positionId, claimResult) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`💾 Recording claim transaction for wallet ${walletId}, position ${positionId}`);
    }
    
    // Format token data for JSON storage
    const tokenData = {
        total_usd: claimResult.totalUsd,
        tokens: claimResult.claimed.map(token => ({
            symbol: token.symbol,
            amount: token.uiAmount,
            usd_value: token.usdValue || 0,
            type: token.type // 'fee0', 'fee1', 'reward0', 'reward1', 'reward2'
        }))
    };

    const result = await db.insert(transactions).values({
        wallet_id: walletId,
        position_id: positionId,
        tx_signature: claimResult.signature,
        tx_type: 'claim',
        token_amounts: JSON.stringify(tokenData),
        fee_amount_sol: claimResult.transactionFee || 0,
        status: 'success',
        executed_at: new Date()
    }).returning();

    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`✅ Claim transaction recorded: ${claimResult.signature}`);
    }
    return result[0];
}

/**
 * Record a compound transaction
 * 
 * @param {number} walletId - Wallet ID
 * @param {number} positionId - Position ID
 * @param {Object} compoundResult - Result from compound operation
 * @returns {Promise<Object>} Inserted transaction record
 */
export async function recordCompoundTransaction(walletId, positionId, compoundResult) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`💾 Recording compound transaction for wallet ${walletId}, position ${positionId}`);
    }
    
    const tokenData = {
        total_usd: compoundResult.totalCompoundedUsd || 0,
        deposited: compoundResult.tokensDeposited || []
    };

    const result = await db.insert(transactions).values({
        wallet_id: walletId,
        position_id: positionId,
        tx_signature: compoundResult.finalSignature || compoundResult.signature,
        tx_type: 'compound',
        token_amounts: JSON.stringify(tokenData),
        fee_amount_sol: compoundResult.totalFee || 0,
        status: 'success',
        executed_at: new Date()
    }).returning();

    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`✅ Compound transaction recorded: ${compoundResult.finalSignature || compoundResult.signature}`);
    }
    return result[0];
}

/**
 * Record a rebalance transaction
 * 
 * Stores rebalance details including:
 * - New range percent (±%)
 * - Lower/upper prices
 * - Cost in USD
 * - Links to old and new positions
 * 
 * @param {number} walletId - Wallet ID
 * @param {number} oldPositionId - Old position ID (closed)
 * @param {number} newPositionId - New position ID (opened)
 * @param {Object} rebalanceData - Rebalance data
 * @param {number} rebalanceData.costUsd - Rebalance cost in USD
 * @param {number} rebalanceData.rangePercent - New range percent (e.g., 3.0 for ±3%)
 * @param {number} rebalanceData.lowerPrice - New lower price
 * @param {number} rebalanceData.upperPrice - New upper price
 * @param {number} rebalanceData.currentPrice - Current price at rebalance
 * @param {string} rebalanceData.signature - Transaction signature (optional)
 * @param {number} rebalanceData.feeSol - Gas fee in SOL (optional)
 * @returns {Promise<Object>} Inserted transaction record
 */
export async function recordRebalanceTransaction(walletId, oldPositionId, newPositionId, rebalanceData) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`💾 Recording rebalance transaction for wallet ${walletId}`);
        console.log(`   Range: ±${rebalanceData.rangePercent}% | Cost: $${rebalanceData.costUsd.toFixed(4)}`);
    }
    
    const tokenData = {
        cost_usd: rebalanceData.costUsd || 0,
        old_position_id: oldPositionId,
        new_position_id: newPositionId,
        range_percent: rebalanceData.rangePercent,
        price_range: {
            lower: rebalanceData.lowerPrice,
            upper: rebalanceData.upperPrice,
            current: rebalanceData.currentPrice
        }
    };

    const result = await db.insert(transactions).values({
        wallet_id: walletId,
        position_id: newPositionId, // Link to new position
        tx_signature: rebalanceData.signature || `rebalance_${Date.now()}`,
        tx_type: 'rebalance',
        token_amounts: JSON.stringify(tokenData),
        fee_amount_sol: rebalanceData.feeSol || 0,
        status: 'success',
        executed_at: new Date()
    }).returning();

    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`✅ Rebalance transaction recorded with range ±${rebalanceData.rangePercent}%`);
    }
    return result[0];
}

/**
 * Get claim history for a wallet (all positions)
 * 
 * Returns all claim transactions for a wallet across all positions,
 * with position details included.
 * 
 * @param {number} walletId - Wallet ID
 * @param {number} limit - Maximum number of records (default: 100)
 * @returns {Promise<Array<Object>>} Array of claim transactions with position data
 */
export async function getWalletClaimHistory(walletId, limit = 100) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`📊 Fetching claim history for wallet ${walletId}`);
    }
    
    const result = await db.select({
        id: transactions.id,
        tx_signature: transactions.tx_signature,
        token_amounts: transactions.token_amounts,
        fee_amount_sol: transactions.fee_amount_sol,
        executed_at: transactions.executed_at,
        position_id: transactions.position_id,
        position_token0: positions.token0_symbol,
        position_token1: positions.token1_symbol,
        position_nft: positions.nft_mint
    })
    .from(transactions)
    .leftJoin(positions, eq(transactions.position_id, positions.id))
    .where(and(
        eq(transactions.wallet_id, walletId),
        eq(transactions.tx_type, 'claim'),
        eq(transactions.status, 'success')
    ))
    .orderBy(desc(transactions.executed_at))
    .limit(limit);
    
    // Parse JSON token_amounts and ensure executed_at is Unix timestamp
    return result.map(row => ({
        ...row,
        token_amounts: row.token_amounts ? JSON.parse(row.token_amounts) : null,
        executed_at: row.executed_at instanceof Date 
            ? Math.floor(row.executed_at.getTime() / 1000) 
            : row.executed_at
    }));
}

/**
 * Get claim history for a specific position
 * 
 * @param {number} positionId - Position ID
 * @param {number} limit - Maximum number of records (default: 50)
 * @returns {Promise<Array<Object>>} Array of claim transactions
 */
export async function getPositionClaimHistory(positionId, limit = 50) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`📊 Fetching claim history for position ${positionId}`);
    }
    
    const result = await db.select()
        .from(transactions)
        .where(and(
            eq(transactions.position_id, positionId),
            eq(transactions.tx_type, 'claim'),
            eq(transactions.status, 'success')
        ))
        .orderBy(desc(transactions.executed_at))
        .limit(limit);
    
    // Parse JSON token_amounts
    return result.map(row => ({
        ...row,
        token_amounts: row.token_amounts ? JSON.parse(row.token_amounts) : null
    }));
}

/**
 * Get total USD claimed by wallet (all positions, all time)
 * 
 * @param {number} walletId - Wallet ID
 * @returns {Promise<number>} Total USD claimed
 */
export async function getWalletTotalClaimed(walletId) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`📊 Calculating total claimed for wallet ${walletId}`);
    }
    
    const claims = await db.select()
        .from(transactions)
        .where(and(
            eq(transactions.wallet_id, walletId),
            eq(transactions.tx_type, 'claim'),
            eq(transactions.status, 'success')
        ));
    
    return claims.reduce((total, claim) => {
        try {
            const data = JSON.parse(claim.token_amounts);
            return total + (data.total_usd || 0);
        } catch (error) {
            console.warn(`Failed to parse token_amounts for transaction ${claim.id}`);
            return total;
        }
    }, 0);
}

/**
 * Get transaction statistics for a wallet
 * 
 * Returns counts and totals for all transaction types.
 * 
 * @param {number} walletId - Wallet ID
 * @returns {Promise<Object>} Transaction statistics
 */
export async function getWalletTransactionStats(walletId) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`📊 Fetching transaction stats for wallet ${walletId}`);
    }
    
    const allTransactions = await db.select()
        .from(transactions)
        .where(and(
            eq(transactions.wallet_id, walletId),
            eq(transactions.status, 'success')
        ));
    
    const stats = {
        total_transactions: allTransactions.length,
        claims: { count: 0, total_usd: 0, total_fees_sol: 0 },
        compounds: { count: 0, total_usd: 0, total_fees_sol: 0 },
        rebalances: { count: 0, total_cost_usd: 0, total_fees_sol: 0 }
    };
    
    allTransactions.forEach(tx => {
        const data = tx.token_amounts ? JSON.parse(tx.token_amounts) : {};
        
        switch (tx.tx_type) {
            case 'claim':
                stats.claims.count++;
                stats.claims.total_usd += data.total_usd || 0;
                stats.claims.total_fees_sol += tx.fee_amount_sol || 0;
                break;
            case 'compound':
                stats.compounds.count++;
                stats.compounds.total_usd += data.total_usd || 0;
                stats.compounds.total_fees_sol += tx.fee_amount_sol || 0;
                break;
            case 'rebalance':
                stats.rebalances.count++;
                stats.rebalances.total_cost_usd += data.cost_usd || 0;
                stats.rebalances.total_fees_sol += tx.fee_amount_sol || 0;
                break;
        }
    });
    
    return stats;
}

/**
 * Get recent transactions for a wallet
 * 
 * @param {number} walletId - Wallet ID
 * @param {number} limit - Maximum number of records (default: 20)
 * @returns {Promise<Array<Object>>} Recent transactions
 */
export async function getRecentTransactions(walletId, limit = 20) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`📊 Fetching recent transactions for wallet ${walletId}`);
    }
    
    const result = await db.select({
        id: transactions.id,
        tx_type: transactions.tx_type,
        tx_signature: transactions.tx_signature,
        token_amounts: transactions.token_amounts,
        fee_amount_sol: transactions.fee_amount_sol,
        executed_at: transactions.executed_at,
        position_id: transactions.position_id,
        position_token0: positions.token0_symbol,
        position_token1: positions.token1_symbol
    })
    .from(transactions)
    .leftJoin(positions, eq(transactions.position_id, positions.id))
    .where(and(
        eq(transactions.wallet_id, walletId),
        eq(transactions.status, 'success')
    ))
    .orderBy(desc(transactions.executed_at))
    .limit(limit);
    
    // Parse JSON token_amounts
    return result.map(row => ({
        ...row,
        token_amounts: row.token_amounts ? JSON.parse(row.token_amounts) : null
    }));
}

/**
 * Get rebalance history for a wallet
 * 
 * Returns all rebalances with range percent and costs
 * 
 * @param {number} walletId - Wallet ID
 * @param {number} limit - Maximum number of records (default: 50)
 * @returns {Promise<Array<Object>>} Rebalance transactions
 */
export async function getWalletRebalanceHistory(walletId, limit = 50) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`📊 Fetching rebalance history for wallet ${walletId}`);
    }
    
    const result = await db.select({
        id: transactions.id,
        tx_signature: transactions.tx_signature,
        token_amounts: transactions.token_amounts,
        fee_amount_sol: transactions.fee_amount_sol,
        executed_at: transactions.executed_at,
        position_id: transactions.position_id,
        position_token0: positions.token0_symbol,
        position_token1: positions.token1_symbol,
        position_nft: positions.nft_mint
    })
    .from(transactions)
    .leftJoin(positions, eq(transactions.position_id, positions.id))
    .where(and(
        eq(transactions.wallet_id, walletId),
        eq(transactions.tx_type, 'rebalance'),
        eq(transactions.status, 'success')
    ))
    .orderBy(desc(transactions.executed_at))
    .limit(limit);
    
    // Parse JSON token_amounts
    return result.map(row => ({
        ...row,
        token_amounts: row.token_amounts ? JSON.parse(row.token_amounts) : null
    }));
}

/**
 * Get rebalance history for a specific position
 * 
 * Shows the evolution of range changes over time by tracing back through
 * the rebalance lineage (current position ← old position ← older position...)
 * 
 * @param {number} positionId - Current position ID
 * @param {number} limit - Maximum number of records (default: 20)
 * @returns {Promise<Array<Object>>} Rebalance transactions in chronological order
 */
export async function getPositionRebalanceHistory(positionId, limit = 20) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`📊 Fetching rebalance history lineage for position ${positionId}`);
    }
    
    // Get all rebalances from transactions table
    const allRebalances = await db.select()
        .from(transactions)
        .where(and(
            eq(transactions.tx_type, 'rebalance'),
            eq(transactions.status, 'success')
        ))
        .orderBy(transactions.executed_at);
    
    // Parse JSON and build lineage, ensure executed_at is Unix timestamp
    const parsedRebalances = allRebalances.map(row => ({
        ...row,
        token_amounts: row.token_amounts ? JSON.parse(row.token_amounts) : null,
        executed_at: row.executed_at instanceof Date 
            ? Math.floor(row.executed_at.getTime() / 1000) 
            : row.executed_at
    }));
    
    // Trace back from current position through old_position_id chain
    const lineage = [];
    let currentPosId = positionId;
    
    // Find all rebalances that led to the current position
    for (let i = 0; i < limit; i++) {
        // Find rebalance that created currentPosId
        const rebalance = parsedRebalances.find(r => 
            r.token_amounts?.new_position_id === currentPosId
        );
        
        if (!rebalance) {
            break; // No more rebalances in the chain
        }
        
        lineage.unshift(rebalance); // Add to beginning (chronological order)
        currentPosId = rebalance.token_amounts?.old_position_id;
        
        if (!currentPosId) {
            break; // Reached the original position
        }
    }
    
    if (process.env.LOG_LEVEL === 'debug') {
        console.log(`✅ Found ${lineage.length} rebalances in lineage for position ${positionId}`);
    }
    
    return lineage;
}
