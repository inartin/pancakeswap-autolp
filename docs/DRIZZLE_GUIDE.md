# Database Schema Guide

This project uses Drizzle ORM with SQLite (development) and Postgres (production).

**`src/db/schema.js` is the source of truth.** All database changes are made by editing this file and generating migrations.

## Quick Start

### Changing the Schema

1. Edit `src/db/schema.js`
2. Run `pnpm db:generate`
3. **If you changed `wallets` or `terms_acceptance` tables:**
   - Update `src/db/postgres-schema.js` to match
   - Run `pnpm drizzle-kit generate --config=drizzle-postgres.config.js`
4. Commit all changed files

### Pulling Schema Changes

1. `git pull`
2. `pnpm dev` (migrations auto-apply)

## File Structure

```
src/db/
  ├── schema.js           # Source of truth (all tables, SQLite)
  ├── postgres-schema.js  # Postgres mirror (wallets + terms_acceptance only)
  ├── index.js            # SQLite connection
  └── postgres.js         # Postgres connection (production only)

drizzle/                  # SQLite migrations (auto-generated)
  ├── 0000_*.sql
  └── meta/

drizzle-postgres/         # Postgres migrations (auto-generated)
  ├── 0000_*.sql
  └── meta/

data/
  └── autofarmer.db       # SQLite database
```

## Schema Changes

### Changing Regular Tables (SQLite only)

**Example:** Adding a column to `positions`, `users`, etc.

1. Edit `src/db/schema.js`
2. Run `pnpm db:generate`
3. Done

### Changing Dual-Storage Tables (SQLite + Postgres)

**Applies to:** `wallets`, `terms_acceptance`

1. Edit `src/db/schema.js`
2. Update `src/db/postgres-schema.js` to match (convert types)
3. Generate both migrations:
   ```bash
   pnpm db:generate                                               # SQLite
   pnpm drizzle-kit generate --config=drizzle-postgres.config.js  # Postgres
   ```
4. Done

**Type conversion reference:**
```javascript
// SQLite (schema.js)
integer('id').primaryKey({ autoIncrement: true })
integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)

// Postgres (postgres-schema.js)
serial('id').primaryKey()
timestamp('created_at').defaultNow()
```

## Important Rules

- Always run `pnpm db:generate` after editing `src/db/schema.js`
- For `wallets` or `terms_acceptance` changes: also update `postgres-schema.js` and run Postgres migration
- Never manually edit files in `drizzle/` or `drizzle-postgres/` folders
- Always commit schema changes with their generated migrations
- Migrations auto-apply on app startup

## Troubleshooting

**Migration files out of sync**
```bash
pnpm db:generate
```

**Schema mismatch after pull**
```bash
pnpm dev  # Migrations auto-apply
```

**Conflicting migrations**
```bash
git pull
rm data/autofarmer.db  # Local only, never production
pnpm dev
```

## Viewing Data

**Drizzle Studio** (recommended)
```bash
pnpm db:studio
```

**SQLite CLI**
```bash
sqlite3 data/autofarmer.db
.tables
.schema positions
SELECT * FROM positions LIMIT 5;
.quit
```

## Reference

- **Drizzle Docs**: https://orm.drizzle.team/docs/migrations
- **Schema File**: `src/db/schema.js`
- **Migration Logic**: `src/db/index.js` (lines 45-58)
