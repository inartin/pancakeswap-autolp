# Claim Tracking Analysis & Implementation Plan

## 🔍 Current State Analysis

### How Claims Work Now

**File:** `src/bot/handlers/claim.handler.js`

1. User runs `/claim <nft_mint>` or clicks "Claim" button
2. Handler calls `claimRewards()` utility → executes on-chain transaction
3. Returns result with:
   - `claimed[]` - Array of tokens claimed (symbol, amount, USD value)
   - `totalUsd` - Total USD value of all claimed tokens
   - `transactionFee` - SOL spent on gas
   - `signature` - Transaction signature
4. **Current Recording** (lines 565-577):
   ```javascript
   await recordClaim(dbPosition.id, result.totalUsd);
   await recordClaimFee(dbPosition.id, result.transactionFee);
   ```

### Current Database Storage

#### `position_statistics` table (Aggregates Only):
```sql
total_claimed_usd          REAL    -- Running total, incremented
total_fees_earned_usd      REAL    -- Running total, incremented  
claim_transactions_count   INTEGER -- Counter, incremented
total_claim_fees_sol       REAL    -- Running total of gas fees
last_claim_fee_sol         REAL    -- Most recent gas fee
```

**Functions:**
- `recordClaim(positionId, claimedUsd)` - Updates aggregates
- `recordClaimFee(positionId, feeSol)` - Updates fee aggregates

#### `transactions` table (Currently EMPTY):
```sql
id                INTEGER PRIMARY KEY
wallet_id         INTEGER NOT NULL
position_id       INTEGER (nullable)
tx_signature      TEXT NOT NULL UNIQUE
tx_type           TEXT NOT NULL           -- 'claim', 'compound', 'rebalance', 'close', 'open'
token_amounts     TEXT (JSON)
fee_amount_sol    REAL
status            TEXT DEFAULT 'pending'  -- 'pending', 'success', 'failed'
error_message     TEXT
executed_at       INTEGER (timestamp)
```

**Status:** ❌ NOT BEING USED FOR CLAIMS

---

## 🎯 User Requirements

### What's Needed:

1. ✅ **Store Each Claim Separately**
   - Individual transaction records in database
   - Not just aggregates

2. ✅ **Track Per-Claim Data:**
   - Total USD claimed
   - Timestamp
   - Transaction signature
   - Individual tokens claimed (symbol, amount, USD value)
   - Gas fee (SOL)

3. ✅ **Dual Association:**
   - Link to `wallet_id` (which wallet claimed)
   - Link to `position_id` (which position was claimed from)

4. ✅ **Query Capabilities:**
   - **Wallet-level:** All claims across all positions for a wallet
   - **Position-level:** All claims for a specific position

---

## 📊 Proposed Solution

### Option A: Use Existing `transactions` Table (RECOMMENDED)

**Pros:**
- ✅ Table already exists with all needed fields
- ✅ Already linked to `wallet_id` and `position_id`
- ✅ Has `tx_signature`, `tx_type`, `executed_at`
- ✅ Has `token_amounts` (JSON) for detailed token data
- ✅ Has `fee_amount_sol` for gas tracking
- ✅ Consistent with schema design (also used for rebalance, compound, etc.)

**Changes Needed:**
1. Modify `recordClaim()` to INSERT into `transactions` table
2. Keep `position_statistics` aggregates for fast summary queries
3. Add service function: `getClaimHistory(walletId, positionId?)`

**Database Queries:**
```sql
-- All claims for a wallet
SELECT * FROM transactions 
WHERE wallet_id = ? AND tx_type = 'claim' 
ORDER BY executed_at DESC;

-- All claims for a position
SELECT * FROM transactions 
WHERE position_id = ? AND tx_type = 'claim' 
ORDER BY executed_at DESC;

-- Total claimed by wallet
SELECT SUM(
  CAST(json_extract(token_amounts, '$.total_usd') AS REAL)
) as total 
FROM transactions 
WHERE wallet_id = ? AND tx_type = 'claim';
```

### Option B: Create New `claim_history` Table

**Pros:**
- ✅ Dedicated table for claims only
- ✅ Can add claim-specific fields if needed

**Cons:**
- ❌ Redundant (transactions table exists)
- ❌ More tables to maintain
- ❌ Duplicates data structure

**Not Recommended** - Use transactions table instead.

---

## 🛠️ Implementation Plan

### 1. Update Schema (If Needed)

The `transactions` table already has everything we need!

**Current `token_amounts` field** (TEXT/JSON):
```json
{
  "total_usd": 18.99,
  "tokens": [
    { "symbol": "SOL", "amount": 0.05, "usd_value": 10.00 },
    { "symbol": "USDC", "amount": 8.99, "usd_value": 8.99 }
  ]
}
```

### 2. Create Service Functions

**File:** `src/services/transaction.service.js` (NEW)

```javascript
/**
 * Record a claim transaction
 */
export async function recordClaimTransaction(walletId, positionId, claimResult) {
    const tokenData = {
        total_usd: claimResult.totalUsd,
        tokens: claimResult.claimed.map(token => ({
            symbol: token.symbol,
            amount: token.uiAmount,
            usd_value: token.usdValue,
            type: token.type // 'fee0', 'fee1', 'reward0', etc.
        }))
    };

    await db.insert(transactions).values({
        wallet_id: walletId,
        position_id: positionId,
        tx_signature: claimResult.signature,
        tx_type: 'claim',
        token_amounts: JSON.stringify(tokenData),
        fee_amount_sol: claimResult.transactionFee,
        status: 'success',
        executed_at: new Date()
    });
}

/**
 * Get claim history for wallet
 */
export async function getWalletClaimHistory(walletId) {
    const result = await db.select()
        .from(transactions)
        .leftJoin(positions, eq(transactions.position_id, positions.id))
        .where(and(
            eq(transactions.wallet_id, walletId),
            eq(transactions.tx_type, 'claim'),
            eq(transactions.status, 'success')
        ))
        .orderBy(desc(transactions.executed_at));
    
    return result.map(row => ({
        ...row.transactions,
        position: row.positions,
        token_amounts: JSON.parse(row.transactions.token_amounts)
    }));
}

/**
 * Get claim history for position
 */
export async function getPositionClaimHistory(positionId) {
    const result = await db.select()
        .from(transactions)
        .where(and(
            eq(transactions.position_id, positionId),
            eq(transactions.tx_type, 'claim'),
            eq(transactions.status, 'success')
        ))
        .orderBy(desc(transactions.executed_at));
    
    return result.map(row => ({
        ...row,
        token_amounts: JSON.parse(row.token_amounts)
    }));
}

/**
 * Get total claimed by wallet (all positions)
 */
export async function getWalletTotalClaimed(walletId) {
    const claims = await db.select()
        .from(transactions)
        .where(and(
            eq(transactions.wallet_id, walletId),
            eq(transactions.tx_type, 'claim'),
            eq(transactions.status, 'success')
        ));
    
    return claims.reduce((total, claim) => {
        const data = JSON.parse(claim.token_amounts);
        return total + (data.total_usd || 0);
    }, 0);
}
```

### 3. Update Claim Handler

**File:** `src/bot/handlers/claim.handler.js`

**Change lines 565-577:**

```javascript
// OLD (current):
if (result.totalUsd > 0) {
    void getPositionByNft(positionMintStr).then(async dbPosition => {
        if (dbPosition && dbPosition.id) {
            await recordClaim(dbPosition.id, result.totalUsd);
            if (result.transactionFee > 0) {
                await recordClaimFee(dbPosition.id, result.transactionFee);
            }
        }
    }).catch(err => {
        console.warn(`Failed to record claim in statistics:`, err?.message || err);
    });
}

// NEW (proposed):
if (result.totalUsd > 0) {
    void getPositionByNft(positionMintStr).then(async dbPosition => {
        if (dbPosition && dbPosition.id) {
            // 1. Record individual transaction (NEW)
            await recordClaimTransaction(wallet.id, dbPosition.id, result);
            
            // 2. Update aggregates (existing)
            await recordClaim(dbPosition.id, result.totalUsd);
            if (result.transactionFee > 0) {
                await recordClaimFee(dbPosition.id, result.transactionFee);
            }
        }
    }).catch(err => {
        console.warn(`Failed to record claim:`, err?.message || err);
    });
}
```

### 4. Add Dashboard Query

**File:** `playground/dashboard-server-v2.js`

Add new endpoint:

```javascript
// Get claim history for wallet
app.get('/api/claims/:walletId', async (req, res) => {
    try {
        const walletId = parseInt(req.params.walletId);
        const claims = await getWalletClaimHistory(walletId);
        const total = await getWalletTotalClaimed(walletId);
        
        res.json({
            claims,
            total_claimed_usd: total,
            count: claims.length
        });
    } catch (error) {
        console.error('❌ Error fetching claims:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get claim history for position
app.get('/api/claims/position/:positionId', async (req, res) => {
    try {
        const positionId = parseInt(req.params.positionId);
        const claims = await getPositionClaimHistory(positionId);
        
        res.json({
            claims,
            count: claims.length
        });
    } catch (error) {
        console.error('❌ Error fetching claims:', error);
        res.status(500).json({ error: error.message });
    }
});
```

---

## 📈 Benefits

### For Dashboard:
- ✅ View claim history timeline
- ✅ See individual claim amounts and timestamps
- ✅ Track gas fees per claim
- ✅ Link to Solscan for each transaction
- ✅ Wallet-level claim analytics
- ✅ Position-level claim analytics

### For Statistics:
- ✅ Calculate average claim size
- ✅ Track claim frequency
- ✅ Analyze claim timing patterns
- ✅ Compare claims across positions
- ✅ View historical trends

### Data Integrity:
- ✅ Separate storage = transaction audit trail
- ✅ Keep aggregates for fast queries
- ✅ Can recalculate aggregates from transactions if needed
- ✅ Link to both wallet and position
- ✅ Transaction signature for verification

---

## 🚀 Next Steps

1. ✅ Review this analysis
2. ⏳ Create `src/services/transaction.service.js`
3. ⏳ Update `claim.handler.js` to record transactions
4. ⏳ Add dashboard endpoints for claim history
5. ⏳ Create claim history UI component
6. ⏳ Test with real claim transactions

---

## 📊 Example Queries

### Wallet Claims Summary:
```javascript
const claims = await getWalletClaimHistory(walletId);
const total = await getWalletTotalClaimed(walletId);

console.log(`Total Claimed: $${total.toFixed(2)}`);
console.log(`Claim Count: ${claims.length}`);
claims.forEach(claim => {
    const data = claim.token_amounts;
    console.log(`${new Date(claim.executed_at).toLocaleString()}: $${data.total_usd}`);
});
```

### Position Claims Summary:
```javascript
const claims = await getPositionClaimHistory(positionId);
console.log(`Position has ${claims.length} claims`);
```

---

## ⚠️ Rebalance Cost Note

**Rebalance costs ARE being tracked!**

**Source:** `src/services/position-statistics.service.js:224`

```javascript
export async function recordRebalance(positionId, costUsd) {
    await db.update(position_statistics)
        .set({
            last_rebalance_at: new Date(),
            rebalances_count_lifetime: sql`${position_statistics.rebalances_count_lifetime} + 1`,
            last_rebalance_cost_usd: costUsd,
            total_rebalance_cost_usd: sql`${position_statistics.total_rebalance_cost_usd} + ${costUsd}`,
            updated_at: new Date()
        });
}
```

**Called from:** `src/bot/handlers/rebalance.handler.js`

**How cost is calculated:**
- Position value before rebalance
- Position value after rebalance
- Difference = rebalance cost (slippage, fees, etc.)

**Your data shows:**
- Position 615: 13 rebalances, $31.74 total cost ($2.44 avg)
- Position 616: 12 rebalances, $41.54 total cost ($3.46 avg)
- Position 617: 7 rebalances, $12.08 total cost ($1.73 avg)

