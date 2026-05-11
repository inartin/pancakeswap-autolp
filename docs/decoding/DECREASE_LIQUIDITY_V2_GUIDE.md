# Complete Guide: Simulating PancakeSwap Decrease Liquidity V2 on Solana

## Table of Contents
1. [Introduction](#introduction)
2. [Prerequisites](#prerequisites)
3. [Understanding the Instruction](#understanding-the-instruction)
4. [Architecture Overview](#architecture-overview)
5. [Implementation Guide](#implementation-guide)
6. [Account Derivation Details](#account-derivation-details)
7. [Common Pitfalls](#common-pitfalls)

---

## Introduction

This guide teaches you how to simulate the `decrease_liquidity_v2` instruction for PancakeSwap's concentrated liquidity pools on Solana. This instruction removes liquidity from positions and collects fees and rewards.

### What You'll Learn
- Derive all required Program Derived Addresses (PDAs)
- Handle Token and Token-2022 programs correctly
- Structure instructions with reward accounts
- Simulate transactions before execution

---

## Prerequisites

### Required Knowledge
- Basic Solana blockchain concepts
- JavaScript/Node.js fundamentals
- Async/await patterns
- Token accounts on Solana

### Installation

```bash
# Install dependencies
pnpm install @solana/web3.js @solana/spl-token @coral-xyz/anchor bn.js dotenv
```

---

## Understanding the Instruction

### What Does `decrease_liquidity_v2` Do?

1. **Removes liquidity** from your position
2. **Collects trading fees** accumulated
3. **Collects reward tokens** from programs

### Parameters

```typescript
{
  liquidity: u128,      // Amount to remove (0 = fees only)
  amount_0_min: u64,    // Min token 0 (slippage protection)
  amount_1_min: u64     // Min token 1 (slippage protection)
}
```

### Required Accounts

**Base Accounts (16):**
- nft_owner, nft_account, personal_position
- pool_state, protocol_position
- token_vault_0, token_vault_1
- tick_array_lower, tick_array_upper
- recipient_token_account_0, recipient_token_account_1
- token_program, token_program_2022, memo_program
- vault_0_mint, vault_1_mint

**Per Reward (3 accounts each):**
- reward_vault
- reward_recipient
- reward_mint

**Conditional Account (1, if needed):**
- tick_array_bitmap_extension *(required for pools with tick spacing ≤ 8)*

---

## Architecture Overview

```
Input: Wallet + Position NFT
         ↓
Derive Personal Position PDA
         ↓
Fetch Position State (pool, ticks)
         ↓
Derive Protocol Position PDA ⚠️ BIG-ENDIAN
         ↓
Fetch Pool State (tokens, rewards)
         ↓
Derive Tick Arrays ⚠️ BIG-ENDIAN
         ↓
Derive Recipient ATAs
         ↓
Process Reward Accounts
         ↓
Build & Simulate Transaction
```

---

## Implementation Guide

### Step 1: Constants Setup

**File: `src/constants.js`**

```javascript
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';

const idl = JSON.parse(fs.readFileSync('./src/idl/pancakeswap-idl.json', 'utf8'));

export const PROGRAM_ID = new PublicKey(idl.address);
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;
export const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID;
export const POSITION_SEED = Buffer.from('position', 'utf8');
export const TICK_ARRAY_SEED = Buffer.from('tick_array', 'utf8');
export const TICK_ARRAY_BITMAP_EXTENSION_SEED = Buffer.from('pool_tick_array_bitmap_extension', 'utf8');
export const TICKS_IN_ARRAY = 60;
export const PANCAKESWAP_IDL = idl;
```

---

### Step 2: Helper Functions

**File: `src/utils/gather-accounts.util.js`**

#### Calculate Tick Array Start Index

```javascript
function getTickArrayStartIndex(tickIndex, tickSpacing) {
    const realIndex = Math.floor(tickIndex / tickSpacing / TICKS_IN_ARRAY);
    return realIndex * tickSpacing * TICKS_IN_ARRAY;
}
```

**Example:** `tickIndex=40920, spacing=60` → `startIndex=39600`

---

#### Derive Personal Position

```javascript
async function derivePersonalPosition(positionNftMint) {
    const [pda] = await PublicKey.findProgramAddress(
        [POSITION_SEED, positionNftMint.toBuffer()],
        PROGRAM_ID
    );
    return pda;
}
```

**Seeds:** `["position", nft_mint]`

---

#### Derive Protocol Position ⚠️ CRITICAL

```javascript
async function deriveProtocolPosition(poolState, tickLowerIndex, tickUpperIndex) {
    // ⚠️ MUST USE BIG-ENDIAN
    const tickLowerBuffer = Buffer.alloc(4);
    tickLowerBuffer.writeInt32BE(tickLowerIndex);
    
    const tickUpperBuffer = Buffer.alloc(4);
    tickUpperBuffer.writeInt32BE(tickUpperIndex);

    const [pda] = await PublicKey.findProgramAddress(
        [POSITION_SEED, poolState.toBuffer(), tickLowerBuffer, tickUpperBuffer],
        PROGRAM_ID
    );
    return pda;
}
```

**Seeds:** `["position", pool, tick_lower_BE, tick_upper_BE]`

**⚠️ CRITICAL:** Use `writeInt32BE` (big-endian), NOT `writeInt32LE`

---

#### Derive Tick Array ⚠️ CRITICAL

```javascript
async function deriveTickArray(poolState, startTickIndex) {
    // ⚠️ MUST USE BIG-ENDIAN
    const startTickBuffer = Buffer.alloc(4);
    startTickBuffer.writeInt32BE(startTickIndex);

    const [pda] = await PublicKey.findProgramAddress(
        [TICK_ARRAY_SEED, poolState.toBuffer(), startTickBuffer],
        PROGRAM_ID
    );
    return pda;
}
```

**Seeds:** `["tick_array", pool, start_tick_BE]`

---

#### Derive Tick Array Bitmap Extension ⚠️ CONDITIONAL

```javascript
async function deriveTickArrayBitmapExtension(poolState) {
    const [pda] = await PublicKey.findProgramAddress(
        [TICK_ARRAY_BITMAP_EXTENSION_SEED, poolState.toBuffer()],
        PROGRAM_ID
    );
    return pda;
}
```

**Seeds:** `["pool_tick_array_bitmap_extension", pool]`

**⚠️ WHEN NEEDED:** This account is **required for pools with tight tick spacing** (typically tick spacing ≤ 8, such as 1). Pools with larger tick spacing (10, 60, etc.) do not need this account.

**Why It Exists:**  
Pools with very tight tick spacing (like 1) have many more tick arrays to track. The bitmap extension provides additional storage to efficiently manage which tick arrays are initialized, preventing the main pool state account from becoming too large.

**How to Handle:**
1. Always derive the PDA
2. Check if the account exists on-chain
3. Only include it as a remaining account if it exists
4. Add it **after** all reward accounts in the instruction

**Error if Missing:**  
If you omit this account for a pool that requires it, you'll get error code `6040`: `MissingTickArrayBitmapExtensionAccount`.

---

#### Fetch Position State

```javascript
async function fetchPersonalPositionState(connection, personalPositionPda) {
    const accountInfo = await connection.getAccountInfo(personalPositionPda);
    if (!accountInfo) throw new Error('Position not found');

    const positionData = coder.accounts.decode('PersonalPositionState', accountInfo.data);
    
    return {
        poolId: positionData.pool_id,
        tickLowerIndex: positionData.tick_lower_index,
        tickUpperIndex: positionData.tick_upper_index,
        liquidity: BigInt(positionData.liquidity)
    };
}
```

---

#### Fetch Pool State

```javascript
async function fetchPoolState(connection, poolStatePubkey) {
    const accountInfo = await connection.getAccountInfo(poolStatePubkey);
    if (!accountInfo) throw new Error('Pool not found');

    const poolState = coder.accounts.decode('PoolState', accountInfo.data);
    
    return {
        tokenMint0: poolState.token_mint_0,
        tokenMint1: poolState.token_mint_1,
        tokenVault0: poolState.token_vault_0,
        tokenVault1: poolState.token_vault_1,
        tickSpacing: poolState.tick_spacing,
        rewardInfos: poolState.reward_infos
    };
}
```

---

#### Determine Token Program

```javascript
async function getMintTokenProgram(connection, mintPubkey) {
    const mintInfo = await connection.getAccountInfo(mintPubkey);
    if (!mintInfo) throw new Error(`Mint not found: ${mintPubkey}`);
    
    if (mintInfo.owner.equals(TOKEN_2022_PROGRAM)) return TOKEN_2022_PROGRAM;
    if (mintInfo.owner.equals(TOKEN_PROGRAM)) return TOKEN_PROGRAM;
    throw new Error('Unknown token program');
}
```

---

### Step 3: Main Account Gathering

```javascript
export async function gatherDecreaseLiquidityAccounts(connection, walletAddress, positionNftMint) {
    const nftOwner = new PublicKey(walletAddress);
    const positionNftMintPubkey = new PublicKey(positionNftMint);

    // 1. Get NFT token program
    const nftTokenProgram = await getMintTokenProgram(connection, positionNftMintPubkey);

    // 2. Derive NFT account
    const nftAccount = await getAssociatedTokenAddress(
        positionNftMintPubkey, nftOwner, false, nftTokenProgram
    );

    // 3. Derive personal position
    const personalPosition = await derivePersonalPosition(positionNftMintPubkey);

    // 4. Fetch position state
    const positionState = await fetchPersonalPositionState(connection, personalPosition);
    const poolState = positionState.poolId;

    // 5. Derive protocol position
    const protocolPosition = await deriveProtocolPosition(
        poolState, positionState.tickLowerIndex, positionState.tickUpperIndex
    );

    // 6. Fetch pool state
    const poolStateData = await fetchPoolState(connection, poolState);

    // 7. Calculate and derive tick arrays
    const tickArrayLowerStartIndex = getTickArrayStartIndex(
        positionState.tickLowerIndex, poolStateData.tickSpacing
    );
    const tickArrayUpperStartIndex = getTickArrayStartIndex(
        positionState.tickUpperIndex, poolStateData.tickSpacing
    );
    const tickArrayLower = await deriveTickArray(poolState, tickArrayLowerStartIndex);
    const tickArrayUpper = await deriveTickArray(poolState, tickArrayUpperStartIndex);

    // 8. Get token programs and derive recipient ATAs
    const token0Program = await getMintTokenProgram(connection, poolStateData.tokenMint0);
    const token1Program = await getMintTokenProgram(connection, poolStateData.tokenMint1);
    
    const recipientTokenAccount0 = await getAssociatedTokenAddress(
        poolStateData.tokenMint0, nftOwner, false, token0Program
    );
    const recipientTokenAccount1 = await getAssociatedTokenAddress(
        poolStateData.tokenMint1, nftOwner, false, token1Program
    );

    // 9. Process reward accounts
    const rewardAccounts = [];
    const systemProgram = new PublicKey('11111111111111111111111111111111');
    
    for (const rewardInfo of poolStateData.rewardInfos) {
        if (rewardInfo.token_mint && !rewardInfo.token_mint.equals(systemProgram)) {
            const rewardTokenProgram = await getMintTokenProgram(connection, rewardInfo.token_mint);
            const rewardRecipientAccount = await getAssociatedTokenAddress(
                rewardInfo.token_mint, nftOwner, false, rewardTokenProgram
            );
            
            rewardAccounts.push({
                mint: rewardInfo.token_mint.toString(),
                vault: rewardInfo.token_vault.toString(),
                recipient: rewardRecipientAccount.toString()
            });
        }
    }

    // 10. Derive and check tick array bitmap extension (for tight tick spacing pools)
    const tickArrayBitmapExtension = await deriveTickArrayBitmapExtension(poolState);
    const bitmapExtensionInfo = await connection.getAccountInfo(tickArrayBitmapExtension);
    const hasBitmapExtension = bitmapExtensionInfo !== null;

    return {
        nft_owner: nftOwner.toString(),
        nft_account: nftAccount.toString(),
        personal_position: personalPosition.toString(),
        pool_state: poolState.toString(),
        protocol_position: protocolPosition.toString(),
        token_vault_0: poolStateData.tokenVault0.toString(),
        token_vault_1: poolStateData.tokenVault1.toString(),
        tick_array_lower: tickArrayLower.toString(),
        tick_array_upper: tickArrayUpper.toString(),
        recipient_token_account_0: recipientTokenAccount0.toString(),
        recipient_token_account_1: recipientTokenAccount1.toString(),
        token_program: TOKEN_PROGRAM.toString(),
        token_program_2022: TOKEN_2022_PROGRAM.toString(),
        memo_program: MEMO_PROGRAM_ID.toString(),
        vault_0_mint: poolStateData.tokenMint0.toString(),
        vault_1_mint: poolStateData.tokenMint1.toString(),
        reward_accounts: rewardAccounts,
        tick_array_bitmap_extension: hasBitmapExtension ? tickArrayBitmapExtension.toString() : null
    };
}
```

---

### Step 4: Build and Simulate Transaction

**File: `src/index.js`**

```javascript
import 'dotenv/config';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { BorshInstructionCoder } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { gatherDecreaseLiquidityAccounts } from './utils/gather-accounts.util.js';
import { PANCAKESWAP_IDL, PROGRAM_ID } from './constants.js';

async function main() {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');

    // YOUR VALUES HERE
    const walletAddress = 'YOUR_WALLET_ADDRESS';
    const positionNftMint = 'YOUR_POSITION_NFT_MINT';

    // Gather accounts
    const accounts = await gatherDecreaseLiquidityAccounts(
        connection, walletAddress, positionNftMint
    );

    // Prepare parameters
    const params = {
        liquidity: new BN(0),
        amount0Min: new BN(0),
        amount1Min: new BN(0)
    };

    // Encode instruction
    const coder = new BorshInstructionCoder(PANCAKESWAP_IDL);
    const instructionData = coder.encode('decrease_liquidity_v2', {
        liquidity: params.liquidity,
        amount0Min: params.amount0Min,
        amount1Min: params.amount1Min
    });

    // Build account metas (16 base accounts)
    const accountMetas = [
        { pubkey: new PublicKey(accounts.nft_owner), isSigner: true, isWritable: false },
        { pubkey: new PublicKey(accounts.nft_account), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(accounts.personal_position), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(accounts.pool_state), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(accounts.protocol_position), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(accounts.token_vault_0), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(accounts.token_vault_1), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(accounts.tick_array_lower), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(accounts.tick_array_upper), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(accounts.recipient_token_account_0), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(accounts.recipient_token_account_1), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(accounts.token_program), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(accounts.token_program_2022), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(accounts.memo_program), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(accounts.vault_0_mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(accounts.vault_1_mint), isSigner: false, isWritable: false }
    ];
    
    // Add reward accounts (3 per reward)
    for (const reward of accounts.reward_accounts) {
        accountMetas.push(
            { pubkey: new PublicKey(reward.vault), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(reward.recipient), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(reward.mint), isSigner: false, isWritable: false }
        );
    }

    // Add tick array bitmap extension if it exists (for tight tick spacing pools)
    if (accounts.tick_array_bitmap_extension) {
        accountMetas.push({
            pubkey: new PublicKey(accounts.tick_array_bitmap_extension),
            isSigner: false,
            isWritable: true
        });
    }

    // Create instruction
    const instruction = new TransactionInstruction({
        keys: accountMetas,
        programId: PROGRAM_ID,
        data: instructionData
    });

    // Build transaction with ATA creation if needed
    const transaction = new Transaction();
    
    // Check and create recipient_token_account_0 if needed
    const account0Info = await connection.getAccountInfo(new PublicKey(accounts.recipient_token_account_0));
    if (!account0Info) {
        transaction.add(createAssociatedTokenAccountInstruction(
            new PublicKey(accounts.nft_owner),
            new PublicKey(accounts.recipient_token_account_0),
            new PublicKey(accounts.nft_owner),
            new PublicKey(accounts.vault_0_mint)
        ));
    }
    
    // Check and create recipient_token_account_1 if needed
    const account1Info = await connection.getAccountInfo(new PublicKey(accounts.recipient_token_account_1));
    if (!account1Info) {
        transaction.add(createAssociatedTokenAccountInstruction(
            new PublicKey(accounts.nft_owner),
            new PublicKey(accounts.recipient_token_account_1),
            new PublicKey(accounts.nft_owner),
            new PublicKey(accounts.vault_1_mint)
        ));
    }
    
    // Check and create reward recipient accounts if needed
    for (const reward of accounts.reward_accounts) {
        const rewardInfo = await connection.getAccountInfo(new PublicKey(reward.recipient));
        if (!rewardInfo) {
            transaction.add(createAssociatedTokenAccountInstruction(
                new PublicKey(accounts.nft_owner),
                new PublicKey(reward.recipient),
                new PublicKey(accounts.nft_owner),
                new PublicKey(reward.mint)
            ));
        }
    }
    
    transaction.add(instruction);
    
    // Set transaction metadata
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = new PublicKey(walletAddress);

    // Simulate with inner instructions
    // Serialize transaction for direct RPC call
    const serializedTx = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false
    });
    
    // Make direct RPC call to get inner instructions
    const rpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: [
            serializedTx.toString('base64'),
            {
                encoding: 'base64',
                commitment: 'confirmed',
                replaceRecentBlockhash: true,
                sigVerify: false,
                innerInstructions: true  // Enable inner instructions
            }
        ]
    };
    
    const response = await fetch(connection.rpcEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcRequest)
    });
    
    const rpcResult = await response.json();
    if (rpcResult.error) throw new Error(`RPC Error: ${JSON.stringify(rpcResult.error)}`);
    
    const result = rpcResult.result;
    
    // Parse and display results
    console.log('✅ Simulation Result:');
    console.log(`   Status: ${result.value.err ? 'Failed' : 'Success'}`);
    console.log(`   Compute Units: ${result.value.unitsConsumed}`);
    
    // Parse inner instructions
    if (result.value.innerInstructions) {
        console.log('\n📦 Inner Instructions:\n');
        
        for (const innerIx of result.value.innerInstructions) {
            console.log(`Instruction #${innerIx.index}:`);
            
            for (const ix of innerIx.instructions) {
                if (ix.parsed) {
                    const { type, info } = ix.parsed;
                    console.log(`  - ${type}`);
                    
                    if (type === 'transferChecked' && info.tokenAmount) {
                        console.log(`    Amount: ${info.tokenAmount.uiAmountString}`);
                        console.log(`    From: ${info.source}`);
                        console.log(`    To: ${info.destination}`);
                    } else if (type === 'createAccount') {
                        console.log(`    Account: ${info.newAccount}`);
                        console.log(`    Lamports: ${info.lamports}`);
                    }
                }
            }
            console.log();
        }
    }
    
    return result;
}

main().catch(console.error);
```

### Understanding Inner Instructions

Inner instructions are Cross-Program Invocations (CPIs) made by the main instruction. They reveal:

**Instruction #0** - ATA Creation (if needed):
- `getAccountDataSize` - Query token account size
- `createAccount` - Allocate account space
- `initializeImmutableOwner` - Set immutable owner
- `initializeAccount3` - Initialize token account

**Instruction #1** - Decrease Liquidity:
- `transferChecked` #1 - Transfer token 0 fees
- `transferChecked` #2 - Transfer token 1 fees  
- `transferChecked` #3 - Transfer reward tokens

**Example Output:**
```
📦 Inner Instructions:

Instruction #0:
  - getAccountDataSize
  - createAccount
    Account: 5snqQaBCSqDAkNdnEmNRrzL47ymovDTCLdGDyP6WnR8
    Lamports: 2039280
  - initializeImmutableOwner
  - initializeAccount3

Instruction #1:
  - transferChecked
    Amount: 0.000059184
    From: 3QfNy5ncLyJDiS6NduP3CC28q77YJ67ZLVcnGoX3wgZY
    To: 5snqQaBCSqDAkNdnEmNRrzL47ymovDTCLdGDyP6WnR8
  - transferChecked
    Amount: 0.002214091
    From: 9JAAzb8n8pAP8psFgZhLD9dvwJU5yeQ2czkD2o1h95o9
    To: EuSs8P7ZAZvjRXUn4zi9ahycn8D48pRJoaohakxDanLp
  - transferChecked
    Amount: 0.001453095
    From: FU9qUZ21wzjkTTUJWjP4uXbKu7LBNGvYAteC4myuvyjg
    To: EuSs8P7ZAZvjRXUn4zi9ahycn8D48pRJoaohakxDanLp
```

---

## Account Derivation Details

### Big-Endian vs Little-Endian

**⚠️ CRITICAL:** PancakeSwap uses **BIG-ENDIAN** encoding for tick indices.

```javascript
// ❌ WRONG
buffer.writeInt32LE(tickIndex);

// ✅ CORRECT
buffer.writeInt32BE(tickIndex);
```

### Why This Matters

Using the wrong endianness results in completely different PDA addresses, causing transaction failures.

**Example:**
- Tick index: `40920`
- Little-endian: `0x88 0x9F 0x00 0x00`
- Big-endian: `0x00 0x00 0x9F 0x88`

These produce different PDAs!

---

## Common Pitfalls

### 1. Wrong Endianness ⚠️
**Problem:** Using little-endian instead of big-endian  
**Solution:** Always use `writeInt32BE` for tick indices

### 2. Missing Reward Accounts
**Problem:** Not adding reward accounts as remaining accounts  
**Solution:** Add 3 accounts per active reward (vault, recipient, mint)

### 3. Wrong Token Program
**Problem:** Using Token Program for Token-2022 mints  
**Solution:** Check mint owner to determine correct program

### 4. Missing ATA Creation
**Problem:** Recipient accounts don't exist  
**Solution:** Add `createAssociatedTokenAccount` instructions

### 5. Incorrect Account Order
**Problem:** Accounts not in IDL order  
**Solution:** Follow exact order from IDL (16 base + 3 per reward + bitmap if needed)

### 6. Missing Tick Array Bitmap Extension ⚠️
**Problem:** Error code 6040 for pools with tight tick spacing  
**Solution:** Check if bitmap extension exists and add it as the last remaining account  
**When:** Required for pools with tick spacing ≤ 8 (commonly tick spacing = 1)

---

## Testing Your Implementation

### Verify Account Derivations

```javascript
console.log('Protocol Position:', accounts.protocol_position);
console.log('Tick Array Lower:', accounts.tick_array_lower);
console.log('Tick Array Upper:', accounts.tick_array_upper);
```

### Check Simulation Logs

Look for:
- ✅ `Program ... success`
- ✅ `TransferChecked` instructions
- ✅ `collect reward` messages
- ❌ Any error codes

### Expected Success Output

```
Program log: Instruction: DecreaseLiquidityV2
Program log: Instruction: TransferChecked
Program log: Instruction: TransferChecked
Program log: collect reward index: 0, transfer_amount: ...
Program ... success
```

---

## Summary

### Key Takeaways

1. **Use BIG-ENDIAN** for all tick index encodings
2. **Add 3 accounts per reward** (vault, recipient, mint)
3. **Check token programs** before deriving ATAs
4. **Create missing ATAs** before main instruction
5. **Include bitmap extension** for tight tick spacing pools (≤ 8)
6. **Follow exact account order** from IDL

### Next Steps

- Test with your own positions
- Implement actual transaction signing
- Add error handling and retries
- Monitor transaction confirmations

---

## Additional Resources

- [Solana Web3.js Docs](https://solana-labs.github.io/solana-web3.js/)
- [Anchor Framework](https://www.anchor-lang.com/)
- [SPL Token Program](https://spl.solana.com/token)

---

**Last Updated:** October 2025  
**Version:** 1.0.0
