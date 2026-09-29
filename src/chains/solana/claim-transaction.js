import { confirmTransaction } from '../../utils/confirmation.util.js';
import { COMMITMENT_LEVEL } from '../../config/constants.js';

// Never rebuild/resubmit a claim after an ambiguous confirmation failure.
export async function sendClaimTransaction(connection, transaction, wallet) {
    const latest = await connection.getLatestBlockhash(COMMITMENT_LEVEL);
    transaction.recentBlockhash = latest.blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);
    const signature = transaction.signature && (await import('bs58')).default.encode(transaction.signature);
    try {
        await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
        const confirmation = await confirmTransaction(connection, signature, {
            lastValidBlockHeight: latest.lastValidBlockHeight,
            commitment: COMMITMENT_LEVEL,
            maxPolls: 120
        });
        return {
            ...confirmation,
            uncertain: confirmation.status === 'unknown'
        };
    } catch (error) {
        return { success: false, signature, uncertain: true, error: error.message };
    }
}
