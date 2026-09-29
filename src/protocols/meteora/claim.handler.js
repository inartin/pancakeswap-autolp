import { claimMeteoraRewards } from './claim.js';
import { getWalletClaimAddress } from '../../services/wallet.service.js';
import { getPositionByNft, upsertPosition } from '../../services/position.service.js';
import { recordClaim, recordClaimFee } from '../../services/position-statistics.service.js';
import { recordClaimTransaction } from '../../services/transaction.service.js';
import { formatCurrency, formatTokenAmount } from '../../utils/format.util.js';

export async function handleMeteoraClaim(bot, { chatId, messageId, connection, keypair, wallet, address }) {
    const claimAddress = await getWalletClaimAddress(wallet.id);
    let dbPosition = await getPositionByNft(address.toBase58());
    if (dbPosition && dbPosition.wallet_id !== wallet.id) throw new Error('Position belongs to a different wallet');
    const result = await claimMeteoraRewards(connection, keypair, address, claimAddress, !!wallet.split_strategy, async receipt => {
        if (!dbPosition) {
            dbPosition = await upsertPosition({ ...receipt.position, wallet_id: wallet.id, nft_mint: address.toBase58(),
                auto_rebalance_enabled: false, claim_before_rebalance: false, status: 'active' });
        }
        await recordClaimTransaction(wallet.id, dbPosition.id, receipt);
        await recordClaim(dbPosition.id, receipt.totalUsd);
        await recordClaimFee(dbPosition.id, receipt.transactionFee);
    });
    // Plain text avoids token symbols / RPC errors being interpreted as Markdown.
    let text = result.success ? '✅ Meteora claim complete' : result.results.length ? '⚠️ Meteora claim partially completed' : '❌ Meteora claim failed';
    text += `\nDestination: ${claimAddress || wallet.wallet_address}\n`;
    for (const receipt of result.results) {
        text += `\nConfirmed: ${receipt.explorer}\n`;
        for (const token of receipt.claimed) text += `• ${formatTokenAmount(token.uiAmount)} ${token.symbol} (${formatCurrency(token.usdValue)})\n`;
        if (receipt.transfer?.transferred) {
            text += `Forwarded${receipt.transfer.splitStrategy ? ' using wallet split settings' : ''}: ${receipt.transfer.explorer}\n`;
            if (receipt.transfer.skipped?.length) text += `${receipt.transfer.skipped.length} token(s) stayed in the wallet (dust or transfer unavailable).\n`;
        } else if (receipt.transfer) {
            text += receipt.transfer.uncertain
                ? `Transfer confirmation unknown. Check before retrying: https://solscan.io/tx/${receipt.transfer.signature}\n`
                : `Funds remain in wallet: ${receipt.transfer.error || receipt.transfer.reason}\n`;
        }
    }
    if (result.error) text += `\n${result.error}\n`;
    if (result.pendingSignature) text += `\nCheck transaction: https://solscan.io/tx/${result.pendingSignature}\n`;
    if (result.warnings.length) text += `\n${result.warnings.join('\n')}\n`;
    text += '\nSOL fees are received as WSOL. Forwarding uses the wallet’s split and dust settings.';
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '📊 View Positions', callback_data: 'positions' }, { text: '💰 Rewards', callback_data: 'rewards' }]] } });
}
