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
        const confirmation = await connection.confirmTransaction({ signature, ...latest }, COMMITMENT_LEVEL);
        if (confirmation.value.err) {
            return { success: false, signature, error: JSON.stringify(confirmation.value.err) };
        }
        return { success: true, signature };
    } catch (error) {
        return { success: false, signature, uncertain: true, error: error.message };
    }
}
