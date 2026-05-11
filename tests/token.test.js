/**
 * Token Info Test
 *
 * Tests the getTokenInfo function and outputs raw JSON results.
 * This helps debug token price/ticker lookup issues.
 *
 * Usage:
 *   node tests/token.test.js [token_mint_address]
 *
 * Examples:
 *   node tests/token.test.js 4qQeZ5LwSz6HuupUu8jCtgXyW1mYQcNbFAW1sWZp89HL
 *   node tests/token.test.js So11111111111111111111111111111111111111112
 *   node tests/token.test.js EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 */

import 'dotenv/config';
import { getTokenInfo } from '../src/utils/token.util.js';

/**
 * Test a single token and output JSON
 */
async function testToken(mintAddress) {
  console.log('\n=== Testing Token ===');
  console.log(`Mint Address: ${mintAddress}\n`);

  const startTime = Date.now();

  try {
    const result = await getTokenInfo(mintAddress);
    const endTime = Date.now();

    const output = {
      success: true,
      mintAddress,
      result,
      timing: {
        duration_ms: endTime - startTime,
        timestamp: new Date().toISOString()
      }
    };

    console.log(JSON.stringify(output, null, 2));

  } catch (error) {
    const endTime = Date.now();

    const output = {
      success: false,
      mintAddress,
      error: {
        message: error.message,
        stack: error.stack
      },
      timing: {
        duration_ms: endTime - startTime,
        timestamp: new Date().toISOString()
      }
    };

    console.log(JSON.stringify(output, null, 2));
  }
}

/**
 * Test multiple tokens
 */
async function testMultipleTokens(mintAddresses) {
  console.log('\n=== Testing Multiple Tokens ===\n');

  const results = [];

  for (const mintAddress of mintAddresses) {
    const startTime = Date.now();

    try {
      const result = await getTokenInfo(mintAddress);
      const endTime = Date.now();

      results.push({
        success: true,
        mintAddress,
        result,
        timing: {
          duration_ms: endTime - startTime
        }
      });

    } catch (error) {
      const endTime = Date.now();

      results.push({
        success: false,
        mintAddress,
        error: {
          message: error.message
        },
        timing: {
          duration_ms: endTime - startTime
        }
      });
    }
  }

  const output = {
    timestamp: new Date().toISOString(),
    total_tested: results.length,
    results
  };

  console.log(JSON.stringify(output, null, 2));
}

/**
 * Show common test tokens
 */
function showExamples() {
  console.log('\n=== Common Test Tokens ===\n');

  const examples = {
    known_tokens: {
      SOL: 'So11111111111111111111111111111111111111112',
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    },
    problem_token: {
      description: 'Token with no trading pairs',
      address: '4qQeZ5LwSz6HuupUu8jCtgXyW1mYQcNbFAW1sWZp89HL'
    },
    popular_tokens: {
      BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
    }
  };

  console.log(JSON.stringify(examples, null, 2));
  console.log('\nUsage:');
  console.log('  node tests/token.test.js <mint_address>              - Test single token');
  console.log('  node tests/token.test.js <mint1> <mint2> ...         - Test multiple tokens');
  console.log('  node tests/token.test.js --examples                   - Show this help\n');
}

// Main execution
(async () => {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showExamples();
    process.exit(0);
  }

  if (args[0] === '--examples' || args[0] === '-e') {
    showExamples();
    process.exit(0);
  }

  // Test single or multiple tokens
  if (args.length === 1) {
    await testToken(args[0]);
  } else {
    await testMultipleTokens(args);
  }

})();
