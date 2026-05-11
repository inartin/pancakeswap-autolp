/**
 * Rebalance Worth Loss Tracking Utility
 * 
 * Tracks wallet balances and LP position value before/after rebalancing
 * to calculate the percentage difference (slippage, fees, IL impact).
 * 
 * @module rebalance-tracking.util
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { LAMPORTS_PER_SOL, KNOWN_TOKENS } from '../config/constants.js';
import { getTokenInfo } from './token.util.js';
import { fetchPositionRangeData } from './range.util.js';

/**
 * Get mint's token program (tries Token-2022 first, then legacy Token Program)
 */
async function getMintTokenProgram(connection, mintPk) {
    try {
        const ata2022 = await getAssociatedTokenAddress(mintPk, PublicKey.default, false, TOKEN_2022_PROGRAM_ID);
        const info2022 = await connection.getAccountInfo(ata2022);
        if (info2022) return TOKEN_2022_PROGRAM_ID;
    } catch (e) {
        // Token-2022 not found, try legacy
    }
    return TOKEN_PROGRAM_ID;
}

/**
 * Get token balance for a specific mint
 * Handles both native SOL and SPL tokens
 * NOTE: For tracking purposes, we report FULL balances (no reserve subtraction)
 */
async function getTokenBalance(connection, walletPk, mintAddress) {
    const mintPk = new PublicKey(mintAddress);
    const wsolMint = new PublicKey(KNOWN_TOKENS.SOL.mint);
    
    // Check if this is WSOL - if so, also check native SOL balance
    const isWsol = mintPk.equals(wsolMint);
    
    if (isWsol) {
        // Get native SOL balance (full balance for tracking, no reserve subtraction)
        const solBalance = await connection.getBalance(walletPk);
        const solUi = solBalance / LAMPORTS_PER_SOL;
        
        // Also check WSOL token account
        try {
            const tokenProgram = await getMintTokenProgram(connection, mintPk);
            const ata = await getAssociatedTokenAddress(mintPk, walletPk, false, tokenProgram);
            const tokenAccountInfo = await connection.getAccountInfo(ata);
            
            if (tokenAccountInfo) {
                const tokenBalance = await connection.getTokenAccountBalance(ata);
                const wsolUi = parseFloat(tokenBalance?.value?.uiAmount || '0');
                // Return native SOL + WSOL (for tracking, full balance)
                return solUi + wsolUi;
            }
        } catch (e) {
            // No WSOL account, just return native SOL
        }
        
        return solUi; // Full SOL balance for tracking
    }
    
    // Regular SPL token
    try {
        const tokenProgram = await getMintTokenProgram(connection, mintPk);
        const ata = await getAssociatedTokenAddress(mintPk, walletPk, false, tokenProgram);
        const tokenAccountInfo = await connection.getAccountInfo(ata);
        
        if (!tokenAccountInfo) {
            return 0;
        }
        
        const balance = await connection.getTokenAccountBalance(ata);
        return parseFloat(balance?.value?.uiAmount || '0');
    } catch (error) {
        console.warn(`Failed to get balance for ${mintAddress}: ${error.message}`);
        return 0;
    }
}

/**
 * Get LP position USD value from on-chain data
 * Retries up to 3 times with 1 second delay (for newly created positions)
 */
async function getLpPositionValue(connection, personalPositionPda, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const rangeData = await fetchPositionRangeData(connection, personalPositionPda);
            if (rangeData?.liquidityValueUsd) {
                return rangeData.liquidityValueUsd;
            }
        } catch (error) {
            if (attempt === retries - 1) {
                console.warn(`Failed to get LP position value after ${retries} attempts: ${error.message}`);
                return 0;
            }
            // Wait 1 second before retrying (allows new position to commit)
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return 0;
}

/**
 * Capture snapshot of wallet balances and LP position value
 * 
 * @param {Connection} connection - Solana connection
 * @param {PublicKey} walletPk - Wallet public key
 * @param {Object} position - Position data from database
 * @param {string|null} personalPositionPda - Personal position PDA (null if position is closed)
 * @returns {Promise<Object>} Snapshot with balances and USD values
 */
export async function captureRebalanceSnapshot(connection, walletPk, position, personalPositionPda = null) {
    const timestamp = Date.now();
    
    console.log(`📸 Capturing rebalance snapshot...`);
    
    // Get balances for position tokens
    const token0Balance = await getTokenBalance(connection, walletPk, position.token0_mint);
    const token1Balance = await getTokenBalance(connection, walletPk, position.token1_mint);
    
    console.log(`   ${position.token0_symbol}: ${token0Balance.toFixed(6)}`);
    console.log(`   ${position.token1_symbol}: ${token1Balance.toFixed(6)}`);
    
    // Get reward token balances (if position has reward mints)
    const rewardBalances = [];
    const rewardMints = [
        position.reward0_mint,
        position.reward1_mint,
        position.reward2_mint
    ].filter(mint => mint && mint !== 'None' && mint !== '11111111111111111111111111111111');
    
    for (const rewardMint of rewardMints) {
        const balance = await getTokenBalance(connection, walletPk, rewardMint);
        const tokenInfo = await getTokenInfo(rewardMint);
        rewardBalances.push({
            mint: rewardMint,
            symbol: tokenInfo.ticker,
            balance: balance,
            price: tokenInfo.price
        });
        console.log(`   ${tokenInfo.ticker}: ${balance.toFixed(6)}`);
    }
    
    // Get LP position value (only if position is still open)
    let lpValueUsd = 0;
    if (personalPositionPda) {
        lpValueUsd = await getLpPositionValue(connection, personalPositionPda);
        console.log(`   LP Value: $${lpValueUsd.toFixed(2)}`);
    }
    
    // Get token prices for USD calculation
    const token0Info = await getTokenInfo(position.token0_mint);
    const token1Info = await getTokenInfo(position.token1_mint);
    
    // Calculate USD values
    const token0Usd = token0Balance * (token0Info.price || 0);
    const token1Usd = token1Balance * (token1Info.price || 0);
    const rewardsUsd = rewardBalances.reduce((sum, r) => sum + (r.balance * (r.price || 0)), 0);
    
    const totalWalletUsd = token0Usd + token1Usd + rewardsUsd;
    const totalWorthUsd = totalWalletUsd + lpValueUsd;
    
    console.log(`   💰 Wallet USD: $${totalWalletUsd.toFixed(2)} | LP USD: $${lpValueUsd.toFixed(2)} | Total: $${totalWorthUsd.toFixed(2)}`);
    
    return {
        timestamp,
        token0: {
            mint: position.token0_mint,
            symbol: position.token0_symbol,
            balance: token0Balance,
            price: token0Info.price,
            usd: token0Usd
        },
        token1: {
            mint: position.token1_mint,
            symbol: position.token1_symbol,
            balance: token1Balance,
            price: token1Info.price,
            usd: token1Usd
        },
        rewards: rewardBalances,
        rewardsUsd,
        lpValueUsd,
        totalWalletUsd,
        totalWorthUsd
    };
}

/**
 * Calculate worth loss between before/after snapshots
 * 
 * @param {Object} before - Before snapshot
 * @param {Object} after - After snapshot
 * @returns {Object} Worth loss analysis
 */
export function calculateWorthLoss(before, after) {
    const worthBefore = before.totalWorthUsd;
    const worthAfter = after.totalWorthUsd;
    const worthDifference = worthAfter - worthBefore;
    const worthLossPercent = worthBefore > 0 
        ? ((worthDifference / worthBefore) * 100)
        : 0;
    
    const walletDifference = after.totalWalletUsd - before.totalWalletUsd;
    const lpDifference = after.lpValueUsd - before.lpValueUsd;
    
    return {
        before: {
            wallet: before.totalWalletUsd,
            lp: before.lpValueUsd,
            total: worthBefore
        },
        after: {
            wallet: after.totalWalletUsd,
            lp: after.lpValueUsd,
            total: worthAfter
        },
        difference: {
            wallet: walletDifference,
            lp: lpDifference,
            total: worthDifference
        },
        worthLossPercent,
        worthLossUsd: Math.abs(worthDifference),
        isProfit: worthDifference > 0
    };
}

/**
 * Log worth loss analysis to console
 * 
 * @param {Object} analysis - Worth loss analysis from calculateWorthLoss
 * @param {Object} position - Position data for context
 */
export function logWorthLossAnalysis(analysis, position) {
    return analysis;

    console.log(`\n${'='.repeat(70)}`);
    console.log(`📊 REBALANCE WORTH LOSS ANALYSIS`);
    console.log(`${'='.repeat(70)}`);
    console.log(`Position: ${position.nft_mint?.slice(0, 8)}...${position.nft_mint?.slice(-8)}`);
    console.log(`Pool: ${position.token0_symbol}/${position.token1_symbol}`);
    console.log(`Range: ±${position.range_percent}%`);
    console.log(`${'-'.repeat(70)}`);
    
    console.log(`\n📸 BEFORE REBALANCE:`);
    console.log(`   Wallet: $${analysis.before.wallet.toFixed(2)}`);
    console.log(`   LP:     $${analysis.before.lp.toFixed(2)}`);
    console.log(`   Total:  $${analysis.before.total.toFixed(2)}`);
    
    console.log(`\n📸 AFTER REBALANCE:`);
    console.log(`   Wallet: $${analysis.after.wallet.toFixed(2)}`);
    console.log(`   LP:     $${analysis.after.lp.toFixed(2)}`);
    console.log(`   Total:  $${analysis.after.total.toFixed(2)}`);
    
    console.log(`\n📈 DIFFERENCE:`);
    console.log(`   Wallet: ${analysis.difference.wallet >= 0 ? '+' : ''}$${analysis.difference.wallet.toFixed(2)}`);
    console.log(`   LP:     ${analysis.difference.lp >= 0 ? '+' : ''}$${analysis.difference.lp.toFixed(2)}`);
    console.log(`   Total:  ${analysis.difference.total >= 0 ? '+' : ''}$${analysis.difference.total.toFixed(2)}`);
    
    const lossIcon = analysis.isProfit ? '💰' : '📉';
    const lossText = analysis.isProfit ? 'PROFIT' : 'LOSS';
    console.log(`\n${lossIcon} ${lossText}: ${analysis.worthLossPercent >= 0 ? '+' : ''}${analysis.worthLossPercent.toFixed(4)}% ($${analysis.difference.total >= 0 ? '+' : ''}${analysis.difference.total.toFixed(2)})`);
    
    console.log(`${'='.repeat(70)}\n`);
    
}

