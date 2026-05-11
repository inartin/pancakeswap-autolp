import { Connection, PublicKey } from '@solana/web3.js';
import { env } from '../config/env.js';
import { COMMITMENT_LEVEL } from '../config/constants.js';

/**
 * Get SOL balance for a wallet address
 *
 * @param {string} walletAddress - Solana wallet public key as string
 * @returns {Promise<string>} Balance in SOL, formatted to 4 decimal places
 *
 * @example
 * const balance = await getSolanaBalance('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
 * console.log(balance); // "1.2345"
 */
export async function getSolanaBalance(walletAddress) {
    if (!walletAddress || typeof walletAddress !== 'string') {
        throw new Error('Invalid wallet address: must be a non-empty string');
    }

    try {
        const connection = new Connection(env.SOLANA_RPC_URL, COMMITMENT_LEVEL);
        const publicKey = new PublicKey(walletAddress);
        const balance = await connection.getBalance(publicKey);

        // Convert lamports to SOL (1 SOL = 1e9 lamports)
        return (balance / 1e9).toFixed(4);
    } catch (error) {
        throw new Error(`Failed to get balance for ${walletAddress}: ${error.message}`);
    }
}

/**
 * Create a Solana RPC connection
 * Useful when you need the connection object for multiple operations
 *
 * @returns {Connection} Solana web3 Connection instance
 *
 * @example
 * const connection = createSolanaConnection();
 * const balance = await connection.getBalance(publicKey);
 */
export function createSolanaConnection() {
    return new Connection(env.SOLANA_RPC_URL, COMMITMENT_LEVEL);
}
