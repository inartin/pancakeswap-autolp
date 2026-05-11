# Helius SWQOS Integration Guide
### Reliable, Cost-Effective On-Chain Transaction Delivery for Solana

> **TL;DR**: Helius SWQOS provides 95-99% transaction success rates at 99.5% lower cost than Jito by routing through stake-weighted validators. Perfect for non-MEV transactions like DeFi operations, NFT minting, and token transfers.

---

## Table of Contents

1. [What is SWQOS?](#what-is-swqos)
2. [When to Use SWQOS](#when-to-use-swqos)
3. [Quick Start](#quick-start)
4. [Implementation Guide](#implementation-guide)
5. [Critical: Proper Retry Logic](#critical-proper-retry-logic)
6. [Production Best Practices](#production-best-practices)
7. [Troubleshooting](#troubleshooting)

---

## What is SWQOS?

**SWQOS (Staked Weighted Quality of Service)** is a Helius transaction routing service that delivers your Solana transactions through stake-weighted validators for reliable, cost-effective on-chain execution.

### How It Works

```
Your App → Build Transaction → Add Priority Fee → Add SWQOS Tip (0.000005 SOL)
         ↓
    Sign Transaction
         ↓
    Helius Sender API (SWQOS-only mode)
         ↓
    Stake-Weighted Validators
         ↓
    Transaction Confirmed (<1s)
```

### Performance Comparison

| Method | Success Rate | Cost per TX | Confirmation | Best For |
|--------|-------------|-------------|--------------|----------|
| Standard RPC | 40-70% | ~$0.0001 | 2-5s | Testing only |
| **SWQOS** | **95-99%** | **~$0.0005** | **<1s** | **Most production use** |
| Full Jito | 99-100% | ~$0.10 | <1s | MEV-sensitive transactions |

**When to use each:**
- **Standard RPC**: Development/testing
- **SWQOS**: Production (99% of use cases) ✅
- **Jito**: High-value swaps, arbitrage, liquidations

---

## When to Use SWQOS

### ✅ Perfect For (Non-MEV Transactions)

- DeFi operations (deposits, withdrawals, claims)
- NFT minting and transfers
- Token transfers
- Staking operations
- DAO voting
- Social/gaming transactions
- Any operation where speed > MEV protection

### ❌ Not Ideal For (MEV-Sensitive Transactions)

- Large swaps (>$10k)
- Arbitrage opportunities
- Liquidations
- Time-sensitive price execution
- Frontrun-vulnerable operations

**For MEV-sensitive transactions**, use Full Jito mode instead (same implementation, different endpoint).

---

## Quick Start

### Prerequisites

```bash
npm install @solana/web3.js bs58
```

**Environment Variables:**
```bash
# Your Helius RPC endpoint (with API key)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Network
SOLANA_NETWORK=mainnet-beta
```

### Minimal Working Example

```typescript
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";

// Configuration
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL!;
const SENDER_ENDPOINT = "https://sender.helius-rpc.com/fast?swqos_only=true";
const SWQOS_TIP_LAMPORTS = 5_000; // 0.000005 SOL
const COMPUTE_UNIT_LIMIT = 400_000;

// Random tip account selection for load distribution
const TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

const connection = new Connection(RPC_ENDPOINT, "confirmed");

// Send transaction with SWQOS
async function sendTransactionSWQOS(
  transaction: Transaction,
  wallet: Keypair
): Promise<string> {
  // 1. Get recommended priority fee from Helius
  const priorityFee = await getRecommendedPriorityFee(transaction);

  // 2. Add compute budget instructions (must be first)
  transaction.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({
      units: COMPUTE_UNIT_LIMIT,
    })
  );

  // 3. Add SWQOS tip (must be last)
  const randomTipAccount =
    TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(randomTipAccount),
      lamports: SWQOS_TIP_LAMPORTS,
    })
  );

  // 4. Get fresh blockhash
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = wallet.publicKey;

  // 5. Sign transaction
  transaction.sign(wallet);

  // 6. Send via Helius Sender (SWQOS-only)
  const response = await fetch(SENDER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "sendTransaction",
      params: [
        Buffer.from(transaction.serialize()).toString("base64"),
        {
          encoding: "base64",
          skipPreflight: true, // Required for Sender API
          maxRetries: 0, // We handle retries externally
        },
      ],
    }),
  });

  const result = await response.json();

  if (result.error) {
    throw new Error(`Helius Sender error: ${result.error.message}`);
  }

  const signature = result.result;

  // 7. Confirm transaction
  await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    "confirmed"
  );

  return signature;
}

// Get Helius recommended priority fee
async function getRecommendedPriorityFee(
  transaction: Transaction
): Promise<number> {
  const serializedTx = bs58.encode(
    transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })
  );

  const response = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "priority-fee",
      method: "getPriorityFeeEstimate",
      params: [
        {
          transaction: serializedTx,
          options: {
            recommended: true, // Helius optimized for staked connections
          },
        },
      ],
    }),
  });

  const result = await response.json();
  const baseFee = result.result?.priorityFeeEstimate || 50_000;

  // Add 10% buffer for safety
  return Math.ceil(baseFee * 1.1);
}

// Example usage
async function example() {
  const wallet = Keypair.generate();

  // Build your transaction (example: simple transfer)
  const transaction = new Transaction();
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: LAMPORTS_PER_SOL * 0.001,
    })
  );

  // Send with SWQOS
  const signature = await sendTransactionSWQOS(transaction, wallet);
  console.log("Transaction confirmed:", signature);
}
```

---

## Implementation Guide

### Step 1: Configuration

Create a configuration file for your transaction settings:

```typescript
// config/transaction.ts
export const TRANSACTION_CONFIG = {
  // Helius Sender endpoint (SWQOS-only mode)
  SENDER_ENDPOINT: "https://sender.helius-rpc.com/fast?swqos_only=true",

  // SWQOS tip amount (minimum: 5,000 lamports)
  SWQOS_TIP_LAMPORTS: 5_000,

  // Compute unit limit (adjust based on your transaction complexity)
  COMPUTE_UNIT_LIMIT: 400_000,

  // Maximum retry attempts
  MAX_RETRIES: 3,

  // Commitment level
  COMMITMENT: "confirmed" as const,

  // Tip accounts for load distribution
  TIP_ACCOUNTS: [
    "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
    "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
    "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
    "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
    "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
    "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
    "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
    "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
    "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
    "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
  ],
} as const;
```

### Step 2: Helper Functions

Create reusable helper functions for transaction operations:

```typescript
// lib/transaction-helpers.ts
import { Transaction, PublicKey, SystemProgram } from "@solana/web3.js";
import { TRANSACTION_CONFIG } from "@/config/transaction";

/**
 * Add SWQOS tip to transaction
 *
 * @param transaction - Transaction to add tip to
 * @param fromPubkey - Wallet public key (payer)
 */
export function addSWQOSTip(
  transaction: Transaction,
  fromPubkey: PublicKey
): void {
  // Randomly select tip account for load distribution
  const randomIndex = Math.floor(
    Math.random() * TRANSACTION_CONFIG.TIP_ACCOUNTS.length
  );
  const tipAccount = TRANSACTION_CONFIG.TIP_ACCOUNTS[randomIndex];

  // Add tip transfer as last instruction
  transaction.add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: new PublicKey(tipAccount),
      lamports: TRANSACTION_CONFIG.SWQOS_TIP_LAMPORTS,
    })
  );
}

/**
 * Remove compute budget instructions from transaction
 *
 * Useful when using SDKs that add their own compute budget.
 * Call this before adding your own priority fees.
 */
export function removeComputeBudgetInstructions(
  transaction: Transaction
): void {
  const computeBudgetProgramId =
    "ComputeBudget111111111111111111111111111111";

  const indices: number[] = [];

  transaction.instructions.forEach((ix, i) => {
    if (ix.programId.toString() === computeBudgetProgramId) {
      indices.push(i);
    }
  });

  // Remove in reverse order to maintain indices
  for (let i = indices.length - 1; i >= 0; i--) {
    transaction.instructions.splice(indices[i], 1);
  }
}

/**
 * Check if error is retriable
 */
export function isRetriableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Don't retry these errors
  return !(
    message.includes("insufficient") ||
    message.includes("invalid") ||
    message.includes("already processed") ||
    message.includes("signature verification failed")
  );
}
```

### Step 3: Core Transaction Sender

Create the main transaction sending function:

```typescript
// lib/send-transaction.ts
import {
  Connection,
  Transaction,
  Keypair,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import { TRANSACTION_CONFIG } from "@/config/transaction";
import { addSWQOSTip } from "./transaction-helpers";

/**
 * Send and confirm transaction via Helius SWQOS
 *
 * @param transaction - UNSIGNED transaction with instructions
 * @param wallet - Wallet keypair for signing
 * @param connection - Solana connection
 * @returns Transaction signature
 */
export async function sendAndConfirmTransactionSWQOS(
  transaction: Transaction,
  wallet: Keypair,
  connection: Connection
): Promise<string> {
  // 1. Get recommended priority fee
  const priorityFee = await getRecommendedPriorityFee(transaction, connection);

  // 2. Add compute budget instructions (must be first)
  transaction.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({
      units: TRANSACTION_CONFIG.COMPUTE_UNIT_LIMIT,
    })
  );

  // 3. Add SWQOS tip (must be last)
  addSWQOSTip(transaction, wallet.publicKey);

  // 4. Get fresh blockhash RIGHT BEFORE signing
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(TRANSACTION_CONFIG.COMMITMENT);

  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = wallet.publicKey;

  // 5. Sign immediately
  transaction.sign(wallet);

  // 6. Send via Helius Sender
  const response = await fetch(TRANSACTION_CONFIG.SENDER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "sendTransaction",
      params: [
        Buffer.from(transaction.serialize()).toString("base64"),
        {
          encoding: "base64",
          skipPreflight: true, // Required for Sender API
          maxRetries: 0, // We handle retries externally
        },
      ],
    }),
  });

  const result = await response.json();

  if (result.error) {
    throw new Error(`Helius Sender error: ${result.error.message}`);
  }

  const signature = result.result;

  // 7. Confirm transaction
  await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    TRANSACTION_CONFIG.COMMITMENT
  );

  return signature;
}

/**
 * Get Helius recommended priority fee
 */
async function getRecommendedPriorityFee(
  transaction: Transaction,
  connection: Connection
): Promise<number> {
  const serializedTx = bs58.encode(
    transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })
  );

  // @ts-ignore - Helius-specific RPC method
  const response = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "priority-fee",
      method: "getPriorityFeeEstimate",
      params: [
        {
          transaction: serializedTx,
          options: {
            recommended: true,
          },
        },
      ],
    }),
  });

  const result = await response.json();
  const baseFee = result.result?.priorityFeeEstimate || 50_000;

  // Add 10% buffer for safety
  return Math.ceil(baseFee * 1.1);
}
```

### Step 4: Retry Wrapper

Add retry logic for production reliability:

```typescript
// lib/retry-transaction.ts
import { Transaction, Keypair, Connection } from "@solana/web3.js";
import { TRANSACTION_CONFIG } from "@/config/transaction";
import { sendAndConfirmTransactionSWQOS } from "./send-transaction";
import { isRetriableError } from "./transaction-helpers";

/**
 * Send transaction with retry logic
 *
 * @param buildTransaction - Function that builds a fresh transaction
 * @param wallet - Wallet keypair
 * @param connection - Solana connection
 * @returns Transaction signature
 */
export async function sendTransactionWithRetry(
  buildTransaction: () => Promise<Transaction>,
  wallet: Keypair,
  connection: Connection
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= TRANSACTION_CONFIG.MAX_RETRIES; attempt++) {
    try {
      // Build fresh transaction on each retry
      const transaction = await buildTransaction();

      // Send with SWQOS
      const signature = await sendAndConfirmTransactionSWQOS(
        transaction,
        wallet,
        connection
      );

      console.log(`Transaction confirmed on attempt ${attempt}:`, signature);
      return signature;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      console.error(
        `Transaction attempt ${attempt}/${TRANSACTION_CONFIG.MAX_RETRIES} failed:`,
        lastError.message
      );

      // Check if retriable
      if (!isRetriableError(lastError) || attempt === TRANSACTION_CONFIG.MAX_RETRIES) {
        throw lastError;
      }

      // Exponential backoff: 1s, 2s, 4s
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.log(`Retrying in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError || new Error("Transaction failed after all retries");
}
```

---

## Critical: Proper Retry Logic

### ❌ Wrong: Reusing Signed Transaction

```typescript
// DON'T DO THIS
async function sendTransactionBad(tx: Transaction, wallet: Keypair) {
  // Sign ONCE
  tx.sign(wallet);

  // Try to send multiple times
  for (let i = 0; i < 3; i++) {
    try {
      await connection.sendRawTransaction(tx.serialize());
      break;
    } catch (error) {
      // ❌ Blockhash is baked into signature!
      // ❌ Blockhash expires after ~60 seconds
      // ❌ Retrying with expired blockhash = guaranteed failure
    }
  }
}
```

**Why this fails:**
1. Blockhash is part of the transaction signature
2. Once signed, blockhash cannot be changed
3. Blockhash expires after 60-90 seconds
4. All retries fail with "Blockhash not found"

### ✅ Correct: Rebuild Everything

```typescript
// DO THIS
async function sendTransactionGood(
  buildTx: () => Promise<Transaction>,
  wallet: Keypair
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 1. Build fresh transaction
      const tx = await buildTx();

      // 2. Add priority fee + SWQOS tip
      await addPriorityFeeAndTip(tx, wallet.publicKey);

      // 3. Get fresh blockhash
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      // 4. Sign with fresh blockhash
      tx.sign(wallet);

      // 5. Send immediately
      const sig = await sendViaHeliusSender(tx);
      return sig; // Success!
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}
```

**Key principles:**
- ✅ Build fresh transaction on each retry
- ✅ Get fresh blockhash before signing
- ✅ Sign immediately after setting blockhash
- ✅ Send immediately after signing
- ✅ Exponential backoff between retries

---

## Production Best Practices

### 1. Transaction Building Pattern

Always separate transaction building from sending:

```typescript
// Good: Separate concerns
async function claimRewards(poolAddress: string, wallet: Keypair) {
  // Builder function - can be called multiple times
  const buildTx = async () => {
    const pool = await getPool(poolAddress); // Fresh state
    const tx = await pool.claimRewards(wallet.publicKey);
    return tx;
  };

  // Send with retry (rebuilds on each attempt)
  return await sendTransactionWithRetry(buildTx, wallet, connection);
}

// Bad: Building and sending coupled
async function claimRewardsBad(poolAddress: string, wallet: Keypair) {
  const pool = await getPool(poolAddress); // Stale state on retry
  const tx = await pool.claimRewards(wallet.publicKey);

  for (let i = 0; i < 3; i++) {
    try {
      return await sendTransaction(tx, wallet); // ❌ Reusing stale transaction
    } catch (error) {
      // Can't rebuild - state may have changed
    }
  }
}
```

### 2. Multi-Transaction Operations

For operations requiring multiple sequential transactions:

```typescript
async function compoundRewards(poolAddress: string, wallet: Keypair) {
  // Transaction 1: Claim rewards
  const claimBuilder = async () => {
    const pool = await getPool(poolAddress);
    return await pool.claimRewards(wallet.publicKey);
  };

  const claimSig = await sendTransactionWithRetry(
    claimBuilder,
    wallet,
    connection
  );
  console.log("Rewards claimed:", claimSig);

  // Wait for claim to settle (optional)
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Transaction 2: Reinvest rewards (uses fresh state)
  const reinvestBuilder = async () => {
    const pool = await getPool(poolAddress); // Fresh pool state
    return await pool.reinvestRewards(wallet.publicKey);
  };

  const reinvestSig = await sendTransactionWithRetry(
    reinvestBuilder,
    wallet,
    connection
  );
  console.log("Rewards reinvested:", reinvestSig);

  return { claimSig, reinvestSig };
}
```

### 3. Error Handling

Implement comprehensive error handling:

```typescript
async function sendTransactionSafe(
  buildTx: () => Promise<Transaction>,
  wallet: Keypair
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const signature = await sendTransactionWithRetry(
      buildTx,
      wallet,
      connection
    );

    return { success: true, signature };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Provide user-friendly error messages
    if (message.includes("insufficient")) {
      return {
        success: false,
        error: "Insufficient SOL balance for transaction",
      };
    }

    if (message.includes("blockhash not found")) {
      return {
        success: false,
        error: "Transaction expired. Please try again.",
      };
    }

    return {
      success: false,
      error: `Transaction failed: ${message}`,
    };
  }
}
```

### 4. Monitoring and Logging

Add detailed logging for production debugging:

```typescript
async function sendWithLogging(
  buildTx: () => Promise<Transaction>,
  wallet: Keypair,
  operationName: string
) {
  console.log(`[${operationName}] Starting transaction...`);
  const startTime = Date.now();

  try {
    const signature = await sendTransactionWithRetry(buildTx, wallet, connection);

    const duration = Date.now() - startTime;
    console.log(
      `[${operationName}] Success! Signature: ${signature} (${duration}ms)`
    );

    // Log to monitoring service
    logMetric({
      operation: operationName,
      status: "success",
      duration,
      signature,
    });

    return signature;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(
      `[${operationName}] Failed after ${duration}ms:`,
      error
    );

    // Log to monitoring service
    logMetric({
      operation: operationName,
      status: "error",
      duration,
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}
```

---

## Troubleshooting

### Issue: Transactions Still Failing

**Solution 1: Verify Configuration**
```typescript
// Check endpoint
console.log("Sender endpoint:", TRANSACTION_CONFIG.SENDER_ENDPOINT);
// Should be: https://sender.helius-rpc.com/fast?swqos_only=true

// Check tip amount
console.log("SWQOS tip:", TRANSACTION_CONFIG.SWQOS_TIP_LAMPORTS);
// Should be: 5000 (0.000005 SOL)
```

**Solution 2: Check RPC Connection**
```typescript
try {
  const version = await connection.getVersion();
  console.log("RPC connected:", version);
} catch (error) {
  console.error("RPC connection failed:", error);
}
```

**Solution 3: Verify Wallet Balance**
```typescript
const balance = await connection.getBalance(wallet.publicKey);
console.log("Wallet balance:", balance / LAMPORTS_PER_SOL, "SOL");

// Minimum: 0.001 SOL for transaction + tips
if (balance < 1_000_000) {
  throw new Error("Insufficient SOL balance");
}
```

### Issue: "skipPreflight Required" Error

**Cause**: Missing `skipPreflight: true` in sendTransaction params

**Solution**:
```typescript
// Always use skipPreflight: true with Helius Sender
params: [
  serializedTx,
  {
    encoding: "base64",
    skipPreflight: true, // ✅ Required
    maxRetries: 0,
  },
]
```

### Issue: High Priority Fees

**Cause**: Network congestion or misconfigured priority fee calculation

**Solution**:
```typescript
// Add safety cap to priority fees
const MAX_PRIORITY_FEE = 100_000; // 0.0001 SOL max

const priorityFee = Math.min(
  await getRecommendedPriorityFee(tx, connection),
  MAX_PRIORITY_FEE
);
```

### Issue: Blockhash Expired Errors

**Cause**: Getting blockhash too early or waiting too long before sending

**Solution**:
```typescript
// ✅ Correct timing
const tx = await buildTransaction();         // 800ms
const { blockhash } = await getLatestBlockhash(); // +200ms
tx.recentBlockhash = blockhash;
tx.sign(wallet);                              // +50ms
await sendViaHeliusSender(tx);               // +500ms
// Total: ~1.5s (well within 60s validity)

// ❌ Wrong timing
const { blockhash } = await getLatestBlockhash();
await sleep(5000); // ❌ Wasting validity window
const tx = await buildTransaction();
tx.recentBlockhash = blockhash; // Already 5s old
```

---

## Cost Analysis

### Per Transaction Cost

**SWQOS:**
```
Priority Fee:  ~30,000 microLamports  = ~$0.0003
SWQOS Tip:     5,000 lamports         = ~$0.0005
Total:         ~$0.0008 per transaction
```

**Jito (for comparison):**
```
Priority Fee:  ~30,000 microLamports  = ~$0.0003
Jito Tip:      1,000,000 lamports     = ~$0.10
Total:         ~$0.10 per transaction
```

### Annual Cost (100 transactions/day)

```
SWQOS:  $0.0008 × 100 × 365 = $29/year
Jito:   $0.10 × 100 × 365   = $3,650/year

Savings: $3,621/year (99.2% reduction)
```

---

## Migration from Standard RPC

### Before (Standard RPC)

```typescript
async function sendTransaction(tx: Transaction, wallet: Keypair) {
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(wallet);

  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature);

  return signature;
}
```

**Problems:**
- 40-70% success rate
- No retry logic
- No priority fee optimization
- Slow confirmation (2-5s)

### After (SWQOS)

```typescript
async function sendTransaction(
  buildTx: () => Promise<Transaction>,
  wallet: Keypair
) {
  return await sendTransactionWithRetry(buildTx, wallet, connection);
}
```

**Benefits:**
- 95-99% success rate ✅
- Automatic retry with fresh state ✅
- Optimized priority fees ✅
- Sub-second confirmation ✅
- Only 0.0005 SOL cost ✅

**Migration Steps:**
1. Add SWQOS configuration
2. Implement helper functions
3. Update transaction sending to use `sendTransactionWithRetry`
4. Refactor transaction building into builder functions
5. Test on devnet/testnet
6. Deploy to production

---

## Full Jito Mode (Optional)

For MEV-sensitive transactions, switch to Full Jito mode:

```typescript
// config/transaction.ts
export const JITO_CONFIG = {
  // Full Jito endpoint (no query param)
  SENDER_ENDPOINT: "https://sender.helius-rpc.com/fast",

  // Jito tip (200x higher than SWQOS)
  JITO_TIP_LAMPORTS: 1_000_000, // 0.001 SOL

  // Same tip accounts
  TIP_ACCOUNTS: [...], // Same as SWQOS
};
```

**When to use:**
- Large swaps (>$10k value)
- Arbitrage operations
- Liquidations
- Time-sensitive price execution

**Implementation:**
```typescript
async function sendTransactionMode(
  buildTx: () => Promise<Transaction>,
  wallet: Keypair,
  mode: "swqos" | "jito" = "swqos"
): Promise<string> {
  const config = mode === "jito" ? JITO_CONFIG : TRANSACTION_CONFIG;

  // Same implementation, different config
  return await sendTransactionWithRetry(buildTx, wallet, connection, config);
}
```

---

## References

- [Helius Sender Documentation](https://docs.helius.dev/guides/sending-transactions-on-solana#helius-staked-connections-sender)
- [Helius Priority Fee API](https://docs.helius.dev/solana-rpc-nodes/alpha-priority-fee-api)
- [Solana Transaction Guide](https://solana.com/docs/core/transactions)
- [Jito Documentation](https://jito-labs.gitbook.io/mev/)

---

## Summary

**For 99% of Solana transactions, use SWQOS:**
1. ✅ 95-99% success rate
2. ✅ Sub-second confirmation
3. ✅ 99.5% cheaper than Jito
4. ✅ Simple implementation
5. ✅ Works with any RPC provider

**Key Implementation Points:**
- Rebuild transaction on each retry
- Get fresh blockhash before signing
- Use Helius priority fee API
- Add SWQOS tip (0.000005 SOL)
- Implement exponential backoff

**Cost:**
- ~$0.0008 per transaction
- ~$29/year for 100 transactions/day
- 99.2% savings vs Jito

Start with SWQOS for all non-MEV transactions. Only upgrade to Full Jito for high-value, MEV-sensitive operations.
