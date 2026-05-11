import { ethers } from 'ethers';

// ABIs - only the functions we need
const POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

const POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
];

// Contract addresses
const POOL_ADDRESS = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'; // USDC/WETH 0.05%
const POSITION_MANAGER_ADDRESS = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364'; // Uniswap V3 NFT Position Manager
const DEFAULT_PROVIDER_URL = "https://eth-mainnet.g.alchemy.com/v2/bMVPurpEvfIWz1HwF-040U4z8Dss355C";

// Uniswap V3: price ∝ 1.0001^tick. Range width % = (1.0001^tickSpan - 1) * 100
function lpRangeWidthPercent(tickLower, tickUpper) {
  const tickSpan = Number(tickUpper - tickLower);
  const priceRatio = Math.pow(1.0001, tickSpan);
  return Math.round((priceRatio - 1) * 10000) / 100;
}

async function checkPositionInRange(provider, tokenId) {
  // Initialize contracts
  const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider );
  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);

  // Read position data
  const position = await positionManager.positions(tokenId);
  const tickLower = position.tickLower;
  const tickUpper = position.tickUpper;
  const liquidity = position.liquidity;

  // Read current tick from pool
  const slot0 = await pool.slot0();
  const currentTick = slot0.tick;

  // Check if in range
  const inRange = currentTick >= tickLower && currentTick < tickUpper;

  // LP position range width: what % price range does this position span? (e.g. 8.5% = narrow, 50% = wide)
  const rangeWidthPercent = lpRangeWidthPercent(tickLower, tickUpper);

  // Where is price within the range: 0% = at lower, 100% = at upper
  const tickRange = Number(tickUpper - tickLower);
  const percentFromLower = tickRange === 0
    ? null
    : Math.round(((Number(currentTick) - Number(tickLower)) / tickRange) * 10000) / 100;
  const percentFromUpper = tickRange === 0
    ? null
    : Math.round(((Number(tickUpper) - Number(currentTick)) / tickRange) * 10000) / 100;

  return {
    inRange,
    rangeWidthPercent,   // LP range width in % (e.g. 8.54 for tickSpan 820)
    percentFromLower,   // 0% = at lower, 100% = at upper
    percentFromUpper,   // 0% = at upper, 100% = at lower
  };
}

// Usage example:
async function main() {
  // Add your RPC here
  const provider = new ethers.JsonRpcProvider(DEFAULT_PROVIDER_URL);
  
  const tokenId = 20902; // Your position token ID
  const result = await checkPositionInRange(provider, tokenId);
  
  console.log('Position Status:', JSON.stringify(result, null, 2));
  console.log('In Range:', result.inRange ? '✅ YES' : '❌ NO');
  console.log(`LP range: ${result.rangeWidthPercent}% `);
  if (result.percentFromLower != null) {
    console.log(`Price in range: ${result.percentFromLower}% from lower, ${result.percentFromUpper}% from upper`);
  }
}
main();
// Export for use in other modules
export { checkPositionInRange, lpRangeWidthPercent };