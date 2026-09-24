/**
 * Application Constants
 *
 * Centralized configuration and constants for the PancakeSwap Autofarmer bot.
 * All magic numbers and configuration values should be defined here.
 *
 * Organization:
 * - Application metadata (name, version)
 * - Solana program addresses
 * - Token programs
 * - PDA seeds for account derivation
 * - CLMM configuration
 * - Jupiter swap settings
 * - Transaction timeouts and limits
 * - API configuration (Moralis retry/cache settings)
 * - Position monitoring configuration
 * - Liquidity management thresholds
 * - Known token definitions
 * - Helper utility functions
 *
 * @module config/constants
 */

import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';

// Read the IDL file
const idl = JSON.parse(fs.readFileSync('./src/idl/pancakeswap-idl.json', 'utf8'));
const meteoraIdl = JSON.parse(fs.readFileSync('./src/idl/meteora-idl.json', 'utf8'));

// =================================
// APPLICATION METADATA
// =================================

export const APP_NAME = 'autofarmer-pcs';
export const APP_VERSION = '0.12.4';

// =================================
// SOLANA PROGRAMS
// =================================

// PancakeSwap CLMM Program (from IDL)
export const PROGRAM_ID = new PublicKey(idl.address);

// Meteora DLMM Program (from IDL)
export const METEORA_PROGRAM_ID = new PublicKey(meteoraIdl.address || 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// Solana system programs
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// =================================
// TOKEN PROGRAMS
// =================================

export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;
export const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID;

// =================================
// PDA SEEDS
// =================================

// Personal position account seed ("position")
export const POSITION_SEED = Buffer.from([112, 111, 115, 105, 116, 105, 111, 110]);

// Tick array account seed ("tick_array")
export const TICK_ARRAY_SEED = Buffer.from([116, 105, 99, 107, 95, 97, 114, 114, 97, 121]);

// Tick array bitmap extension seed ("pool_tick_array_bitmap_extension")
export const TICK_ARRAY_BITMAP_EXTENSION_SEED = Buffer.from([112, 111, 111, 108, 95, 116, 105, 99, 107, 95, 97, 114, 114, 97, 121, 95, 98, 105, 116, 109, 97, 112, 95, 101, 120, 116, 101, 110, 115, 105, 111, 110]);

// =================================
// CLMM CONFIGURATION
// =================================

// Number of ticks in a tick array
export const TICKS_IN_ARRAY = 60;

// PancakeSwap IDL for Anchor coder
export const PANCAKESWAP_IDL = idl;

// Meteora DLMM IDL for Anchor coder
export const METEORA_IDL = meteoraIdl;

// =================================
// JUPITER SWAP CONFIGURATION
// =================================

// Jupiter API base URL (configurable via env)
export const JUPITER_API_BASE_URL = process.env.JUPITER_API_BASE_URL || 'https://api.jup.ag/swap/v1';

// =================================
// JUPITER WEBSOCKET CONFIGURATION
// =================================

// Jupiter WebSocket URL for real-time price streaming
export const JUPITER_WS_URL = 'wss://trench-stream.jup.ag/ws';

// Required headers for Jupiter WebSocket connection
export const JUPITER_WS_HEADERS = {
    'Origin': 'https://jup.ag',
    'User-Agent': 'Mozilla/5.0 (compatible; AutofarmerBot/1.0)'
};

// Price cache TTL in seconds (how long cached prices are considered fresh)
export const PRICE_CACHE_TTL_SECONDS = 60;

// Maximum priority fee cap to prevent fund drainage (~0.012 SOL at max escalation)
// Allows 5x escalation: 6M base → 30M max (attempt 5) during active markets
export const MAX_PRIORITY_FEE_LAMPORTS = 30000000;

// Fallback priority fee when no env override provided (1M micro-lamports = ~0.001 SOL)
export const FALLBACK_PRIORITY_FEE_LAMPORTS = 1000000;

// Default priority fee in microlamports (~0.0001 SOL)
// Configurable via JUPITER_PRIORITY_FEE_LAMPORTS env variable
export const DEFAULT_PRIORITY_FEE_LAMPORTS = (() => {
  const envValue = process.env.JUPITER_PRIORITY_FEE_LAMPORTS;
  const parsed = envValue ? parseInt(envValue, 10) : NaN;
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_PRIORITY_FEE_LAMPORTS;
  // Cap at maximum to prevent fund drainage
  return Math.min(value, MAX_PRIORITY_FEE_LAMPORTS);
})();

// =================================
// TRANSACTION CONFIGURATION
// =================================

// Solana commitment level for RPC connections and transaction confirmation
// 'confirmed' provides good balance between speed and finality (~400ms, 66%+ stake voted)
export const COMMITMENT_LEVEL = 'confirmed';

// Commitment level for preflight simulation (transaction validation before sending)
// 'processed' is faster and checks against latest state without waiting for confirmation
// Used for skipPreflight=false preflightCommitment parameter
export const PREFLIGHT_COMMITMENT = 'processed';

// Default compute units for transactions
// Used for priority fee calculation: total_fee = compute_units × microlamports_per_CU
// 400k units is sufficient for most CLMM operations (position creation, liquidity management)
export const DEFAULT_COMPUTE_UNITS = 400_000;

// Blockchain finalization delay after critical operations (0.5 second)
// Used after claim/swap operations to ensure state is settled
export const FINALIZATION_DELAY_MS = 200;

// Confirmation polling timeout (30 seconds)
// Maximum time to wait for transaction confirmation before giving up.
export const CONFIRMATION_TIMEOUT_MS = 30000;

// Per-attempt confirmation timeout (15 seconds)
// Time to wait before failing an attempt and retrying with higher priority.
// Set higher during network congestion. Previous: 5000ms (too aggressive)
export const CONFIRMATION_ATTEMPT_TIMEOUT_MS = 15000;

// Confirmation polling interval (0.3 seconds)
// Frequency at which we re-query `getSignatureStatuses` while waiting for
// confirmation, balancing responsiveness with RPC rate limits.
export const CONFIRMATION_POLL_INTERVAL_MS = 300;

// HTTP request timeout (8 seconds)
export const HTTP_REQUEST_TIMEOUT_MS = 8000;

// Priority fee cache TTL (3 seconds)
// Used to prevent rate-limit hits on Helius getPriorityFeeEstimate calls
export const PRIORITY_FEE_CACHE_TTL_MS = 30000; // 30 seconds - priority fees don't change rapidly

// Transaction retry backoff delays
export const RETRY_DELAY_BASE_MS = 300;              // Base delay between retries (300ms)
export const RETRY_DELAY_MAX_MS = 500;               // Maximum retry delay cap (500ms)

// Transaction metadata parsing retry settings
// Used when parsing token balance changes from transaction metadata
// RPC nodes may need time to index transaction details after confirmation
export const TX_METADATA_PARSE_MAX_RETRIES = parseInt(process.env.TX_METADATA_PARSE_MAX_RETRIES || '3', 10);
export const TX_METADATA_PARSE_RETRY_DELAY_MS = parseInt(process.env.TX_METADATA_PARSE_RETRY_DELAY_MS || '1000', 10);

// =================================
// API CONFIGURATION
// =================================

// Moralis API settings
// Used for token price and metadata fetching
export const MORALIS_MAX_RETRIES = 3;                // Number of retry attempts on API failure
export const MORALIS_RETRY_DELAY_MS = 300;           // Delay between retry attempts (300ms)
export const MORALIS_CACHE_DURATION_MS = 1000;       // Response cache duration (1 second)

// Jupiter API settings
// Used for token price and metadata fetching (primary source)
export const JUPITER_MAX_RETRIES = 3;                // Number of retry attempts on API failure
export const JUPITER_RETRY_DELAY_MS = 500;           // Delay between retry attempts (500ms)

// =================================
// POSITION MONITORING CONFIGURATION
// =================================

// Position monitoring interval (30 seconds)
export const POSITION_MONITOR_INTERVAL_MS = 30 * 1000;

// Pool price cache TTL (10 seconds)
export const PRICE_CACHE_TTL_MS = 10000;

// Out-of-range alert cooldown period (1 min)
export const ALERT_COOLDOWN_MS = 60 * 1000;

// Proximity alert cooldown period (1 minutes)
export const PROXIMITY_COOLDOWN_MS = 60 * 1000;

// Range percentage precision for display (0.1% granularity)
// Used for rounding range percentages: Math.ceil(percent * RANGE_PERCENT_PRECISION) / RANGE_PERCENT_PRECISION
export const RANGE_PERCENT_PRECISION = 10;

// =================================
// MARKET DATA & AUTO-REBALANCING
// =================================

// Jupiter Price API endpoint for price candles
export const JUPITER_PRICE_API_BASE_URL = 'https://datapi.jup.ag/v2/charts';

// API Headers (prevents rate limiting/banning by appearing as browser traffic)
export const JUPITER_API_HEADERS = {
    'Origin': 'https://jup.ag',
    'Referer': 'https://jup.ag',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// SOL mint address for price queries
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

// CAKE mint address for price queries (PancakeSwap reward token)
export const CAKE_MINT = '4qQeZ5LwSz6HuupUu8jCtgXyW1mYQcNbFAW1sWZp89HL';

// Price history retention (2 hours of 1-minute candles)
export const PRICE_HISTORY_CANDLE_COUNT = 120;

// Market data update interval (matches position monitor, 30 seconds)
export const MARKET_DATA_UPDATE_INTERVAL_MS = 30 * 1000;

// Rate limiting: Minimum time between API calls (prevents bans)
export const MIN_FETCH_INTERVAL_MS = 30 * 1000; // 30 seconds
export const MAX_CANDLES_PER_REQUEST = 1440;    // 24 hours max (API limit)

// Minimum candles required for calculations
export const MIN_CANDLES_FOR_TWAP_5 = 5;
export const MIN_CANDLES_FOR_TWAP_15 = 15;
export const MIN_CANDLES_FOR_ATR_15 = 16;  // Need +1 for prev_close
export const MIN_CANDLES_FOR_ATR_1H = 61;  // Need +1 for prev_close
export const MIN_CANDLES_FOR_DRIFT = 20;   // 5 for TWAP + 15 for drift window

// Auto-rebalance configuration (per-position control via database)
// Strategy: Profit Maximization (not fee maximization)
// Philosophy: Net Profit = Fee Income - Impermanent Loss - Transaction Costs
export const AUTO_REBALANCE_CONFIG = {
  // Range modes (volatility-adaptive) - UPDATED: Wider ranges, longer patience
  RANGE_MODES: {
    TIGHT: {
      atrThreshold: 1.5,       // Use when ATR < 1.5%
      minWidth: 2,           // Minimum range width
      maxWidth: 2.5,           // Maximum range width (dynamic within range)
      baseWaitMinutes: 60,     // Base wait time (was 6 minutes)
      maxWaitMinutes: 120      // Maximum wait time before forced rebalance
    },
    NORMAL: {
      atrThreshold: 2.5,       // Use when ATR 1.5-2.5%
      minWidth: 2.6,           // Minimum range width (was fixed 1.5%)
      maxWidth: 3.1,           // Maximum range width (dynamic within range)
      baseWaitMinutes: 90,     // Base wait time (was 10 minutes)
      maxWaitMinutes: 150      // Maximum wait time before forced rebalance
    },
    WIDE: {
      atrThreshold: Infinity,  // Use when ATR > 2.5%
      minWidth: 3.2,           // Minimum range width (was fixed 3.0%)
      maxWidth: 5,           // Maximum range width (dynamic within range)
      baseWaitMinutes: 120,    // Base wait time (was 15 minutes)
      maxWaitMinutes: 180      // Maximum wait time before forced rebalance
    }
  },
  
  // Proactive Range Optimization: DISABLED (causes over-rebalancing)
  // Tightening while in-range is a bet that calm will continue
  // If wrong, it guarantees earlier out-of-range events
  PROACTIVE_OPTIMIZATION: {
    enabled: false,            // DISABLED per new strategy
  },
  
  // Range optimization: Widening enabled, tightening disabled
  RANGE_OPTIMIZATION: {
    // Tightening: DISABLED (causes fragile positions)
    tightening: {
      enabled: false,          // DISABLED per new strategy
    },
    
    // Fast widening on volatility spikes (defensive, keep enabled)
    widening: {
      enabled: true,
      checkIntervalMinutes: 15,      // Check 4x more often than tightening
      atrIncreaseThreshold: 1.3,     // If ATR increases 30% → widen
      wideningStepSize: 0.4,         // Jump wider quickly (0.4% steps)
      maxWidening: 1.2,              // Max widening from current (e.g., 0.8% → 2.0%)
      immediateWiden: true,          // Don't wait, widen immediately
    }
  },
  
  // Wait periods before rebalancing (patience, not reactivity)
  WAIT_PERIODS: {
    crossbackReductionMinutes: 1,  // was 2 (less “speed-up” in chop)
    minWaitMinutes: 3,
    choppyThreshold: 3,
    choppyWaitCapMinutes: 12,      // was 10 (be a bit more patient in chop)
    maxWaitMinutes: 45             // was 60 (don’t stall too long when truly OOR)
  },
  
  // Chop detection (affects wait time, NOT range width)
  CHOP: {
    crossbackWindow: 90,    // Track crossbacks over 90 minutes
    choppyThreshold: 3,     // 3+ crossbacks = choppy market
    forceWideMode: false    // Don't force WIDE mode - use ATR-based mode instead
  },
  
  // Safety rails (updated limits + IL profitability check)
  SAFETY: {
    baseDailyLimit: 25,            // Max 25 rebalances/day (reduced from 40)
    hourlyChurnLimit: 4,           // Max 4/hour (hard limit, anti-churn)
    recentCooldownMinutes: 12,     // Cooldown window for rapid retries
    recentCooldownDailyThreshold: 4, // Cooldown kicks in after 4 rebalances/day
    forceNormalDailyThreshold: 6,  // After 6/day, avoid TIGHT mode
    forceWideDailyThreshold: 10,   // After 10/day, temporarily force WIDE
    forcedModeCooldownMinutes: 45, // Forced modes expire after 45 minutes
    
    // Exceptions that bypass daily limit
    BYPASS_EXCEPTIONS: {
      extendedOorHours: 4,         // > 4 hours OOR
      longGapHours: 6,             // > 6 hours since last rebalance
      largePositionUsd: 500,       // Position value > $500
      largePositionOorHours: 2     // Large position OOR > 2 hours
    },
    
    // Minimum values to prevent wasteful gas
    minPositionValueUsd: 50,       // Don't rebalance if < $50
    minWalletSol: 0.05,           // Don't rebalance if < 0.05 SOL
    
    // NEW: Impermanent Loss breakeven check
    // Only rebalance when: Expected Fees > IL Cost + Tx Cost + 50% margin
    IL_BREAKEVEN: {
      enabled: true,               // Enable IL profitability check
      minBreakEvenRatio: 1.5,      // Expected fees must be 1.5x costs
      expectedHoursInRange: 12,    // Assume 12h in range after rebalance
      ilSeverityFactor: 0.6,       // IL estimation multiplier (empirical)
    }
  },
  
  // Price calculation
  PRICE_CENTER: 'TWAP_5m'  // Use 5-minute TWAP as center (not spot price)
};

// =================================
// LIQUIDITY MANAGEMENT
// =================================

// Lamports per SOL conversion factor
export const LAMPORTS_PER_SOL = 1e9;

// Microlamport conversion for priority fee calculations
export const MICROLAMPORTS_PER_LAMPORT = 1_000_000;

// Minimum SOL reserve for transaction fees (configurable)
export const DEFAULT_MIN_SOL_RESERVE = 0.05;

// Small buffer for SOL reserve check to prevent failures from tiny variations
export const SOL_RESERVE_BUFFER = 0.005; // allow 0.005 SOL under buffer

// Recommended SOL buffer for user error messages (additional safety margin on top of MIN_RESERVE)
export const RECOMMENDED_SOL_BUFFER = 0.02;          // 0.02 SOL safety buffer

// =================================
// SLIPPAGE TOLERANCE CONFIGURATION (BASIS POINTS)
// =================================
// Note: 100 bps = 1%, 50 bps = 0.5%
// Optimized for lower LP drain with SWQOS + Jupiter Ultra infrastructure

// Default slippage for token swaps via Jupiter
// Used for all token-to-token swap operations
export const DEFAULT_SWAP_SLIPPAGE_BPS = 50;  // 0.5%

// Default slippage for adding liquidity to existing positions
// Used when increasing liquidity or removing liquidity from positions
export const DEFAULT_ADD_LIQUIDITY_SLIPPAGE_BPS = 50;  // 0.5%

// Default slippage for opening new positions
// Moderate tolerance for multi-step operations (wrapping, minting NFT, creating accounts)
export const DEFAULT_OPEN_POSITION_SLIPPAGE_BPS = 100;  // 1%

// Retry slippage escalation for position opening
// Gradual escalation: 100 → 150 → 200 bps (capped)
export const MIN_RETRY_SLIPPAGE_BPS = 100;           // 1% minimum on second attempt
export const RETRY_SLIPPAGE_INCREMENT_BPS = 50;      // 0.5% increment per retry
export const MAX_RETRY_SLIPPAGE_BPS = 200;           // 2% maximum (cap to prevent excessive slippage)

// Fresh quote configuration for swap execution
// If price drifts more than this threshold between quote and expected, refetch quote
export const PRICE_DRIFT_THRESHOLD_BPS = 30;         // 0.3% max acceptable drift
export const FRESH_QUOTE_MAX_RETRIES = 3;            // Max quote refresh attempts
export const FRESH_QUOTE_RETRY_DELAY_MS = 500;       // Delay between quote refreshes

// Idle funds recovery configuration
// Minimum USD value to trigger automatic recovery of idle funds
export const IDLE_FUNDS_RECOVERY_MIN_USD = 100;      // $100 minimum to attempt recovery

// Minimum utilization threshold for compound retry (20%)
export const MIN_UTILIZATION_PERCENT = 0.2;

// Minimum USD value to proceed with compound operation
// Claims below this threshold are skipped to save on transaction fees
export const MIN_USD_TO_COMPOUND = 1;

// Minimum USD value to enable auto-balance swaps during compound
// For small amounts (<$2.5), skip balance swaps to save fees and just deposit what fits
export const MIN_USD_FOR_AUTO_BALANCE = 2.5;

// =================================
// SPLIT STRATEGY CONFIGURATION
// =================================

// Split strategy percentage allocation
// When split_strategy is enabled on a wallet, claimed rewards are divided:
// - SPLIT_CLAIM_PERCENT goes to the claim_address (user's wallet)
// - Remaining (1 - SPLIT_CLAIM_PERCENT) stays in the current wallet (no transfer)
// Default: 0.75 = 75% to claim address, 25% kept in wallet
export const SPLIT_CLAIM_PERCENT = parseFloat(process.env.SPLIT_CLAIM_PERCENT || '0.75');

// Validate split percentage is between 0 and 1
if (SPLIT_CLAIM_PERCENT < 0 || SPLIT_CLAIM_PERCENT > 1) {
  throw new Error(`SPLIT_CLAIM_PERCENT must be between 0 and 1, got ${SPLIT_CLAIM_PERCENT}`);
}

// Derived percentage kept in wallet (always sums to 100%)
export const SPLIT_KEEP_PERCENT = 1 - SPLIT_CLAIM_PERCENT;

// =================================
// HELIUS SWQOS CONFIGURATION
// =================================

/**
 * Helius SWQOS (Staked Weighted Quality of Service) Configuration
 * 
 * SWQOS provides 95-99% transaction success rates by routing through
 * stake-weighted validators. Perfect for non-MEV transactions.
 * 
 * Cost breakdown:
 * - Priority fee: ~$0.0003 (dynamic, from Helius API)
 * - SWQOS tip: ~$0.0005 (fixed, 5,000 lamports)
 * - Total: ~$0.0008 per transaction
 * 
 * Enable/disable via USE_SWQOS environment variable (default: enabled)
 */
export const SWQOS_CONFIG = {
  // Helius Sender API endpoint (SWQOS-only mode)
  SENDER_ENDPOINT: 'https://sender.helius-rpc.com/fast?swqos_only=true',
  
  // SWQOS tip amount (0.000005 SOL = 5,000 lamports)
  TIP_LAMPORTS: 5_000,
  
  // Tip accounts for load distribution (randomly selected per transaction)
  // These are Helius's official SWQOS tip accounts from their documentation
  TIP_ACCOUNTS: [
    '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
    'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
    '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
    '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
    '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
    '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
    'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
    '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
    '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
    '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or'
  ]
};

// =================================
// TOKEN DEFINITIONS
// =================================

/**
 * Known Solana token mint addresses and metadata
 * Includes stablecoins with fixed prices for optimization
 */
export const KNOWN_TOKENS = {
  SOL: {
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL"
  },
  USDC: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    price: 1 // Stablecoin pegged to $1
  },
  USDC_LEGACY: {
    mint: "EPjFWdd5AufqSSqeM2qZQJouo2S8G4XqfX3ZyQf5w4h",
    symbol: "USDC",
    price: 1 // Legacy USDC variant
  },
  USDC_2022: {
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    symbol: "USDC",
    price: 1 // Token-2022 USDC
  },
  USDT: {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    symbol: "USDT",
    price: 1 // Stablecoin pegged to $1
  },
  CAKE: {
    mint: "4qQeZ5LwSz6HuupUu8jCtgXyW1mYQcNbFAW1sWZp89HL",
    symbol: "CAKE"
  }
};

// =================================
// EVM / UNISWAP CONFIGURATION
// =================================

/**
 * Known Uniswap contract addresses on Ethereum mainnet
 */
export const EVM_CONTRACTS = {
    UNISWAP_V3_POSITION_MANAGER: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    UNISWAP_V3_FACTORY:          '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    UNISWAP_V4_POSITION_MANAGER: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
    UNISWAP_V4_POOL_MANAGER:     '0x000000000004444c5dc75cB358380D2e3dE08A90',
    UNISWAP_V4_STATE_VIEW:       '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
};

/**
 * Known EVM token addresses and symbols on Ethereum mainnet
 * WETH is displayed as ETH to match standard pool naming conventions
 */
export const EVM_KNOWN_TOKENS = {
    ETH: {
        address: '0x0000000000000000000000000000000000000000',
        symbol: 'ETH'
    },
    WETH: {
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        symbol: 'ETH' // Display as ETH — WETH is wrapped ETH
    },
    USDC: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC'
    },
    WBTC: {
        address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
        symbol: 'WBTC'
    }
};

/**
 * Known Uniswap pool addresses on Ethereum mainnet
 */
export const EVM_KNOWN_POOLS = {
    '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640': {
        name: 'USDC/ETH',
        version: 'V3'
    }
};

/**
 * Block number when Uniswap V4 PositionManager was deployed on Ethereum mainnet.
 * Used as the starting block for Transfer event scanning.
 */
export const UNISWAP_V4_DEPLOYMENT_BLOCK = 21688329;

/**
 * Minimal ABI for reading Uniswap V3 NonfungiblePositionManager positions.
 * Includes ERC721Enumerable functions and the positions query.
 */
export const UNISWAP_V3_POSITION_ABI = [
    'function balanceOf(address owner) external view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
    'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
];

/**
 * Minimal ABI for the Uniswap V3 Factory — used to look up the pool address
 * from (token0, token1, fee) so slot0 can be queried for the current tick.
 */
export const UNISWAP_V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

/**
 * Minimal ABI for a Uniswap V3 pool — only slot0 is needed to read the current tick.
 */
export const UNISWAP_V3_POOL_SLOT0_ABI = [
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

/**
 * Minimal ABI for reading Uniswap V4 PositionManager positions.
 * V4 does not implement ERC721Enumerable — Transfer events are used to discover tokenIds.
 */
export const UNISWAP_V4_POSITION_ABI = [
    'function balanceOf(address owner) external view returns (uint256)',
    'function ownerOf(uint256 tokenId) external view returns (address)',
    'function getPoolAndPositionInfo(uint256 tokenId) external view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
    'function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

/**
 * Minimal ABI for the Uniswap V4 StateView lens contract — used to query the current tick
 * of a V4 pool via getSlot0(poolId). StateView wraps StateLibrary for offchain reads.
 */
export const UNISWAP_V4_STATE_VIEW_ABI = [
    'function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'
];

// =================================
// UTILITY FUNCTIONS
// =================================

/**
 * Get EVM token symbol from a contract address.
 * Matches against EVM_KNOWN_TOKENS (case-insensitive).
 *
 * @param {string} address - EVM token contract address
 * @returns {string} Token symbol or abbreviated address for unknown tokens
 */
export function getEvmTokenSymbol(address) {
    if (!address) return 'Unknown';
    const lowerAddr = address.toLowerCase();
    for (const token of Object.values(EVM_KNOWN_TOKENS)) {
        if (token.address.toLowerCase() === lowerAddr) return token.symbol;
    }
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Get token symbol from mint address
 *
 * @param {string|PublicKey} mintAddress - Token mint address
 * @returns {string} Token symbol or abbreviated address
 */
export function getTokenSymbol(mintAddress) {
  const mint = String(mintAddress);

  if (mint === KNOWN_TOKENS.SOL.mint) return KNOWN_TOKENS.SOL.symbol;
  if (mint === KNOWN_TOKENS.USDC.mint) return KNOWN_TOKENS.USDC.symbol;
  if (mint === KNOWN_TOKENS.USDC_LEGACY.mint) return KNOWN_TOKENS.USDC_LEGACY.symbol;
  if (mint === KNOWN_TOKENS.USDC_2022.mint) return KNOWN_TOKENS.USDC_2022.symbol;
  if (mint === KNOWN_TOKENS.USDT.mint) return KNOWN_TOKENS.USDT.symbol;

  // For unknown tokens, show abbreviated address
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}
