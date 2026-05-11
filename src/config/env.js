import 'dotenv/config';

/**
 * Validates required environment variables
 * Throws an error if any required variable is missing
 */
export function validateEnv() {
    const required = [
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_ADMIN_ID',
        'SOLANA_RPC_URL'
    ];

    // Require POSTGRES_URI in production
    if (process.env.NODE_ENV === 'production') {
        required.push('POSTGRES_URI');
    }

    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}\n` +
            `Please check your .env file or environment configuration.`
        );
    }

    // Validate TELEGRAM_ADMIN_ID is a number
    if (isNaN(parseInt(process.env.TELEGRAM_ADMIN_ID))) {
        throw new Error('TELEGRAM_ADMIN_ID must be a valid number (your Telegram user ID)');
    }

    // Warn if optional API keys are missing
    if (!process.env.JUP_API) {
        console.warn('⚠️  JUP_API not set - Jupiter Ultra swaps may hit rate limits without API key');
    }

    // Log Redis configuration status
    const useRedis = process.env.USE_REDIS === 'true' || process.env.USE_REDIS === '1';
    if (useRedis) {
        const redisHost = process.env.REDIS_HOST || 'localhost';
        const redisPort = process.env.REDIS_PORT || '6379';
        const redisDb = process.env.REDIS_DB || '0';
        console.log(`✅ Redis caching enabled: ${redisHost}:${redisPort} (DB: ${redisDb})`);
    } else {
        console.log('📦 Redis caching disabled (set USE_REDIS=true to enable)');
    }
}

/**
 * Get environment variables with defaults
 */
export const env = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_ADMIN_ID: parseInt(process.env.TELEGRAM_ADMIN_ID),
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    MASTER_PASSWORD: process.env.MASTER_PASSWORD,
    NODE_ENV: process.env.NODE_ENV || 'development',

    // Database configuration
    POSTGRES_URI: process.env.POSTGRES_URI,

    // Helius SWQOS configuration
    // Enable/disable SWQOS for improved transaction reliability (default: enabled)
    // SWQOS provides 95-99% success rates vs 40-70% with standard RPC
    // Cost: ~$0.0008 per transaction (~$0.0005 SWQOS tip + ~$0.0003 priority fee)
    USE_SWQOS: process.env.USE_SWQOS !== 'false', // Default: true (enabled)

    // EVM RPC configuration
    ETH_RPC_URL: process.env?.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com',

    // Redis cache configuration (optional - graceful degradation if not configured)
    // Caches static data (decimals, token programs, metadata) for 40-240x faster lookups
    // Reduces RPC calls and API costs significantly
    // Performance: Cache hit ~2-5ms vs RPC ~200ms (40x faster)
    USE_REDIS: process.env.USE_REDIS === 'true' || process.env.USE_REDIS === '1',
    REDIS_HOST: process.env.REDIS_HOST || 'localhost',
    REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379', 10),
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || null,
    REDIS_DB: parseInt(process.env.REDIS_DB || '0', 10)
};
