import { ethers } from 'ethers';
import { env } from '../config/env.js';
import {
    EVM_CONTRACTS,
    UNISWAP_V3_POSITION_ABI,
    UNISWAP_V3_FACTORY_ABI,
    UNISWAP_V3_POOL_SLOT0_ABI,
    UNISWAP_V4_POSITION_ABI,
    UNISWAP_V4_STATE_VIEW_ABI,
    getEvmTokenSymbol
} from '../config/constants.js';

let _provider = null;

function getProvider() {
    if (!_provider) {
        _provider = new ethers.JsonRpcProvider(env.ETH_RPC_URL);
    }
    return _provider;
}

/**
 * Check if a wallet address is an EVM address
 *
 * @param {string} address - Wallet address to check
 * @returns {boolean} True if the address is a valid EVM address
 */
export function isEvmWallet(address) {
    if (!address || typeof address !== 'string') return false;
    return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Validate an EVM address (checksum-aware)
 *
 * @param {string} address - Address to validate
 * @returns {string|null} Checksummed address if valid, null otherwise
 */
export function validateEvmAddress(address) {
    try {
        return ethers.getAddress(address);
    } catch {
        return null;
    }
}

/**
 * Get ETH balance for an EVM wallet address
 *
 * @param {string} walletAddress - EVM wallet address (0x...)
 * @returns {Promise<string>} Balance in ETH, formatted to 6 decimal places
 */
export async function getEvmBalance(walletAddress) {
    if (!walletAddress || !isEvmWallet(walletAddress)) {
        throw new Error('Invalid EVM wallet address');
    }

    try {
        const provider = getProvider();
        const balance = await provider.getBalance(walletAddress);
        return ethers.formatEther(balance);
    } catch (error) {
        throw new Error(`Failed to get ETH balance for ${walletAddress}: ${error.message}`);
    }
}

/**
 * Fetch all active Uniswap V3 and V4 LP positions for an EVM wallet.
 *
 * V3: uses ERC721Enumerable (tokenOfOwnerByIndex) and the positions() query.
 *     Only positions with liquidity > 0 are returned.
 * V4: uses Transfer event scanning from the deployment block (V4 does not
 *     implement ERC721Enumerable), followed by ownerOf() verification.
 *
 * @param {string} walletAddress - EVM wallet address (0x...)
 * @returns {Promise<Array<{tokenId: string, token0: string, token1: string, token0Symbol: string, token1Symbol: string, version: string, poolLabel: string}>>}
 */
export async function getEvmUniswapPositions(walletAddress) {
    if (!walletAddress || !isEvmWallet(walletAddress)) {
        throw new Error('Invalid EVM wallet address');
    }

    const provider = getProvider();
    const positions = [];

    // --- Uniswap V3 ---
    try {
        const v3Contract = new ethers.Contract(
            EVM_CONTRACTS.UNISWAP_V3_POSITION_MANAGER,
            UNISWAP_V3_POSITION_ABI,
            provider
        );
        const v3Factory = new ethers.Contract(
            EVM_CONTRACTS.UNISWAP_V3_FACTORY,
            UNISWAP_V3_FACTORY_ABI,
            provider
        );

        const balance = await v3Contract.balanceOf(walletAddress);
        const count = Number(balance);

        for (let i = 0; i < count; i++) {
            try {
                const tokenId = await v3Contract.tokenOfOwnerByIndex(walletAddress, i);
                const pos = await v3Contract.positions(tokenId);

                // Skip positions with no liquidity
                if (pos.liquidity === 0n) continue;

                const token0Symbol = getEvmTokenSymbol(pos.token0);
                const token1Symbol = getEvmTokenSymbol(pos.token1);

                // Check if position is in range by comparing current pool tick
                let inRange = false;
                try {
                    const poolAddress = await v3Factory.getPool(pos.token0, pos.token1, pos.fee);
                    const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_SLOT0_ABI, provider);
                    const slot0 = await pool.slot0();
                    const currentTick = Number(slot0.tick);
                    inRange = currentTick >= Number(pos.tickLower) && currentTick <= Number(pos.tickUpper);
                } catch (tickErr) {
                    console.warn(`⚠️ Could not determine V3 in-range status for tokenId ${tokenId}:`, tickErr.message);
                }

                positions.push({
                    tokenId: tokenId.toString(),
                    token0: pos.token0,
                    token1: pos.token1,
                    token0Symbol,
                    token1Symbol,
                    version: 'V3',
                    inRange,
                    poolLabel: `${token0Symbol}/${token1Symbol} V3`
                });
            } catch (err) {
                console.warn(`⚠️ Error reading V3 position at index ${i}:`, err.message);
            }
        }
    } catch (err) {
        console.warn('⚠️ Error fetching Uniswap V3 positions:', err.message);
    }

    // --- Uniswap V4 ---
    // V4 does not implement ERC721Enumerable. We use Alchemy's NFT API to fetch
    // all token IDs owned by the wallet for the V4 PositionManager in one call.
    try {
        // Extract Alchemy API key from the RPC URL
        // Expected format: https://eth-mainnet.g.alchemy.com/v2/<apiKey>
        const alchemyApiKey = env.ETH_RPC_URL?.split('/').pop();
        if (!alchemyApiKey) throw new Error('Could not extract Alchemy API key from ETH_RPC_URL');

        const nftApiUrl = `https://eth-mainnet.g.alchemy.com/nft/v3/${alchemyApiKey}/getNFTsForOwner` +
            `?owner=${walletAddress}&contractAddresses[]=${EVM_CONTRACTS.UNISWAP_V4_POSITION_MANAGER}&withMetadata=false`;

        const nftResponse = await fetch(nftApiUrl);
        if (!nftResponse.ok) throw new Error(`Alchemy NFT API error: ${nftResponse.status}`);
        const nftData = await nftResponse.json();

        const ownedNfts = nftData.ownedNfts ?? [];
        if (ownedNfts.length === 0) {
            return positions;
        }

        const v4Contract = new ethers.Contract(
            EVM_CONTRACTS.UNISWAP_V4_POSITION_MANAGER,
            UNISWAP_V4_POSITION_ABI,
            provider
        );

        const v4StateView = new ethers.Contract(
            EVM_CONTRACTS.UNISWAP_V4_STATE_VIEW,
            UNISWAP_V4_STATE_VIEW_ABI,
            provider
        );

        for (const nft of ownedNfts) {
            const tokenIdStr = BigInt(nft.tokenId).toString();
            try {
                // Skip burned / empty positions
                const liquidity = await v4Contract.getPositionLiquidity(BigInt(tokenIdStr));
                if (liquidity === 0n) continue;

                const [poolKey, info] = await v4Contract.getPoolAndPositionInfo(BigInt(tokenIdStr));
                const token0Symbol = getEvmTokenSymbol(poolKey.currency0);
                const token1Symbol = getEvmTokenSymbol(poolKey.currency1);

                // Decode tickLower / tickUpper from the packed PositionInfo uint256.
                // Layout (PositionInfoLibrary.sol):
                //   bits 0-7   = hasSubscriber
                //   bits 8-31  = tickLower (int24)
                //   bits 32-55 = tickUpper (int24)
                const infoBig = BigInt(info);
                const rawLower = Number((infoBig >> 8n) & 0xFFFFFFn);
                const rawUpper = Number((infoBig >> 32n) & 0xFFFFFFn);
                const tickLower = rawLower >= 0x800000 ? rawLower - 0x1000000 : rawLower;
                const tickUpper = rawUpper >= 0x800000 ? rawUpper - 0x1000000 : rawUpper;

                // Compute V4 PoolId = keccak256(abi.encode(poolKey))
                const poolId = ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ['address', 'address', 'uint24', 'int24', 'address'],
                        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
                    )
                );

                let inRange = false;
                try {
                    const slot0 = await v4StateView.getSlot0(poolId);
                    const currentTick = Number(slot0.tick);
                    inRange = currentTick >= tickLower && currentTick <= tickUpper;
                } catch (tickErr) {
                    console.warn(`⚠️ Could not determine V4 in-range status for tokenId ${tokenIdStr}:`, tickErr.message);
                }

                positions.push({
                    tokenId: tokenIdStr,
                    token0: poolKey.currency0,
                    token1: poolKey.currency1,
                    token0Symbol,
                    token1Symbol,
                    version: 'V4',
                    inRange,
                    poolLabel: `${token0Symbol}/${token1Symbol} V4`
                });
            } catch (err) {
                console.warn(`⚠️ Error reading V4 position tokenId ${tokenIdStr}:`, err.message);
            }
        }
    } catch (err) {
        console.warn('⚠️ Error fetching Uniswap V4 positions:', err.message);
    }

    return positions;
}
