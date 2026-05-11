import 'dotenv/config';
import { validateEnv } from './config/env.js';
import { startBot } from './bot/index.js';
import { initializeRedis, closeRedis } from './cache/redis-cache.util.js';

/**
 * Main entry point - starts the Telegram bot server
 */
async function main() {
    try {
        console.log('🚀 Starting PancakeSwap Autofarmer Bot...\n');

        // Validate environment variables
        validateEnv();

        // Initialize Redis cache (optional - gracefully degrades if unavailable)
        try {
            initializeRedis();
        } catch (error) {
            console.warn('⚠️  Redis initialization failed, continuing without cache:', error.message);
        }

        // Start the Telegram bot (now async to handle webhook deletion)
        const bot = await startBot();

        console.log('✅ Bot is running and listening for commands\n');
        console.log('Available commands:');
        console.log('  /start  - Welcome message');
        console.log('  /help   - Show help');
        console.log('  /rewards <wallet_address> - Check rewards\n');

    } catch (error) {
        console.error('❌ Failed to start bot:', error.message);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down bot...');
    try {
        await closeRedis();
    } catch (error) {
        console.warn('⚠️  Error closing Redis:', error.message);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n👋 Shutting down bot...');
    try {
        await closeRedis();
    } catch (error) {
        console.warn('⚠️  Error closing Redis:', error.message);
    }
    process.exit(0);
});

// Start the bot
main();
