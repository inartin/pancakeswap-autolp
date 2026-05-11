#!/usr/bin/env node
/**
 * Export Pool Positions Script
 * 
 * Fetches all unique positions in a PancakeSwap CLMM pool and exports to CSV.
 * 
 * Usage:
 *   node scripts/export-pool-positions.js <POOL_ADDRESS> [output.csv]
 * 
 * Example:
 *   node scripts/export-pool-positions.js 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1 positions.csv
 * 
 * Environment:
 *   SOLANA_RPC_URL - RPC endpoint (defaults to public mainnet)
 * 
 * Output CSV columns:
 *   position_address    - Position account address (PDA)
 *   value_usd           - Position value in USD
 *   range_width_percent - Range width as percentage
 */

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import fs from 'fs';
import { getTokenInfoBatch } from '../src/utils/token.util.js';

// Read IDL
const idl = JSON.parse(fs.readFileSync('./src/idl/pancakeswap-idl.json', 'utf8'));
const coder = new BorshCoder(idl);

// Constants
const PROGRAM_ID = new PublicKey(idl.address);

// PersonalPositionState discriminator from IDL (base58 encoded for RPC filter)
const POSITION_DISCRIMINATOR_BS58 = bs58.encode(Buffer.from([70, 111, 150, 126, 230, 15, 25, 117]));

// Offset to pool_id in PersonalPositionState: 8 (discriminator) + 1 (bump) + 32 (nft_mint) = 41
const POOL_ID_OFFSET = 41;

/**
 * Calculate price from tick
 */
function tickToPrice(tick, decimals0, decimals1) {
  const priceRaw = Math.pow(1.0001, tick);
  const priceAdjFactor = Math.pow(10, decimals0 - decimals1);
  return priceRaw * priceAdjFactor;
}

/**
 * Convert sqrtPriceX64 to price
 */
function sqrtPriceX64ToPrice(sqrtPriceX64, decimals0, decimals1) {
  const Q64 = 2n ** 64n;
  const sqrtPrice = Number(sqrtPriceX64) / Number(Q64);
  const priceRaw = sqrtPrice * sqrtPrice;
  const priceAdjFactor = Math.pow(10, decimals0 - decimals1);
  return priceRaw * priceAdjFactor;
}

/**
 * Calculate token amounts from liquidity
 */
function calculateTokenAmounts(liquidity, sqrtPriceX64, tickCurrent, tickLower, tickUpper) {
  const Q64 = 1n << 64n;
  const mulDiv = (a, b, d) => (a * b) / d;
  const invQ64 = (x) => (Q64 * Q64) / x;
  const sqrtFromTick = (tick) => {
    const sqrtReal = Math.sqrt(Math.pow(1.0001, tick));
    return BigInt(Math.floor(sqrtReal * Number(Q64)));
  };

  const sCur = sqrtPriceX64 || sqrtFromTick(tickCurrent);
  const sL = sqrtFromTick(tickLower);
  const sU = sqrtFromTick(tickUpper);

  let amt0 = 0n, amt1 = 0n;

  if (sL > 0n && sU > 0n && sCur > 0n && liquidity != null) {
    const L = liquidity;
    if (tickCurrent <= tickLower) {
      const term = invQ64(sL) - invQ64(sU);
      amt0 = mulDiv(L, term, Q64);
    } else if (tickCurrent >= tickUpper) {
      const diff = sU - sL;
      amt1 = mulDiv(L, diff, Q64);
    } else {
      const term0 = invQ64(sCur) - invQ64(sU);
      const diff1 = sCur - sL;
      amt0 = mulDiv(L, term0, Q64);
      amt1 = mulDiv(L, diff1, Q64);
    }
  }

  return { amount0: amt0, amount1: amt1 };
}

/**
 * Convert raw amount to human readable
 */
function toHumanAmount(amount, decimals) {
  return Number(amount) / Math.pow(10, decimals);
}


/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.error('Usage: node scripts/export-pool-positions.js <POOL_ADDRESS> [output.csv]');
    process.exit(1);
  }
  
  const poolAddress = args[0];
  const outputFile = args[1] || `positions_${poolAddress.slice(0, 8)}.csv`;
  
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  console.log(`\n🔍 Fetching positions for pool: ${poolAddress}`);
  console.log(`   RPC: ${rpcUrl.slice(0, 50)}...`);
  
  // 1. Fetch pool state
  console.log('\n📊 Fetching pool state...');
  const poolPk = new PublicKey(poolAddress);
  const poolAi = await connection.getAccountInfo(poolPk);
  
  if (!poolAi) {
    console.error('❌ Pool not found');
    process.exit(1);
  }
  
  const pool = coder.accounts.decode('PoolState', poolAi.data);
  const mint0 = new PublicKey(pool.token_mint_0).toString();
  const mint1 = new PublicKey(pool.token_mint_1).toString();
  const decimals0 = pool.mint_decimals_0;
  const decimals1 = pool.mint_decimals_1;
  const sqrtPriceX64 = BigInt(pool.sqrt_price_x64.toString());
  const tickCurrent = pool.tick_current;
  
  console.log(`   Token0: ${mint0.slice(0, 8)}... (${decimals0} decimals)`);
  console.log(`   Token1: ${mint1.slice(0, 8)}... (${decimals1} decimals)`);
  console.log(`   Current tick: ${tickCurrent}`);
  
  // 2. Fetch token prices using existing utility (multi-source with fallbacks)
  console.log('\n💰 Fetching token prices...');
  const [token0Info, token1Info] = await getTokenInfoBatch([mint0, mint1]);
  const price0 = token0Info?.price;
  const price1 = token1Info?.price;
  console.log(`   Token0 (${token0Info?.ticker || 'unknown'}): $${price0?.toFixed(4) || 'N/A'} (${token0Info?.source || 'none'})`);
  console.log(`   Token1 (${token1Info?.ticker || 'unknown'}): $${price1?.toFixed(4) || 'N/A'} (${token1Info?.source || 'none'})`);
  
  if (!price0 || !price1) {
    console.warn('⚠️  Warning: Could not fetch token prices, USD values will be 0');
  }
  
  // 3. Fetch all positions for this pool using getProgramAccounts
  console.log('\n🔎 Fetching all positions (this may take a while)...');
  
  const positions = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: POSITION_DISCRIMINATOR_BS58 } },
      { memcmp: { offset: POOL_ID_OFFSET, bytes: poolPk.toBase58() } }
    ]
  });
  
  console.log(`   Found ${positions.length} position(s)`);
  
  if (positions.length === 0) {
    console.log('\n✅ No positions found for this pool');
    process.exit(0);
  }
  
  // 4. Process each position
  console.log('\n⏳ Processing positions...');
  const positionResults = []; // Array of { positionAddress, valueUsd, rangeWidthPercent }
  
  for (let i = 0; i < positions.length; i++) {
    const { pubkey, account } = positions[i];
    const positionAddress = pubkey.toString();
    
    try {
      const position = coder.accounts.decode('PersonalPositionState', account.data);
      const tickLower = position.tick_lower_index;
      const tickUpper = position.tick_upper_index;
      const liquidity = BigInt(position.liquidity.toString());
      
      // Skip positions with 0 liquidity
      if (liquidity === 0n) continue;
      
      // Calculate token amounts
      const { amount0, amount1 } = calculateTokenAmounts(
        liquidity,
        sqrtPriceX64,
        tickCurrent,
        tickLower,
        tickUpper
      );
      
      const amount0Human = toHumanAmount(amount0, decimals0);
      const amount1Human = toHumanAmount(amount1, decimals1);
      
      // Calculate USD value
      const value0Usd = price0 ? amount0Human * price0 : 0;
      const value1Usd = price1 ? amount1Human * price1 : 0;
      const valueUsd = value0Usd + value1Usd;
      
      // Calculate range width percentage
      const lowerPrice = tickToPrice(tickLower, decimals0, decimals1);
      const upperPrice = tickToPrice(tickUpper, decimals0, decimals1);
      const currentPrice = sqrtPriceX64ToPrice(sqrtPriceX64, decimals0, decimals1);
      const rangeWidthPercent = ((upperPrice - lowerPrice) / currentPrice) * 100;
      
      // Store position data
      positionResults.push({
        positionAddress,
        valueUsd,
        rangeWidthPercent
      });
      
      process.stdout.write(`\r   Processed ${i + 1}/${positions.length} positions...`);
      
    } catch (err) {
      console.log(`   ⚠️  Error processing position ${i + 1}: ${err.message}`);
    }
  }
  
  console.log(`\n\n📊 Found ${positionResults.length} positions with liquidity`);
  
  // 5. Build CSV data
  const csvLines = ['position_address,value_usd,range_width_percent'];
  
  for (const pos of positionResults) {
    csvLines.push(`${pos.positionAddress},${pos.valueUsd.toFixed(2)},${pos.rangeWidthPercent.toFixed(2)}`);
  }
  
  // Sort by value descending
  const header = csvLines.shift();
  csvLines.sort((a, b) => {
    const valA = parseFloat(a.split(',')[1]);
    const valB = parseFloat(b.split(',')[1]);
    return valB - valA;
  });
  csvLines.unshift(header);
  
  // 6. Write CSV
  fs.writeFileSync(outputFile, csvLines.join('\n'));
  console.log(`\n✅ Exported to ${outputFile}`);
  
  // Print summary
  const totalValueUsd = positionResults.reduce((sum, p) => sum + p.valueUsd, 0);
  const totalPositions = positionResults.length;
  const avgPositionValue = totalPositions > 0 ? totalValueUsd / totalPositions : 0;
  
  console.log(`\n📈 Summary:`);
  console.log(`   Total positions: ${totalPositions}`);
  console.log(`   Total pool value: $${totalValueUsd.toFixed(2)}`);
  console.log(`   Average position value: $${avgPositionValue.toFixed(2)}`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

