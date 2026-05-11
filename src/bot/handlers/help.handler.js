/**
 * Handles the /help command
 *
 * @param {TelegramBot} bot - The Telegram bot instance
 * @param {Object} msg - The message object from Telegram
 */
export function handleHelp(bot, msg) {
    const chatId = msg.chat.id;
    const helpMessage = `
📚 *Available Commands*

*💼 Wallet Management*
/newwallet - Generate new wallet
/importwallet - Import existing wallet
/exportkey - Export private key (secure)
/wallet - View active wallet info
/wallets - List all your wallets
/balance - Check SOL balance

*📊 Positions*
/addposition - Create new liquidity position
/positions - View all positions with range status
/rewards - Check claimable rewards
/claim <nft> - Claim rewards from position
/compound <nft> - Auto-compound rewards to position
/rebalance <nft> - Rebalance position to current price
/stats - View aggregated stats

*🔔 Alerts & Monitoring*
/proximity - Configure proximity alerts (edge-triggered)

*🔐 Security*
/auditlog - View security audit log
/walletaudit - View wallet security history

*🔧 Settings*
/help - Show this help message
/start - Restart bot
/cancel - Cancel current operation

*How to Get Started:*
1️⃣ Create or import a wallet
2️⃣ Fund it with SOL for transactions
3️⃣ Use /rewards to check your rewards
4️⃣ Compound or claim rewards
    `.trim();

    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
}
