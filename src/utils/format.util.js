/**
 * Format a Solana address for display
 * Shows first N and last N characters with ellipsis in between
 *
 * @param {string} address - Full Solana address
 * @param {number} prefixLength - Number of characters to show at start (default: 6)
 * @param {number} suffixLength - Number of characters to show at end (default: 6)
 * @returns {string} Formatted address like "ABC123...XYZ789"
 *
 * @example
 * formatShortAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
 * // Returns: "9WzDXw...tAWWM"
 *
 * @example
 * formatShortAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 8, 4)
 * // Returns: "9WzDXwBb...AWWM"
 */
export function formatShortAddress(address, prefixLength = 6, suffixLength = 6) {
    if (!address || typeof address !== 'string') {
        throw new Error('Invalid address: must be a non-empty string');
    }

    if (address.length <= prefixLength + suffixLength) {
        return address;
    }

    return `${address.slice(0, prefixLength)}...${address.slice(-suffixLength)}`;
}

export function formatNumber(num) {
    if (num === null || num === undefined || isNaN(num)) {
        return 0;
    }

    try {
        const format = (n, decimals) => {
            const absN = Math.abs(n);
            // Handle very small numbers or zero - treat anything under 0.0001 as 0
            if (absN < 0.0001 || absN === 0) {
                return 0;
            }
            if (absN >= 1 || absN === 0) {
                // For numbers >= 1 or exactly 0, use fixed notation
                return Number(n.toFixed(decimals));
            } else {
                // For numbers between 0.0001 and 1, show fewer decimals
                if (absN >= 0.01) return Number(n.toFixed(3)); // 0.123
                return Number(n.toFixed(4)); // 0.0123
            }
        };

        const abs = Math.abs(num);
        if (abs >= 1e12) return format(num / 1e12, 2) + 'T';
        if (abs >= 1e9) return format(num / 1e9, 2) + 'B';
        if (abs >= 1e6) return format(num / 1e6, 2) + 'M';
        if (abs >= 1e3) return format(num / 1e3, 2) + 'K';
        if (abs >= 100 && abs < 1000) return Math.round(num);
        if (abs < 0.0001) return 0; // Show 0 instead of very small numbers
        return format(num, 2); // 2 decimals for numbers under 100
    } catch (e) {
        console.error(`Error formatting number ${num}: ` + e + " Will set it to 0")
        return 0;
    }
};

/**
 * Format a decimal number with comma separators
 *
 * @param {number} number - The number to format
 * @param {number|string} decimals - Number of decimal places, or 'auto' for automatic precision based on magnitude (default: 2)
 * @returns {string} Formatted number string like "1,234.56"
 *
 * @example
 * formatDecimal(1234.56)           // "1,234.56"
 * formatDecimal(1234567.89)        // "1,234,567.89"
 * formatDecimal(178.0103, 4)       // "178.0103"
 * formatDecimal(2465.88)           // "2,465.88"
 * formatDecimal(0.0005421, 'auto') // "0.00054" (automatic precision for small numbers)
 * formatDecimal(0.0000012, 'auto') // "0.0000012"
 * formatDecimal(123.45, 'auto')    // "123.45" (standard precision for normal numbers)
 */
export function formatDecimal(number, decimals = 2) {
    // Handle invalid inputs
    if (number === null || number === undefined || isNaN(number)) {
        return '0';
    }

    try {
        const isNegative = number < 0;
        const absNumber = Math.abs(number);

        // Auto mode: adjust decimal places based on number magnitude
        let finalDecimals = decimals;
        if (decimals === 'auto') {
            if (absNumber === 0) {
                finalDecimals = 2;
            } else if (absNumber >= 1000) {
                finalDecimals = 2; // Large numbers: 1,234.56
            } else if (absNumber >= 1) {
                finalDecimals = 4; // Medium numbers: 123.4567
            } else if (absNumber >= 0.01) {
                finalDecimals = 6; // Small numbers: 0.012345
            } else {
                // Very small numbers: show enough decimals to see significant digits
                // Find the first non-zero decimal place and add 2 more significant digits
                const logValue = Math.floor(Math.log10(absNumber));
                finalDecimals = Math.abs(logValue) + 2;
                // Cap at reasonable maximum
                finalDecimals = Math.min(finalDecimals, 12);
            }
        }

        // Format with commas and calculated decimals
        const formattedNumber = absNumber.toLocaleString('en-US', {
            minimumFractionDigits: finalDecimals,
            maximumFractionDigits: finalDecimals
        });

        return `${isNegative ? '-' : ''}${formattedNumber}`;
    } catch (error) {
        console.error(`Error formatting decimal ${number}: ${error.message}`);
        return '0';
    }
}

/**
 * Format token amount with standardized 4 decimal places
 *
 * @param {number} amount - The token amount to format
 * @returns {string} Formatted token amount string like "1,234.5678"
 *
 * @example
 * formatTokenAmount(1234.567890)   // "1,234.5678"
 * formatTokenAmount(0.123456)      // "0.1234"
 * formatTokenAmount(0.0001)        // "0.0001"
 * formatTokenAmount(1000000.5)     // "1,000,000.5000"
 */
export function formatTokenAmount(amount) {
    // Handle invalid inputs
    if (amount === null || amount === undefined || isNaN(amount)) {
        return '0.0000';
    }

    try {
        const isNegative = amount < 0;
        const absAmount = Math.abs(amount);

        // Format with commas and 4 decimals
        const formattedAmount = absAmount.toLocaleString('en-US', {
            minimumFractionDigits: 4,
            maximumFractionDigits: 4
        });

        return `${isNegative ? '-' : ''}${formattedAmount}`;
    } catch (error) {
        console.error(`Error formatting token amount ${amount}: ${error.message}`);
        return '0.0000';
    }
}

/**
 * Format a percentage with comma separators
 *
 * @param {number} number - The percentage number to format (without % sign)
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {string} Formatted percentage string like "1,234.56%"
 *
 * @example
 * formatPercentage(12.34)          // "12.34%"
 * formatPercentage(2465.88)        // "2,465.88%"
 * formatPercentage(123.456, 1)     // "123.5%"
 */
export function formatPercentage(number, decimals = 2) {
    return `${formatDecimal(number, decimals)}%`;
}

/**
 * Format a currency value with proper formatting
 *
 * @param {number} amount - The currency amount to format
 * @param {number} decimals - Number of decimal places (default: 2)
 * @param {boolean} humanReadable - Use human-readable format like $10.7k, $1.3M (default: false)
 * @returns {string} Formatted currency string like "$1,234.56" or "$10.7k"
 *
 * @example
 * formatCurrency(1234.56)           // "$1,234.56"
 * formatCurrency(1234567.89)        // "$1,234,567.89"
 * formatCurrency(10700, 2, true)    // "$10.7k"
 * formatCurrency(1300000, 2, true)  // "$1.3M"
 * formatCurrency(2400000000, 2, true) // "$2.4B"
 */
export function formatCurrency(amount, decimals = 2, humanReadable = false) {
    // Handle invalid inputs
    if (amount === null || amount === undefined || isNaN(amount)) {
        return '$0.00';
    }

    try {
        const isNegative = amount < 0;
        const absAmount = Math.abs(amount);

        // Human-readable format (e.g., $10.7k, $1.3M)
        if (humanReadable) {
            let value;
            let suffix;

            if (absAmount >= 1e12) {
                value = absAmount / 1e12;
                suffix = 'T';
            } else if (absAmount >= 1e9) {
                value = absAmount / 1e9;
                suffix = 'B';
            } else if (absAmount >= 1e6) {
                value = absAmount / 1e6;
                suffix = 'M';
            } else if (absAmount >= 1e3) {
                value = absAmount / 1e3;
                suffix = 'k';
            } else {
                // For amounts under 1000, use standard format
                value = absAmount;
                suffix = '';
            }

            // Format with appropriate decimals
            const formattedValue = value.toFixed(decimals === 2 ? 1 : decimals);
            return `${isNegative ? '-' : ''}$${formattedValue}${suffix}`;
        }

        // Standard format with commas (e.g., $1,234.56)
        const formattedAmount = absAmount.toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });

        return `${isNegative ? '-' : ''}$${formattedAmount}`;
    } catch (error) {
        console.error(`Error formatting currency ${amount}: ${error.message}`);
        return '$0.00';
    }
}

/**
 * Get PancakeSwap position URL
 *
 * @param {string} poolAddress - Pool address
 * @param {string} nftMint - NFT mint address of the position
 * @returns {string} PancakeSwap position URL
 *
 * @example
 * getPancakeSwapPositionUrl('PoolAddress123...', 'NFTMint456...')
 * // Returns: "https://pancakeswap.finance/liquidity/position/v3/solana/PoolAddress123.../NFTMint456...?chain=sol&persistChain=1"
 */
export function getPancakeSwapPositionUrl(poolAddress, nftMint) {
    return `https://pancakeswap.finance/liquidity/position/v3/solana/${poolAddress}/${nftMint}?chain=sol&persistChain=1`;
}

/**
 * Get PancakeSwap pool URL
 *
 * @param {string} poolAddress - Pool address
 * @returns {string} PancakeSwap pool URL
 *
 * @example
 * getPancakeSwapPoolUrl('PoolAddress123...')
 * // Returns: "https://pancakeswap.finance/liquidity/pool/solana/PoolAddress123..."
 */
export function getPancakeSwapPoolUrl(poolAddress) {
    return `https://pancakeswap.finance/liquidity/pool/solana/${poolAddress}`;
}

/**
 * Get Solscan transaction URL
 *
 * @param {string} signature - Transaction signature
 * @returns {string} Solscan transaction URL
 *
 * @example
 * getSolscanTransactionUrl('5j7s8...')
 * // Returns: "https://solscan.io/tx/5j7s8..."
 */
export function getSolscanTransactionUrl(signature) {
    return `https://solscan.io/tx/${signature}`;
}

/**
 * Get Solscan account URL
 *
 * @param {string} accountAddress - Account address (wallet, token account, program account, etc.)
 * @returns {string} Solscan account URL
 *
 * @example
 * getSolscanAccountUrl('9WzDXw...')
 * // Returns: "https://solscan.io/account/9WzDXw..."
 */
export function getSolscanAccountUrl(accountAddress) {
    return `https://solscan.io/account/${accountAddress}`;
}

/**
 * Get Solscan token URL
 *
 * @param {string} mintAddress - Token mint address
 * @returns {string} Solscan token URL
 *
 * @example
 * getSolscanTokenUrl('So11111...')
 * // Returns: "https://solscan.io/token/So11111..."
 */
export function getSolscanTokenUrl(mintAddress) {
    return `https://solscan.io/token/${mintAddress}`;
}