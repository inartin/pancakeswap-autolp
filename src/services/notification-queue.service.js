/**
 * Notification Queue Service
 *
 * Purpose: buffer and rate-limit Telegram sends to avoid hitting API limits
 * Defaults:
 * - Max 20 messages per second (batch of 20, then 1s delay)
 * - Retry up to 2 times with exponential backoff for transient errors
 */
export class NotificationQueueService {
    constructor(options = {}) {
        this.queue = [];
        this.processing = false;
        this.batchSize = options.batchSize ?? 20;
        this.intervalMs = options.intervalMs ?? 1000;
        this.maxRetries = options.maxRetries ?? 2;
        this.backoffBaseMs = options.backoffBaseMs ?? 500; // 0.5s, 1s
    }

    /**
     * Enqueue a message send task
     * @param {Function} sendFn async () => void - closure that executes the send
     */
    add(sendFn) {
        if (typeof sendFn !== 'function') return;
        this.queue.push({ sendFn, attempt: 0 });
        if (!this.processing) {
            void this.process();
        }
    }

    async process() {
        this.processing = true;
        try {
            while (this.queue.length > 0) {
                const batch = this.queue.splice(0, this.batchSize);
                await Promise.all(batch.map(item => this._execute(item)));
                if (this.queue.length > 0) {
                    await this._delay(this.intervalMs);
                }
            }
        } finally {
            this.processing = false;
        }
    }

    async _execute(item) {
        try {
            await item.sendFn();
        } catch (err) {
            // Retry transient errors
            if (item.attempt < this.maxRetries && this._isRetryable(err)) {
                item.attempt += 1;
                const backoff = this.backoffBaseMs * Math.pow(2, item.attempt - 1);
                await this._delay(backoff);
                // Re-enqueue at the front to retry soon
                this.queue.unshift(item);
            } else {
                // drop on permanent failure
            }
        }
    }

    _isRetryable(err) {
        // Telegram often signals 429/5xx as retryable. If we don't have structured error,
        // fallback to a conservative retry approach on network-like errors.
        const msg = String(err && err.message || err || '');
        if (msg.includes('ETELEGRAM') && /429|5\d\d/.test(msg)) return true;
        if (/timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg)) return true;
        return false;
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default NotificationQueueService;


