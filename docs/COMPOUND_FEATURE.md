# Compound Feature - Technical Documentation

## Overview

The compound feature automatically reinvests claimed rewards back into your PancakeSwap CLMM position by:
1. Claiming all rewards and fees
2. Converting non-pool tokens to pool tokens via Jupiter
3. Balancing token amounts to match the pool's optimal ratio
4. Adding liquidity back to the position

**File**: `src/utils/compound.util.js`

---

## Key Features

✅ **Universal Token Handling**
- Handles 2-5 different token types (2 fee tokens + 0-3 reward tokens)
- Automatically detects pool token pair
- Swaps any non-pool tokens using Jupiter

✅ **Intelligent Swapping**
- Uses Jupiter's routing for best swap prices
- Swaps extra tokens to the pool token with lower balance
- Optional auto-balancing to match CLMM optimal ratio
- Configurable slippage protection

✅ **Safety Guarantees**
- Never uses more funds than what was claimed
- Minimum USD threshold to prevent dust compounding
- Comprehensive error handling at each phase
- Detailed transaction tracking

✅ **CLMM Math Integration**
- Calculates optimal token ratio based on position range
- Handles in-range and out-of-range positions
- Uses sqrt price calculations for accuracy

---

## Architecture

### 5-Phase Process

```
┌─────────────────────────────────────────────────────────────┐
│                    COMPOUND WORKFLOW                        │
└─────────────────────────────────────────────────────────────┘

Phase 1: CLAIM REWARDS
  ├─ Call claimRewards() utility
  ├─ Check minimum USD threshold
  └─ Return claimed tokens array

Phase 2: ANALYZE POOL
  ├─ Fetch position and pool information
  ├─ Identify pool tokens (token0, token1)
  ├─ Categorize: pool tokens vs extra tokens
  └─ Calculate current balances

Phase 3: SWAP EXTRA TOKENS
  ├─ For each non-pool token:
  │   ├─ Determine target (lower balance pool token)
  │   ├─ Swap using Jupiter
  │   └─ Update balances
  └─ Track all swap transactions

Phase 4: BALANCE AMOUNTS (Optional)
  ├─ Calculate optimal ratio using CLMM math
  ├─ Compare with current ratio
  ├─ If imbalance > 5%:
  │   ├─ Swap excess token to deficit token
  │   └─ Update balances
  └─ Skip if autoBalance = false

Phase 5: ADD LIQUIDITY
  ├─ Add balanced amounts to position
  ├─ Track deposited amounts
  └─ Return comprehensive result
```

---

## Usage

### Basic Usage

```javascript
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { compoundRewards } from './src/utils/compound.util.js';

const connection = new Connection(rpcUrl);
const wallet = Keypair.fromSecretKey(privateKey);
const positionMint = new PublicKey('your_position_nft_mint');

const result = await compoundRewards(connection, wallet, positionMint);

if (result.success) {
  console.log(`Compounded $${result.summary.totalUsdCompounded}`);
  console.log(`Performed ${result.summary.swapCount} swaps`);
  console.log(`Added liquidity: ${result.summary.liquidityAdded}`);
}
```

### Advanced Configuration

```javascript
const result = await compoundRewards(connection, wallet, positionMint, {
  slippageBps: 300,          // 3% slippage for adding liquidity
  swapSlippageBps: 150,      // 1.5% slippage for Jupiter swaps
  autoBalance: true,         // Auto-balance token ratios (default: true)
  minUsdToCompound: 5        // Only compound if >= $5 (default: $1)
});
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `slippageBps` | number | 200 | Slippage for adding liquidity (basis points) |
| `swapSlippageBps` | number | 100 | Slippage for Jupiter swaps (basis points) |
| `autoBalance` | boolean | true | Automatically balance token ratios |
| `minUsdToCompound` | number | 1 | Minimum USD value to compound |

---

## Return Object

### Success Response

```javascript
{
  success: true,
  
  // Claim phase result
  claimResult: {
    success: true,
    signature: "...",
    explorer: "https://solscan.io/tx/...",
    claimed: [
      {
        type: "Fee",
        mint: "...",
        amount: "...",
        uiAmount: 0.123,
        decimals: 9,
        usdValue: 12.34,
        symbol: "SOL"
      },
      // ... more tokens
    ],
    totalUsd: 50.00
  },
  
  // All swap transactions
  swaps: [
    {
      inputToken: "REWARD",
      inputAmount: 100,
      outputToken: "SOL",
      outputAmount: 0.5,
      signature: "...",
      explorer: "https://solscan.io/tx/...",
      purpose: "extra_token" // or "balance"
    }
  ],
  
  // Add liquidity phase result
  addLiquidityResult: {
    success: true,
    signature: "...",
    explorer: "https://solscan.io/tx/...",
    liquidityAdded: "1234567890",
    tokensDeposited: [...],
    totalUsd: 48.50
  },
  
  // Summary statistics
  summary: {
    totalUsdClaimed: 50.00,
    totalUsdCompounded: 48.50,
    swapCount: 2,
    tokensClaimed: 3,
    liquidityAdded: "1234567890"
  },
  
  // All transaction links
  transactions: {
    claim: "https://solscan.io/tx/...",
    swaps: ["https://solscan.io/tx/...", ...],
    addLiquidity: "https://solscan.io/tx/..."
  }
}
```

### Error Response

```javascript
{
  success: false,
  error: "Error message",
  phase: "claim" | "add_liquidity" | null,
  claimResult?: {...},  // If claim succeeded
  swaps?: [...],         // If any swaps succeeded
  addLiquidityResult?: {...}  // If add liquidity attempted
}
```

---

## Examples

### Example 1: SOL-USDC Pool with REWARD Token

**Claimed:**
- 0.1 SOL (fee)
- 50 USDC (fee)
- 100 REWARD tokens

**Process:**
1. Swap 100 REWARD → 0.3 SOL (Jupiter)
2. Balance: 0.4 SOL + 50 USDC
3. Calculate optimal ratio (e.g., 50/50 by USD)
4. Add liquidity: 0.4 SOL + 50 USDC

### Example 2: Out-of-Range Position

**Position Status:**
- Current price: 150 USDC/SOL
- Position range: 100-120 USDC/SOL (below current)
- Position is out of range (only holds token0)

**Process:**
1. Claim rewards
2. Convert all tokens to token0 (SOL)
3. Add liquidity (only token0 will be deposited)

### Example 3: Three Reward Tokens

**Claimed:**
- 0.05 SOL (fee)
- 25 USDC (fee)
- 50 TOKEN_A (reward)
- 30 TOKEN_B (reward)
- 100 TOKEN_C (reward)

**Process:**
1. Swap TOKEN_A → SOL (smaller balance)
2. Swap TOKEN_B → USDC (smaller balance)
3. Swap TOKEN_C → SOL (smaller balance)
4. Balance SOL and USDC to optimal ratio
5. Add liquidity

---

## CLMM Math Explained

### Token Ratio Calculation

For a concentrated liquidity position, the optimal token ratio depends on:
- Current pool price (P)
- Position lower tick (P_lower)
- Position upper tick (P_upper)

**Formula:**
```
token0_value = L × (√P_upper - √P) / (√P_upper × √P)
token1_value = L × (√P - √P_lower)

token0_percent = token0_value × P / (token0_value × P + token1_value)
token1_percent = 1 - token0_percent
```

**Special Cases:**
- **Below range** (P < P_lower): 100% token0, 0% token1
- **Above range** (P > P_upper): 0% token0, 100% token1
- **In range**: Calculated using formula above

---

## Integration with Existing Utils

### Dependencies

The compound utility orchestrates three existing utilities:

```javascript
// 1. Claim rewards
import { claimRewards } from './claim.util.js';

// 2. Swap tokens
import { swapTokens } from './jupiter-swap.util.js';

// 3. Add liquidity
import { addLiquidity } from './add-liquidity.util.js';
```

### Data Flow

```
compoundRewards()
    │
    ├─► claimRewards()
    │       └─► Returns claimed tokens array
    │
    ├─► For each extra token:
    │       └─► swapTokens()
    │               └─► Jupiter API
    │
    ├─► (optional) Balance swap:
    │       └─► swapTokens()
    │
    └─► addLiquidity()
            └─► PancakeSwap increase_liquidity_v2
```

---

## Error Handling

### Phase-Based Error Recovery

Each phase is independent and errors are handled gracefully:

**Phase 1 (Claim):**
- If claim fails → Return error, no swaps attempted

**Phase 2 (Analysis):**
- If pool not found → Return error with claim result

**Phase 3 (Swap Extra):**
- If swap fails → Log warning, continue with remaining tokens
- Result still includes successful swaps

**Phase 4 (Balance):**
- If balance swap fails → Log warning, continue with current amounts
- Not critical, position can still be compounded

**Phase 5 (Add Liquidity):**
- If add fails → Return error with all previous results
- User can manually recover tokens

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "No rewards to compound" | Position has no claimable rewards | Wait for fees to accumulate |
| "Below minimum threshold" | Claimed value < minUsdToCompound | Lower threshold or wait |
| "Failed to claim rewards" | Position invalid or already claimed | Check position status |
| "Failed to add liquidity" | Insufficient balance or slippage | Increase slippage or check balances |
| "Swap failed" | Low liquidity or high slippage | Increase swapSlippageBps |

---

## Performance Considerations

### Transaction Count

**Minimum:** 2 transactions
- 1 claim + 1 add liquidity

**Maximum:** N+2 transactions
- 1 claim + N swaps + 1 add liquidity
- Where N = number of extra tokens + 1 (balance swap)

### Cost Estimation

**Typical costs (mainnet):**
- Claim: ~0.002 SOL
- Swap: ~0.0005 SOL per swap
- Add liquidity: ~0.002 SOL

**Total for 3 extra tokens:**
- 1 claim + 3 swaps + 1 balance + 1 add = ~0.007 SOL

### Optimization Tips

1. **Disable auto-balance** if you want fewer transactions
   ```javascript
   { autoBalance: false }
   ```

2. **Increase minimum threshold** to avoid compounding dust
   ```javascript
   { minUsdToCompound: 10 }
   ```

3. **Batch compound** multiple positions together (future feature)

---

## Testing

### Manual Testing

See `playground/example-compound.js` for complete examples:

```bash
# Set environment variables
export WALLET_PRIVATE_KEY="your_base58_key"
export POSITION_MINT="your_position_mint"

# Run examples
node playground/example-compound.js
```

### Test Scenarios

1. **Basic compound** - Default settings
2. **Custom settings** - High slippage, auto-balance
3. **No balance** - Disable auto-balancing
4. **Below threshold** - Set high minimum
5. **Multiple extra tokens** - Test swap logic

---

## Future Enhancements

### Planned Features

- [ ] **Batch compounding** - Compound multiple positions in one call
- [ ] **Custom swap routes** - Specify preferred DEXes
- [ ] **Gas optimization** - Combine instructions where possible
- [ ] **Price impact protection** - Reject swaps with high impact
- [ ] **Retry logic** - Auto-retry failed swaps
- [ ] **Simulation mode** - Preview compound without execution

### Bot Integration

```javascript
// Periodic auto-compound (coming soon)
async function autoCompound() {
  const positions = await findPositions(connection, wallet);
  
  for (const position of positions) {
    const result = await compoundRewards(
      connection, 
      wallet, 
      position.mint,
      { minUsdToCompound: 5 }
    );
    
    if (result.success) {
      console.log(`Compounded ${position.mint}: $${result.summary.totalUsdCompounded}`);
    }
  }
}

// Run every 24 hours
setInterval(autoCompound, 24 * 60 * 60 * 1000);
```

---

## Troubleshooting

### Issue: "Swap failed" for all swaps

**Possible causes:**
- Low liquidity for token pair
- Slippage too tight
- Token not supported by Jupiter

**Solutions:**
1. Increase `swapSlippageBps`
2. Check token liquidity on DEX
3. Manually swap problem tokens

### Issue: "Not enough balance" during add liquidity

**Possible causes:**
- Swaps consumed more than expected
- Price moved during compound
- Slippage settings mismatched

**Solutions:**
1. Increase `slippageBps` for add liquidity
2. Lower `swapSlippageBps` to preserve more tokens
3. Run compound during low volatility

### Issue: Compound succeeds but low liquidity added

**Possible causes:**
- Position out of range
- High swap fees consumed value
- Price impact on swaps

**Solutions:**
1. Check position range vs current price
2. Use pools with deeper liquidity
3. Compound less frequently to accumulate more rewards

---

## Security Considerations

### Safety Guarantees

✅ **Fund Safety:**
- Never requests additional funds beyond claimed rewards
- All swaps limited to claimed token amounts
- Slippage protection on all operations

✅ **Transaction Safety:**
- Each phase is atomic (succeeds or fails completely)
- Failed swaps don't block remaining operations
- Comprehensive error reporting

⚠️ **User Responsibilities:**
- Set reasonable slippage based on market conditions
- Monitor gas costs vs reward amounts
- Keep sufficient SOL for transaction fees
- Verify position ownership before compounding

### Best Practices

1. **Test with small amounts first**
2. **Use higher slippage during high volatility**
3. **Set appropriate minimum threshold** ($5-10 recommended)
4. **Monitor transaction costs** vs compounded value
5. **Keep extra SOL** for failed transaction retries

---

## Changelog

**v1.0.0** (2025-10-11)
- Initial implementation
- 5-phase compound workflow
- Jupiter swap integration
- Auto-balance feature
- CLMM math calculations
- Comprehensive error handling
- Example playground file
- Complete documentation

---

## Related Files

- **Utility**: `src/utils/compound.util.js`
- **Example**: `playground/example-compound.js`
- **Dependencies**:
  - `src/utils/claim.util.js`
  - `src/utils/jupiter-swap.util.js`
  - `src/utils/add-liquidity.util.js`
  - `src/utils/token.util.js`

---

## Support

For questions or issues:
1. Check this documentation
2. Review example code in `playground/`
3. Test with simulation first
4. Open GitHub issue with:
   - Error message
   - Phase where it failed
   - Position details
   - Configuration used

