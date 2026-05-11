# Rebalance Worth Loss Tracking

## Overview

This feature tracks the total worth (wallet balances + LP position value) before and after rebalancing to measure the exact cost of rebalancing, including:

- **Slippage losses** from swaps
- **Transaction fees** (SOL, priority fees)
- **Impermanent Loss (IL)** impact from position restructuring
- **Price impact** from trading
- **Token balance changes** during the process

## How It Works

### 1. Before Rebalancing (Snapshot 1)
Before closing the current position, the system captures:
- **Wallet token balances**: SOL, USDC, CAKE (and other reward tokens)
- **LP position value**: Current USD value of liquidity in the pool
- **Token prices**: Latest USD prices for all tokens

### 2. After Rebalancing (Snapshot 2)
After opening the new position, the system captures:
- **Wallet token balances**: Updated balances after all swaps/fees
- **New LP position value**: USD value of liquidity in new position
- **Token prices**: Latest USD prices (recalculated)

### 3. Worth Loss Calculation
The system calculates:
```
Total Worth Before = Wallet USD + LP USD
Total Worth After = Wallet USD + LP USD
Worth Difference = After - Before
Worth Loss % = (Difference / Before) × 100
```

## Example Output

```
======================================================================
📊 REBALANCE WORTH LOSS ANALYSIS
======================================================================
Position: 4qQeZ5Lw...u8jCtgXy
Pool: SOL/USDC
Range: ±2.5%
----------------------------------------------------------------------

📸 BEFORE REBALANCE:
   Wallet: $45.23
   LP:     $1,234.56
   Total:  $1,279.79

📸 AFTER REBALANCE:
   Wallet: $38.91
   LP:     $1,236.42
   Total:  $1,275.33

📈 DIFFERENCE:
   Wallet: -$6.32
   LP:     +$1.86
   Total:  -$4.46

📉 LOSS: -0.3485% (-$4.46)
======================================================================
```

## Breakdown Components

### Wallet Changes
- **Before**: Total USD value of all tokens in wallet (SOL, USDC, CAKE, etc.)
- **After**: Updated wallet balances after swaps, fees, and position opening
- **Difference**: Shows how much was spent from wallet (fees, deposits into LP)

### LP Changes
- **Before**: USD value of tokens locked in old position
- **After**: USD value of tokens locked in new position
- **Difference**: Shows if new position captured more/less value

### Total Worth Loss
- **Negative %**: Money was lost to fees, slippage, IL
- **Positive %**: Money was gained (rare, usually from favorable price movements)

## What Causes Worth Loss?

1. **Transaction Fees** (~0.01-0.05 SOL per tx)
   - Close position transaction
   - Swap transactions (if balancing tokens)
   - Open position transaction

2. **Swap Slippage** (0.1-1% typical)
   - Converting rewards to position tokens
   - Balancing token ratios for new position

3. **Price Impact** (depends on liquidity)
   - Large swaps can move the price
   - More impact on low-liquidity pools

4. **Price Movements**
   - Tokens can change price between snapshots
   - Usually small impact (<1 min time difference)

5. **Impermanent Loss Reset**
   - Closing position locks in any IL
   - Opening new position resets IL counter

## When To Worry

- **< 0.5% loss**: Normal, acceptable for most rebalances
- **0.5-1% loss**: Higher than ideal, review swap settings
- **1-2% loss**: Concerning, check for:
  - High slippage swaps
  - Large price movements during rebalance
  - Pool liquidity issues
- **> 2% loss**: Investigate immediately:
  - May indicate sandwich attacks
  - Extreme price volatility
  - Configuration issues

## Integration

The tracking is automatically enabled for all rebalances:
- Manual rebalances (`/rebalance` command)
- Auto-rebalances (position-monitor service)
- Retry flows (after failed rebalances)

Results are logged to console for analysis.

## Database Tracking

Rebalance P/L is automatically saved to the database in the `position_statistics` table:

- **`cumulative_rebalance_pl_usd`**: Running total of all rebalance P/L for the position
  - Negative values = cumulative losses
  - Positive values = cumulative gains
  - Resets when position is closed/reopened

- **`last_rebalance_pl_usd`**: P/L from the most recent rebalance
  - Shows the exact gain/loss from the last rebalance operation

### Example
```
Position created with $1,000
Rebalance 1: -$4.46   → cumulative: -$4.46
Rebalance 2: -$3.20   → cumulative: -$7.66
Rebalance 3: +$1.50   → cumulative: -$6.16
```

## Future Enhancements

Planned features:
- [ ] Generate reports on average worth loss per pool
- [ ] Alert users when worth loss exceeds threshold
- [ ] Compare worth loss across different range widths

## Files

- **Tracking Utility**: `src/utils/rebalance-tracking.util.js`
  - `captureRebalanceSnapshot()` - Captures wallet + LP snapshot
  - `calculateWorthLoss()` - Calculates difference between snapshots
  - `logWorthLossAnalysis()` - Formats and logs results

- **Integration**: `src/bot/handlers/rebalance.handler.js`
  - Snapshots captured before `removeLiquidity()`
  - Snapshots captured after `openPosition()`
  - Analysis logged to console
  - P/L saved to database via `recordRebalancePL()`

- **Database Service**: `src/services/position-statistics.service.js`
  - `recordRebalancePL()` - Saves P/L to `position_statistics` table

## Technical Details

### Snapshot Structure
```javascript
{
  timestamp: 1704931200000,
  token0: {
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    balance: 10.5,
    price: 98.45,
    usd: 1033.73
  },
  token1: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    balance: 250.0,
    price: 1.0,
    usd: 250.0
  },
  rewards: [
    {
      mint: "...",
      symbol: "CAKE",
      balance: 5.2,
      price: 2.15,
      usd: 11.18
    }
  ],
  rewardsUsd: 11.18,
  lpValueUsd: 1234.56,
  totalWalletUsd: 1294.91,
  totalWorthUsd: 2529.47
}
```

### Analysis Structure
```javascript
{
  before: {
    wallet: 1294.91,
    lp: 1234.56,
    total: 2529.47
  },
  after: {
    wallet: 1288.23,
    lp: 1236.42,
    total: 2524.65
  },
  difference: {
    wallet: -6.68,
    lp: +1.86,
    total: -4.82
  },
  worthLossPercent: -0.1906,
  worthLossUsd: 4.82,
  isProfit: false
}
```

## Notes

- Tracking is non-blocking (wrapped in try-catch)
- If snapshot fails, rebalance continues normally
- All USD calculations use live token prices
- SOL balance accounts for 0.05 SOL fee reserve
- WSOL and native SOL are treated as equivalent
- Reward tokens are detected from position metadata

