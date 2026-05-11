/**
 * Parses transfer data from simulation inner instructions
 *
 * @param {Object} simulationResult - The simulation result from Solana RPC
 * @param {Object} accounts - The gathered accounts containing mint information
 * @returns {Array<Object>} Array of parsed transfers with token and amount information
 */
export function parseTransferChecked(simulationResult, accounts) {
    const transfers = [];

    if (!simulationResult.value.innerInstructions) {
        return transfers;
    }

    // Parse all inner instructions
    for (const innerIx of simulationResult.value.innerInstructions) {
        for (const ix of innerIx.instructions) {
            if (ix.parsed && ix.parsed.type === 'transferChecked') {
                const info = ix.parsed.info;

                transfers.push({
                    token: info.mint,
                    amount: info.tokenAmount.amount,
                    uiAmount: info.tokenAmount.uiAmount,
                    uiAmountString: info.tokenAmount.uiAmountString,
                    decimals: info.tokenAmount.decimals,
                    from: info.source,
                    to: info.destination
                });
            }
        }
    }

    return transfers;
}

/**
 * Groups transfers by token mint for easier analysis
 *
 * @param {Array<Object>} transfers - Array of parsed transfers
 * @returns {Object} Object with token mints as keys and transfer arrays as values
 */
export function groupTransfersByToken(transfers) {
    const grouped = {};

    for (const transfer of transfers) {
        const tokenKey = transfer.token;
        if (!grouped[tokenKey]) {
            grouped[tokenKey] = [];
        }
        grouped[tokenKey].push(transfer);
    }

    return grouped;
}

/**
 * Calculates total amounts by token
 *
 * @param {Array<Object>} transfers - Array of parsed transfers
 * @returns {Object} Object with token mints as keys and total amounts as values
 */
export function calculateTotalsByToken(transfers) {
    const totals = {};

    for (const transfer of transfers) {
        const tokenKey = transfer.token;
        if (!totals[tokenKey]) {
            totals[tokenKey] = {
                token: transfer.token,
                totalRawAmount: 0,
                totalUiAmount: 0,
                decimals: transfer.decimals
            };
        }

        totals[tokenKey].totalRawAmount += parseInt(transfer.amount);
        totals[tokenKey].totalUiAmount += transfer.uiAmount;
    }

    return totals;
}
