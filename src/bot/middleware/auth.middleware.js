import { env } from '../../config/env.js';

/**
 * Middleware to check if user is authorized (admin only for now)
 *
 * @param {Object} msg - Telegram message object
 * @returns {boolean} True if authorized, false otherwise
 */
export function isAuthorized(msg) {
    const userId = msg.from.id;
    const adminId = env.TELEGRAM_ADMIN_ID;

    return userId === adminId;
}

/**
 * Wraps a handler function with authorization check
 * If user is not authorized, sends an error message and prevents handler execution
 *
 * @param {Function} handler - The handler function to protect
 * @returns {Function} Wrapped handler with auth check
 */
export function requireAuth(handler) {
    return async (bot, msg, ...args) => {
        if (!isAuthorized(msg)) {
            const chatId = msg.chat.id;
            await bot.sendMessage(
                chatId,
                '🚫 *Unauthorized*\n\nThis bot is currently in private mode. Only the admin can use it.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // User is authorized, execute the handler
        return handler(bot, msg, ...args);
    };
}

/**
 * Middleware function that can be used with bot.on()
 * Checks authorization and only calls next() if authorized
 *
 * @param {TelegramBot} bot - Bot instance
 * @param {Object} msg - Message object
 * @param {Function} next - Next middleware function
 */
export function authMiddleware(bot, msg, next) {
    if (isAuthorized(msg)) {
        next();
    } else {
        bot.sendMessage(
            msg.chat.id,
            '🚫 *Unauthorized*\n\nThis bot is currently in private mode. Only the admin can use it.',
            { parse_mode: 'Markdown' }
        );
    }
}
