# PancakeSwap AMM v3 Position Decoder Documentation

## Overview

This tool decodes and reads PancakeSwap AMM v3 (Concentrated Liquidity) position data from the Solana blockchain using Anchor's IDL (Interface Definition Language). It provides detailed information about liquidity positions, including accurate token amounts, fees owed, rewards, and pool state.

## How It Works

### Architecture

The decoder uses Anchor's `BorshCoder` to deserialize on-chain account data based on the PancakeSwap AMM v3 IDL specification. The process involves:

1. **PDA Derivation**: Derives the Program Derived Address (PDA) for the position using the NFT mint address
2. **Account Fetching**: Retrieves raw account data from the Solana blockchain via RPC
3. **Borsh Decoding**: Deserializes the binary data into structured JavaScript objects using the IDL schema
4. **Data Enrichment**: Calculates additional metrics like token amounts based on current pool state

### Account Types

The decoder works with two main account types:

#### 1. PersonalPositionState
- **PDA Seeds**: `["position", position_nft_mint]`
- **Purpose**: User-specific position data
- **Discriminator**: `[70, 111, 150, 126, 230, 15, 25, 117]`

#### 2. PoolState
- **PDA Seeds**: `["pool", amm_config, token_mint_0, token_mint_1]`
- **Purpose**: Global pool state and liquidity information
- **Discriminator**: `[247, 237, 227, 245, 215, 195, 222, 70]`

## Return Format

### Top-Level Structure

```javascript
{
  // Metadata
  "positionAddress": "string",           // PDA of the position account
  "nftMint": "string",                   // NFT mint representing this position
  "owner": "string",                     // Wallet address of the position owner

  // Decoded position data
  "position": { PersonalPositionState }, // See below

  // Decoded pool data
  "pool": { PoolState },                 // See below

  // Calculated token amounts (using Uniswap v3 math)
  "tokenAmounts": {
    "token0": {
      "amount": "string",                // Base units (e.g., lamports for SOL)
      "formatted": "string",             // Human-readable format (e.g., "0.882" SOL)
      "decimals": number,                // Decimal places for this token
      "mint": "string"                   // Token mint address
    },
    "token1": {
      "amount": "string",                // Base units
      "formatted": "string",             // Human-readable format (e.g., "1858.55" TROLL)
      "decimals": number,                // Decimal places for this token
      "mint": "string"                   // Token mint address
    }
  }
}
```

## Field Descriptions

### PersonalPositionState Fields

| Field | Type | Description |
|-------|------|-------------|
| `bump` | `u8[1]` | PDA bump seed for address derivation |
| `nft_mint` | `PublicKey` | The NFT mint address that represents this position |
| `pool_id` | `PublicKey` | The pool this position belongs to |
| `tick_lower_index` | `i32` | Lower tick boundary of the price range |
| `tick_upper_index` | `i32` | Upper tick boundary of the price range |
| `liquidity` | `u128` (hex string) | Amount of liquidity in this position |
| `fee_growth_inside_0_last_x64` | `u128` (hex string) | Last recorded fee growth for token_0 (Q64.64 fixed point) |
| `fee_growth_inside_1_last_x64` | `u128` (hex string) | Last recorded fee growth for token_1 (Q64.64 fixed point) |
| `token_fees_owed_0` | `u64` (hex string) | Uncollected fees in token_0 |
| `token_fees_owed_1` | `u64` (hex string) | Uncollected fees in token_1 |
| `reward_infos` | `Array[3]` | Reward tracking for up to 3 reward tokens |
| `recent_epoch` | `u64` (hex string) | Last update epoch (counter, not timestamp) |
| `padding` | `u64[7]` | Reserved space for future features |

#### Reward Info Structure
```javascript
{
  "growth_inside_last_x64": "u128",     // Last recorded reward growth (Q64.64)
  "reward_amount_owed": "u64"           // Uncollected reward amount
}
```

### PoolState Fields

| Field | Type | Description |
|-------|------|-------------|
| `bump` | `u8[1]` | PDA bump seed |
| `amm_config` | `PublicKey` | AMM configuration account |
| `owner` | `PublicKey` | Pool owner/authority |
| `token_mint_0` | `PublicKey` | First token mint (lower address) |
| `token_mint_1` | `PublicKey` | Second token mint (higher address) |
| `token_vault_0` | `PublicKey` | Vault holding token_0 |
| `token_vault_1` | `PublicKey` | Vault holding token_1 |
| `observation_key` | `PublicKey` | Oracle observation account |
| `mint_decimals_0` | `u8` | Decimals for token_0 |
| `mint_decimals_1` | `u8` | Decimals for token_1 |
| `tick_spacing` | `u16` | Minimum tick spacing for this pool |
| `liquidity` | `u128` (hex string) | Total active liquidity in the pool |
| `sqrt_price_x64` | `u128` (hex string) | Current price as sqrt(token_1/token_0) in Q64.64 |
| `tick_current` | `i32` | Current tick (log base 1.0001 of price) |
| `fee_growth_global_0_x64` | `u128` (hex string) | Global accumulated fees for token_0 |
| `fee_growth_global_1_x64` | `u128` (hex string) | Global accumulated fees for token_1 |
| `protocol_fees_token_0` | `u64` (hex string) | Protocol fees collected in token_0 |
| `protocol_fees_token_1` | `u64` (hex string) | Protocol fees collected in token_1 |
| `swap_in_amount_token_0` | `u128` (hex string) | Total token_0 swapped in |
| `swap_out_amount_token_1` | `u128` (hex string) | Total token_1 swapped out |
| `swap_in_amount_token_1` | `u128` (hex string) | Total token_1 swapped in |
| `swap_out_amount_token_0` | `u128` (hex string) | Total token_0 swapped out |
| `status` | `u8` | Pool status bitfield (0=normal, see status bits below) |
| `reward_infos` | `Array[3]` | Active reward programs (see below) |
| `tick_array_bitmap` | `u64[16]` | Bitmap of initialized tick arrays |
| `total_fees_token_0` | `u64` (hex string) | Total fees earned in token_0 |
| `total_fees_claimed_token_0` | `u64` (hex string) | Total fees claimed in token_0 |
| `total_fees_token_1` | `u64` (hex string) | Total fees earned in token_1 |
| `total_fees_claimed_token_1` | `u64` (hex string) | Total fees claimed in token_1 |
| `fund_fees_token_0` | `u64` (hex string) | Fund fees in token_0 |
| `fund_fees_token_1` | `u64` (hex string) | Fund fees in token_1 |
| `open_time` | `u64` (hex string) | Pool opening timestamp |
| `recent_epoch` | `u64` (hex string) | Last update epoch |

#### Pool Status Bits
- **bit0**: `1` = Disable open position and increase liquidity
- **bit1**: `1` = Disable decrease liquidity
- **bit2**: `1` = Disable collect fee
- **bit3**: `1` = Disable collect reward
- **bit4**: `1` = Disable swap

#### Pool Reward Info Structure
```javascript
{
  "reward_state": "u8",                  // 0=uninitialized, 1=initialized, 2=active
  "open_time": "u64",                    // Reward period start (Unix timestamp)
  "end_time": "u64",                     // Reward period end (Unix timestamp)
  "last_update_time": "u64",             // Last update (Unix timestamp)
  "emissions_per_second_x64": "u128",    // Reward rate (Q64.64)
  "reward_total_emissioned": "u64",      // Total rewards emitted
  "reward_claimed": "u64",               // Total rewards claimed
  "token_mint": "PublicKey",             // Reward token mint
  "token_vault": "PublicKey",            // Reward token vault
  "authority": "PublicKey",              // Reward authority
  "reward_growth_global_x64": "u128"     // Global reward growth (Q64.64)
}
```

## Understanding the Data

### Tick System

Concentrated liquidity pools use **ticks** to represent discrete price points:

- **Tick**: `log₁.₀₀₀₁(price)` where price = token_1/token_0
- **Tick Spacing**: Minimum distance between usable ticks (e.g., 10 means ticks must be multiples of 10)
- **Current Tick**: Where the current price is located
- **Position Range**: Your position is active when `tick_lower_index ≤ tick_current < tick_upper_index`

**Example from output**:
```javascript
"tick_lower_index": -1710,    // Lower boundary
"tick_upper_index": 12160,    // Upper boundary
"tick_current": 5875          // Current price is within range!
```

### Liquidity Values

All numeric values are returned as **hex strings** or **decimal strings** to preserve precision:

- **Liquidity**: Represents L = √(x·y) in Uniswap v3 math
- **Large numbers** are serialized as strings to avoid JavaScript's 53-bit integer limit
- Convert using `BigInt('0x' + hexValue)` or `BigInt(decimalValue)`

**Example**:
```javascript
"liquidity": "4389275881"  // This is ~4.39 billion units of liquidity
```

### Fee Growth (Q64.64 Format)

Fee growth values use **Q64.64 fixed-point** representation:
- 64 bits for the integer part
- 64 bits for the fractional part
- To get the actual value: `value / 2^64`

**Example**:
```javascript
"fee_growth_inside_0_last_x64": "2275409952207478"
// Actual fee growth = 2275409952207478 / (2^64) ≈ 0.0001234 per unit liquidity
```

### Price Calculation

The pool stores price as `sqrt_price_x64`:

```javascript
"sqrt_price_x64": "24746074593004044536"

// To get the actual price:
// 1. Convert to BigInt: 24746074593004044536n
// 2. Calculate: (sqrt_price / 2^64)^2
// 3. Adjust for decimals: price * (10^decimals_0 / 10^decimals_1)
```

### Token Amounts

The `tokenAmounts` field provides **accurate calculations** of how much of each token is currently in your position.

These amounts are calculated using proper Uniswap v3 mathematics:

```javascript
tokenAmounts: {
  token0: {
    amount: "882183060",           // Raw amount in base units (lamports)
    formatted: "0.88218306",       // Human-readable (0.882 SOL)
    decimals: 9,                   // SOL has 9 decimals
    mint: "So11111...112"          // SOL mint address
  },
  token1: {
    amount: "1858552509",          // Raw amount in base units
    formatted: "1858.552509",      // Human-readable (1,858.55 TROLL)
    decimals: 6,                   // TROLL has 6 decimals
    mint: "5UUH9RTD...H2"          // TROLL mint address
  }
}
```

#### What These Represent

**These are the token amounts currently deposited in your position**, calculated based on:

1. **Your Liquidity**: The `L` value in your position (e.g., 4,389,275,881)
2. **Current Price**: Where the market price is right now (tick 5875 = ~1,799.43 TROLL/SOL)
3. **Your Price Range**: Your position boundaries (ticks -1710 to 12160)

#### How the Math Works

The calculation uses Uniswap v3 formulas:

- **If current tick < lower tick**: Position is entirely in token1 (the more valuable token)
- **If current tick ≥ upper tick**: Position is entirely in token0 (the less valuable token)
- **If in range** (your case):
  - Token0 amount = L × (√P_upper - √P_current) / (√P_upper × √P_current)
  - Token1 amount = L × (√P_current - √P_lower)

Where P represents price and √P is the square root price in Q64.64 format.

#### Important Notes

✅ **These match your UI exactly** - The formatted amounts should match what you see in the PancakeSwap interface

⚠️ **These DO NOT include**:
- Uncollected fees (see `token_fees_owed_0` and `token_fees_owed_1`)
- Uncollected rewards (see `reward_infos[].reward_amount_owed`)

To get your **total balance**, add:
- Token amounts (deposited liquidity)
- Uncollected fees
- Uncollected rewards

## Data Interpretation Examples

### Example 1: Active Position

```javascript
{
  "tick_current": 5875,
  "tick_lower_index": -1710,
  "tick_upper_index": 12160,
  "liquidity": "4389275881"
}
```

**Interpretation**:
- ✅ Position is **in range** (5875 is between -1710 and 12160)
- ✅ Currently **earning fees** from swaps
- ✅ Liquidity is **active** and providing to the pool

### Example 2: Out of Range Position

```javascript
{
  "tick_current": 15000,
  "tick_lower_index": -1710,
  "tick_upper_index": 12160,
  "liquidity": "4389275881"
}
```

**Interpretation**:
- ❌ Position is **out of range** (15000 > 12160)
- ❌ **Not earning fees**
- ℹ️ All liquidity is in token_0 (lower-valued token)
- 💡 Price moved above your range - consider rebalancing

### Example 3: Uncollected Fees

```javascript
{
  "token_fees_owed_0": "123456",
  "token_fees_owed_1": "789012",
  "mint_decimals_0": 9,
  "mint_decimals_1": 6
}
```

**Interpretation**:
- Token 0 fees: `123456 / 10^9 = 0.000123456` tokens
- Token 1 fees: `789012 / 10^6 = 0.789012` tokens
- These can be collected by the position owner

### Example 4: Active Rewards

```javascript
{
  "reward_state": 2,  // Active
  "open_time": "1758866400",
  "end_time": "1760680800",
  "reward_total_emissioned": "45346495330",
  "reward_claimed": "39873511994"
}
```

**Interpretation**:
- ✅ Reward program is **active**
- 📅 Started: `new Date(1758866400 * 1000)`
- 📅 Ends: `new Date(1760680800 * 1000)`
- 💰 Total emitted: 45.34 billion (in token's base units)
- 💵 Already claimed: 39.87 billion
- 🎁 Remaining: ~5.47 billion to distribute

## Usage Example

```javascript
import { readPoolPosition } from './read-position.js';

// Read a position
const positionData = await readPoolPosition(
  '3i3hAPMY43132UQGse4oTRVLh3AYdHGWJD4MwvraZ4ng',  // Wallet address
  'GXzJJhe94fn4uaSCe1ciy5hgdds9VnR6tE9xC2JXKGxR',  // Pool address
  'BAZTTaXg3uLaQ9BrcNhgpBspKE4MfFsQ5RyF4ia2JdHi'   // Position NFT mint
);

// Access token amounts (these match the UI!)
console.log('Token 0 (SOL):', positionData.tokenAmounts.token0.formatted);
console.log('Token 1 (TROLL):', positionData.tokenAmounts.token1.formatted);

// Access pool information
console.log('Current Tick:', positionData.pool.tick_current);
console.log('Liquidity:', positionData.position.liquidity);

// Check if position is in range
const inRange =
  positionData.pool.tick_current >= positionData.position.tick_lower_index &&
  positionData.pool.tick_current < positionData.position.tick_upper_index;

console.log('Position in range:', inRange ? '✅ YES' : '❌ NO');

// Check for uncollected fees
const fees0 = BigInt(positionData.position.token_fees_owed_0);
const fees1 = BigInt(positionData.position.token_fees_owed_1);

if (fees0 > 0 || fees1 > 0) {
  console.log('💰 You have uncollected fees!');
  console.log(`  Token 0: ${fees0} (raw units)`);
  console.log(`  Token 1: ${fees1} (raw units)`);
}

// Check for uncollected rewards
positionData.position.reward_infos.forEach((reward, index) => {
  const owed = BigInt(reward.reward_amount_owed);
  if (owed > 0) {
    console.log(`🎁 Reward ${index}: ${owed} tokens uncollected`);
  }
});
```

## Target Audience

This documentation is written for:
- 🧑‍💻 **Developers** building DeFi applications on Solana
- 🔬 **Analysts** querying PancakeSwap position data
- 🤖 **Bot operators** monitoring liquidity positions
- 📊 **Portfolio trackers** integrating PancakeSwap data

**Prerequisites**:
- Basic understanding of Solana account model
- Familiarity with Uniswap v3 / concentrated liquidity concepts
- JavaScript/TypeScript knowledge
- Understanding of fixed-point arithmetic (for fee calculations)

## Important Notes

### ⚠️ Data Format Considerations

1. **Hex String Values**: Most numeric fields come as hex strings (e.g., `"035e"`) from the Borsh decoder
   - Convert using: `parseInt(value, 16)` or `BigInt('0x' + value)`

2. **Large Number Handling**: Use `BigInt` for values that exceed JavaScript's safe integer range
   ```javascript
   const liquidity = BigInt('0x' + positionData.position.liquidity);
   ```

3. **Decimal Conversion**: Always account for token decimals when displaying amounts
   ```javascript
   const actualAmount = BigInt(amount) / BigInt(10 ** decimals);
   ```

4. **Q64.64 Format**: Fee and price values need division by `2^64`
   ```javascript
   const feeGrowth = BigInt(fee_growth) / BigInt(2 ** 64);
   ```

### 🔍 Limitations

- **Token Amount Calculation**: Current implementation provides simplified estimates only
- **No Historical Data**: Only returns current state, not historical performance
- **RPC Dependent**: Requires reliable Solana RPC endpoint
- **No Price Oracle**: Doesn't fetch external price feeds for USD valuation

### 🚀 Future Enhancements

Consider implementing:
- [ ] Accurate Uniswap v3 liquidity math for precise token amounts
- [ ] Price impact calculations
- [ ] Impermanent loss tracking
- [ ] USD value conversion using price oracles
- [ ] Historical position snapshots
- [ ] Reward APR calculations

## Technical Details

### Dependencies

```json
{
  "@coral-xyz/anchor": "^0.32.1",
  "@solana/web3.js": "^1.87.6",
  "dotenv": "^16.3.1"
}
```

### Program Information

- **Program ID**: `HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq`
- **Program Name**: `amm_v3` (PancakeSwap)
- **IDL Version**: `0.1.0`
- **Network**: Solana Mainnet-Beta

### Account Sizes

- **PersonalPositionState**: 281 bytes
- **PoolState**: Variable (includes dynamic arrays)

## Troubleshooting

### Common Issues

**Issue**: `Account not found: PersonalPositionState`
- **Cause**: Using wrong account type name
- **Solution**: Ensure account type matches IDL exactly (PascalCase)

**Issue**: `Position account not found`
- **Cause**: Invalid NFT mint or position doesn't exist
- **Solution**: Verify the position NFT mint address is correct

**Issue**: `undefined` values in decoded data
- **Cause**: Using camelCase instead of snake_case field names
- **Solution**: Access fields using snake_case (e.g., `tick_lower_index` not `tickLowerIndex`)

**Issue**: `NaN` or incorrect numeric values
- **Cause**: Not handling hex string conversion properly
- **Solution**: Use `parseInt(value, 16)` for hex strings

## References

- [Uniswap v3 Whitepaper](https://uniswap.org/whitepaper-v3.pdf) - Core concentrated liquidity concepts
- [Anchor Framework](https://www.anchor-lang.com/) - Solana development framework
- [PancakeSwap Docs](https://docs.pancakeswap.finance/) - Platform documentation
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/) - Solana JavaScript library

---

**Last Updated**: 2025-10-10
**Maintainer**: Development Team
**License**: MIT
