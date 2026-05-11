# Development & Deployment

## Project Structure

```
autofarmer-sol/
├── src/                    # Application code
│   ├── bot/               # Telegram bot (handlers, formatters, middleware)
│   ├── cache/             # Redis / in-memory caches
│   ├── config/            # Configuration files
│   ├── db/                # Database (Drizzle ORM)
│   ├── idl/               # Anchor IDLs
│   ├── services/          # Business logic
│   ├── utils/             # Utility functions (Solana, EVM, formatting)
│   └── index.js           # Entry point
├── drizzle/               # SQLite migrations
├── drizzle-postgres/      # Postgres migrations
├── data/                  # SQLite database files (gitignored)
├── docs/                  # Documentation
├── scripts/               # Setup and maintenance scripts
├── tests/                 # Test files
├── playground/            # Experimental scripts and dashboards
├── screenshots/           # README assets
├── ecosystem.config.cjs   # PM2 configuration
└── run.sh                 # Convenience launcher
```

---

## Adding New Commands

1. Create a handler in `src/bot/handlers/`
2. Register it in `src/bot/index.js`
3. Update the help message in `src/bot/handlers/help.handler.js`

**Example:**

```javascript
// src/bot/handlers/mycommand.handler.js
export async function handleMyCommand(bot, msg) {
    // Your logic here
}

// src/bot/index.js
import { handleMyCommand } from './handlers/mycommand.handler.js';
bot.onText(/\/mycommand/, (msg) => handleMyCommand(bot, msg));
```

---

## Database Changes

Using Drizzle migrations:

1. Update schema in `src/db/schema.js`
2. Generate migration: `pnpm db:generate`
3. Commit the generated files in `drizzle/` to git
4. Migrations auto-apply on next bot startup
5. Add service functions in `src/services/` if needed

**Benefits:**

- Single source of truth (`schema.js`)
- Version-controlled migrations
- Auto-applies on startup
- No manual SQL

See [`DRIZZLE_GUIDE.md`](DRIZZLE_GUIDE.md) for more detail.

---

## Running Tests

```bash
node --test tests/
```

---

## Production Deployment

### Prerequisites

- Stable server / VPS
- Process manager (PM2 recommended)

### PM2 setup

```bash
# Install PM2
npm install -g pm2

# Start bot (ecosystem.config.cjs is included)
pm2 start ecosystem.config.cjs

# Or directly:
pm2 start src/index.js --name autofarmer-bot

# Save config and enable auto-start on reboot
pm2 save
pm2 startup
```

### Monitoring

```bash
pm2 logs autofarmer-bot
pm2 status
pm2 restart autofarmer-bot
```

---

## Troubleshooting

### Bot not responding

Check env variables:

```bash
cat .env | grep TELEGRAM_BOT_TOKEN
cat .env | grep TELEGRAM_ADMIN_ID
```

Verify token:

```bash
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe
```

Should return your bot's info.

### Database errors

Reset database (⚠️ deletes all local data):

```bash
rm -rf data/
# Restart — database auto-initializes
```

### "MASTER_PASSWORD must be at least 32 characters"

```bash
openssl rand -base64 32
```

Paste into `.env` as `MASTER_PASSWORD`.

### Polling error 409 (Conflict)

Another bot instance is running with the same token. Stop other instances or restart (the bot auto-clears webhooks on start).

### "Cannot find module" errors

```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

### Database locked errors

```bash
# Stop all bot instances first, then:
rm data/*.db-shm data/*.db-wal
```

### RPC rate limiting

Use Helius (recommended). Free tier is sufficient for most users.

---

## Contributing

1. Follow existing code patterns
2. Test thoroughly
3. Keep changes focused
