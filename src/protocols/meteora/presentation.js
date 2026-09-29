import { formatCurrency, formatDecimal } from '../../utils/format.util.js';

export function formatMeteoraRewards(position, index) {
    let message = '';
    const positionLabel = `🪐 [Meteora DLMM #${index + 1}](${position.poolUrl || `https://app.meteora.ag/dlmm/${position.poolId}`})`;
    message += `${positionLabel}  *${position.token0Symbol}/${position.token1Symbol}*\n`;

    const hasClaimable = (position.unclaimedFeesUsd > 0) || (position.unclaimedFeeToken0 > 0) || (position.unclaimedFeeToken1 > 0);
    if (hasClaimable) {
        message += `💰 Claimable: *${formatCurrency(position.unclaimedFeesUsd || 0)}*\n`;
        if (position.unclaimedFeeToken0 > 0) {
            message += `   • ${formatDecimal(position.unclaimedFeeToken0, 'auto')} ${position.token0Symbol}`;
            if (position.unclaimedFeeToken0Usd > 0) message += ` (${formatCurrency(position.unclaimedFeeToken0Usd)})`;
            message += `\n`;
        }
        if (position.unclaimedFeeToken1 > 0) {
            message += `   • ${formatDecimal(position.unclaimedFeeToken1, 'auto')} ${position.token1Symbol}`;
            if (position.unclaimedFeeToken1Usd > 0) message += ` (${formatCurrency(position.unclaimedFeeToken1Usd)})`;
            message += `\n`;
        }
    } else {
        message += `No claimable rewards\n\n`;
    }

    return message + '\n';
}

export function meteoraClaimButtons(position, index) {
    return [
        { text: `💰 Claim Meteora #${index + 1}`, callback_data: `claim_${position.mintAddress}` },
        { text: '🎯 Set Claim Address', callback_data: 'set_claim_address' }
    ];
}

export function meteoraPoolUrl(poolAddress) {
    return `https://app.meteora.ag/dlmm/${poolAddress}`;
}

export function formatMeteoraLinks(position) {
    return `\n[View on Meteora →](${position.poolUrl || meteoraPoolUrl(position.poolId)})  |  [View on Solscan →](https://solscan.io/account/${position.mintAddress})\n`;
}

export function formatMeteoraLiquidity(position, token0Symbol, token1Symbol) {
    if (position.amount0Human == null || position.amount1Human == null) return '';
    return `\n💎 *Liquidity:*\n   ${formatDecimal(position.amount0Human, 'auto')} ${token0Symbol} | ${formatDecimal(position.amount1Human, 'auto')} ${token1Symbol}\n`;
}

// API lifetime fees have a different scope from the wallet's recorded claim counter.
export function formatMeteoraLifetimeFees(positionsData) {
    const items = positionsData.flatMap((position, index) => {
        if (position.protocol !== 'meteora') return [];
        const pair = position.token0Symbol && position.token1Symbol
            ? `${position.token0Symbol}/${position.token1Symbol}` : 'DLMM';
        const outOfRange = position.inRange === false || position.isOutOfRange === true;
        return [`   • #${index + 1} ${pair}${outOfRange ? ' _(Out of Range)_' : ''}: ${formatCurrency(parseFloat(position.allTimeFeesUsd) || 0)}\n`];
    });
    return items.length ? `\n*Meteora lifetime fees (current positions):*\n${items.join('')}` : '';
}
