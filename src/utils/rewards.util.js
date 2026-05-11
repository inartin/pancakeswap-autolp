import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { BorshInstructionCoder } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { PANCAKESWAP_IDL, PROGRAM_ID, COMMITMENT_LEVEL } from '../config/constants.js';

/**
 * Simulates a decrease_liquidity_v2 transaction for a PancakeSwap position
 *
 * @param {Connection} connection - Solana connection instance
 * @param {Object} accounts - The gathered accounts for the transaction
 * @param {string} walletAddress - The wallet address that owns the position
 * @param {string} liquidityAmount - Amount of liquidity to remove (default '0' = rewards only)
 * @returns {Promise<Object>} The simulation result from Solana RPC
 */
export async function simulateDecreaseLiquidityV2(connection, accounts, walletAddress, liquidityAmount = '0') {
    // Prepare instruction parameters
    // liquidityAmount = '0' simulates reward/fee collection only (existing /rewards behavior)
    // liquidityAmount = full position liquidity simulates complete removal
    const params = {
        liquidity: new BN(liquidityAmount),
        amount0Min: new BN(0),
        amount1Min: new BN(0),
    };

    // Create instruction coder
    const coder = new BorshInstructionCoder(PANCAKESWAP_IDL);

    // Encode the instruction data
    const instructionData = coder.encode('decrease_liquidity_v2', {
        liquidity: params.liquidity,
        amount0Min: params.amount0Min,
        amount1Min: params.amount1Min,
    });

    // Build the account metas array according to IDL order
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
        { pubkey: new PublicKey(accounts.vault_1_mint), isSigner: false, isWritable: false },
    ];

    // Add reward accounts as remaining accounts (vault, recipient, mint for each reward)
    if (accounts.reward_accounts && accounts.reward_accounts.length > 0) {
        for (const rewardAccount of accounts.reward_accounts) {
            // Add vault (writable)
            accountMetas.push({
                pubkey: new PublicKey(rewardAccount.vault),
                isSigner: false,
                isWritable: true
            });

            // Add recipient (writable)
            accountMetas.push({
                pubkey: new PublicKey(rewardAccount.recipient),
                isSigner: false,
                isWritable: true
            });

            // Add mint (read-only)
            accountMetas.push({
                pubkey: new PublicKey(rewardAccount.mint),
                isSigner: false,
                isWritable: false
            });
        }
    }

    // Add tick array bitmap extension if it exists (required for pools with tight tick spacing)
    if (accounts.tick_array_bitmap_extension) {
        accountMetas.push({
            pubkey: new PublicKey(accounts.tick_array_bitmap_extension),
            isSigner: false,
            isWritable: true
        });
    }

    // Create the instruction
    const instruction = new TransactionInstruction({
        keys: accountMetas,
        programId: PROGRAM_ID,
        data: instructionData,
    });

    // Check if recipient token accounts exist and create them if needed
    const transaction = new Transaction();

    // Check recipient_token_account_0
    const recipientAccount0Info = await connection.getAccountInfo(new PublicKey(accounts.recipient_token_account_0));
    if (!recipientAccount0Info) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
            new PublicKey(accounts.nft_owner), // payer
            new PublicKey(accounts.recipient_token_account_0), // ata
            new PublicKey(accounts.nft_owner), // owner
            new PublicKey(accounts.vault_0_mint) // mint
        );
        transaction.add(createAtaIx);
    }

    // Check recipient_token_account_1
    const recipientAccount1Info = await connection.getAccountInfo(new PublicKey(accounts.recipient_token_account_1));
    if (!recipientAccount1Info) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
            new PublicKey(accounts.nft_owner), // payer
            new PublicKey(accounts.recipient_token_account_1), // ata
            new PublicKey(accounts.nft_owner), // owner
            new PublicKey(accounts.vault_1_mint) // mint
        );
        transaction.add(createAtaIx);
    }

    // Check reward recipient accounts
    if (accounts.reward_accounts && accounts.reward_accounts.length > 0) {
        for (const rewardAccount of accounts.reward_accounts) {
            const rewardRecipientInfo = await connection.getAccountInfo(new PublicKey(rewardAccount.recipient));
            if (!rewardRecipientInfo) {
                const createAtaIx = createAssociatedTokenAccountInstruction(
                    new PublicKey(accounts.nft_owner), // payer
                    new PublicKey(rewardAccount.recipient), // ata
                    new PublicKey(accounts.nft_owner), // owner
                    new PublicKey(rewardAccount.mint) // mint
                );
                transaction.add(createAtaIx);
            }
        }
    }

    // Add the main decrease liquidity instruction
    transaction.add(instruction);

    // Set recent blockhash and fee payer
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = new PublicKey(walletAddress);

    // Serialize the transaction for RPC call
    const serializedTransaction = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false
    });
    const base64Transaction = serializedTransaction.toString('base64');

    // Make direct RPC call to get inner instructions
    const rpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: [
            base64Transaction,
            {
                encoding: 'base64',
                commitment: COMMITMENT_LEVEL,
                replaceRecentBlockhash: true,
                sigVerify: false,
                innerInstructions: true
            }
        ]
    };

    const response = await fetch(connection.rpcEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcRequest)
    });

    const rpcResult = await response.json();

    if (rpcResult.error) {
        throw new Error(`RPC Error: ${JSON.stringify(rpcResult.error)}`);
    }

    return rpcResult.result;
}
