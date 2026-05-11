/**
 * Jupiter API Test
 *
 * Tests the Jupiter API utility functions and outputs raw JSON results.
 * This helps debug token data lookup from Jupiter's Lite API.
 *
 * Usage:
 *   node tests/jupiter-api.test.js [token_mint_address ...]
 *
 * Examples:
 *   node tests/jupiter-api.test.js 4qQeZ5LwSz6HuupUu8jCtgXyW1mYQcNbFAW1sWZp89HL
 *   node tests/jupiter-api.test.js So11111111111111111111111111111111111111112 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 *   node tests/jupiter-api.test.js --default
 */

import 'dotenv/config';
import { fetchTokensFromJupiter, fetchTokenFromJupiter } from '../src/utils/jupiter-api.util.js';

// Default test tokens
const DEFAULT_TEST_TOKENS = [
  '4qQeZ5LwSz6HuupUu8jCtgXyW1mYQcNbFAW1sWZp89HL', // CAKE
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'So11111111111111111111111111111111111111112',  // SOL (wrapped)
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'  // JUP
];

/**
 * Test fetching a single token
 */
async function testSingleToken(mintAddress) {
  console.log('\n=== Testing Single Token ===');
  console.log(`Mint Address: ${mintAddress}\n`);

  const startTime = Date.now();

  try {
    const result = await fetchTokenFromJupiter(mintAddress);
    const endTime = Date.now();

    const output = {
      test: 'single_token',
      success: result.success,
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
      test: 'single_token',
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
 * Test fetching multiple tokens in batch
 */
async function testBatchTokens(mintAddresses) {
  console.log('\n=== Testing Batch Token Fetch ===');
  console.log(`Mint Addresses (${mintAddresses.length}):`);
  mintAddresses.forEach((addr, idx) => {
    console.log(`  ${idx + 1}. ${addr}`);
  });
  console.log();

  const startTime = Date.now();

  try {
    const result = await fetchTokensFromJupiter(mintAddresses);
    const endTime = Date.now();

    const output = {
      test: 'batch_tokens',
      success: result.success,
      requested_count: mintAddresses.length,
      result,
      timing: {
        duration_ms: endTime - startTime,
        timestamp: new Date().toISOString()
      }
    };

    console.log(JSON.stringify(output, null, 2));

    // Summary table
    if (result.success && result.data.length > 0) {
      console.log('\n=== Token Summary ===\n');
      result.data.forEach((token, idx) => {
        console.log(`${idx + 1}. ${token.ticker} (${token.name})`);
        console.log(`   Mint: ${token.mintAddress}`);
        console.log(`   Price: $${token.usdPrice.toFixed(6)}`);
        console.log(`   Decimals: ${token.decimals}`);
        console.log(`   Verified: ${token.isVerified ? 'Yes' : 'No'}`);
        console.log();
      });
    }

  } catch (error) {
    const endTime = Date.now();

    const output = {
      test: 'batch_tokens',
      success: false,
      requested_count: mintAddresses.length,
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
 * Test error handling with invalid inputs
 */
async function testErrorHandling() {
  console.log('\n=== Testing Error Handling ===\n');

  const testCases = [
    {
      name: 'Invalid mint address',
      input: ['invalid_address_123'],
      expected: 'Should filter out invalid address'
    },
    {
      name: 'Empty array',
      input: [],
      expected: 'Should return error for empty input'
    },
    {
      name: 'Mixed valid and invalid',
      input: ['So11111111111111111111111111111111111111112', 'invalid'],
      expected: 'Should return valid token and report invalid address'
    },
    {
      name: 'Non-string input',
      input: [12345],
      expected: 'Should filter out non-string input'
    }
  ];

  const results = [];

  for (const testCase of testCases) {
    console.log(`Testing: ${testCase.name}`);
    console.log(`Expected: ${testCase.expected}`);

    const startTime = Date.now();

    try {
      const result = await fetchTokensFromJupiter(testCase.input);
      const endTime = Date.now();

      results.push({
        test_case: testCase.name,
        input: testCase.input,
        expected: testCase.expected,
        result_success: result.success,
        result_data_count: result.data.length,
        invalid_addresses: result.meta.invalidAddresses,
        error_code: result.error?.code || null,
        duration_ms: endTime - startTime
      });

      console.log(`✓ Success: ${result.success}`);
      console.log(`  Data returned: ${result.data.length} tokens`);
      console.log(`  Invalid addresses: ${result.meta.invalidAddresses.length}`);
      if (result.error) {
        console.log(`  Error code: ${result.error.code}`);
      }

    } catch (error) {
      const endTime = Date.now();

      results.push({
        test_case: testCase.name,
        input: testCase.input,
        expected: testCase.expected,
        result_success: false,
        exception: error.message,
        duration_ms: endTime - startTime
      });

      console.log(`✗ Exception: ${error.message}`);
    }

    console.log();
  }

  // Output summary
  const output = {
    test: 'error_handling',
    timestamp: new Date().toISOString(),
    total_cases: testCases.length,
    results
  };

  console.log('=== Error Handling Results ===\n');
  console.log(JSON.stringify(output, null, 2));
}

/**
 * Show usage examples
 */
function showHelp() {
  console.log('\n=== Jupiter API Test Usage ===\n');

  const examples = {
    description: 'Test Jupiter Lite API token data fetching',
    common_tokens: {
      CAKE: '4qQeZ5LwSz6HuupUu8jCtgXyW1mYQcNbFAW1sWZp89HL',
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      SOL: 'So11111111111111111111111111111111111111112',
      JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
    },
    usage: {
      single: 'node tests/jupiter-api.test.js <mint_address>',
      batch: 'node tests/jupiter-api.test.js <mint1> <mint2> <mint3> ...',
      default: 'node tests/jupiter-api.test.js --default',
      errors: 'node tests/jupiter-api.test.js --test-errors',
      help: 'node tests/jupiter-api.test.js --help'
    }
  };

  console.log(JSON.stringify(examples, null, 2));
  console.log();
}

// Main execution
(async () => {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  if (args[0] === '--default' || args[0] === '-d') {
    await testBatchTokens(DEFAULT_TEST_TOKENS);
    process.exit(0);
  }

  if (args[0] === '--test-errors' || args[0] === '-e') {
    await testErrorHandling();
    process.exit(0);
  }

  // Test single or batch
  if (args.length === 1) {
    await testSingleToken(args[0]);
  } else {
    await testBatchTokens(args);
  }

})();
