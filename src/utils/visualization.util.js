/**
 * Range Visualization Utilities
 *
 * Simplified, clean visualization format for position ranges
 *
 * @module visualization.util
 */

import { formatDecimal } from './format.util.js';

/**
 * Get position indicator emoji based on percentage
 * Symmetric gradient: 🔴🟠🟡🟢🟡🟠🔴
 * Green in center (safe), red at extremes (risky)
 * 
 * @param {number} percent - Percentage from lower bound (0-100)
 * @returns {string} Emoji indicator
 */
function getPositionEmoji(percent) {
    // Calculate distance from center (50%)
    const distanceFromCenter = Math.abs(percent - 50);

    if (distanceFromCenter > 40) return '🔴'; // 0-10% or 90-100%
    if (distanceFromCenter > 30) return '🟠'; // 10-20% or 80-90%
    if (distanceFromCenter > 10) return '🟡'; // 20-40% or 60-80%
    return '🟢';                               // 40-60% (centered)
}

/**
 * Create position bar visualization
 * Format: |────────🟢────────|
 * Ball color changes based on position: 🔴🟠🟡🟢🟡🟠🔴
 *
 * Bar width kept narrow (16 chars) and endpoint emojis removed to ensure
 * the visualization fits on smaller screens without line breaks.
 *
 * @param {number} percentFromLower - Percentage from lower bound (0-100)
 * @returns {string} Position bar
 */
function formatPositionBar(percentFromLower) {
    const barWidth = 16;
    const position = Math.floor((percentFromLower / 100) * barWidth);
    const emoji = getPositionEmoji(percentFromLower);

    let bar = '|';
    for (let i = 0; i < barWidth; i++) {
        if (i === position) {
            bar += emoji;
        } else {
            bar += '─';
        }
    }
    bar += '|';

    return bar;
}

/**
 * Create complete position visualization
 * Format:
 * Position:
 * |────────🟢────────|
 * From lower bound: 51.8%
 * From upper bound: 48.2%
 *
 * 💰 Price Range:
 * Lower: $178.0103
 * Current: $183.7434 ✅
 * Upper: $189.074
 *
 * Shows both percentages from lower and upper bounds - no conditional logic
 *
 * @param {Object} rangeData - Position range data
 * @returns {string} Multi-line visualization
 */
export function formatPositionVisualization(rangeData) {
    const { lowerPrice, currentPrice, upperPrice, inRange, outOfRangeDirection, range_percent } = rangeData;

    // Calculate percentage from lower and upper bounds
    const rangeWidth = upperPrice - lowerPrice;
    const percentFromLower = ((currentPrice - lowerPrice) / rangeWidth) * 100;
    const percentFromUpper = ((upperPrice - currentPrice) / rangeWidth) * 100;

    // Determine status indicator
    let statusEmoji = '';
    let statusText = '';

    if (inRange) {
        statusEmoji = '✅';
        statusText = '';
    } else if (outOfRangeDirection === 'below') {
        statusEmoji = '⭕️';
        statusText = ' (Below)';
    } else {
        statusEmoji = '⭕️';
        statusText = ' (Above)';
    }

    // Build the visualization
    let output = '*Range:*';
    // Add range_percent if available
    if (range_percent != null) {
        output += ` ±${range_percent}%\n`;
    }else{
        output += '\n'
    }

    // Only show bar if in range
    if (inRange) {
        output += `${formatPositionBar(percentFromLower)}\n`;
        output += `Boundaries: ${percentFromLower.toFixed(1)}% · `;
        output += `${percentFromUpper.toFixed(1)}%\n\n`;
    } else {
        output += `${statusEmoji} Out of Range${statusText}\n\n`;
    }

    output += '💰 *Price Range:*\n';
    output += `Lower: ${formatDecimal(lowerPrice, 'auto')}\n`;
    output += `Current: ${formatDecimal(currentPrice, 'auto')} ${statusEmoji}\n`;
    output += `Upper: ${formatDecimal(upperPrice, 'auto')}`;


    return output;
}


