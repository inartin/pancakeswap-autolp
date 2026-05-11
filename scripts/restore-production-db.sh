#!/bin/bash
# Restore production database after testing
# Usage: bash scripts/restore-production-db.sh

echo "🔄 Restoring production database..."

# Check if production database exists
if [ ! -f "data/autofarmer.prod.db" ]; then
    echo "❌ Error: data/autofarmer.prod.db not found"
    echo "   Backup database is available at: data/autofarmer.backup.db"
    exit 1
fi

# Stop any running bot process (optional - user should stop manually)
echo "⚠️  Make sure bot is stopped before restoring!"
read -p "Press Enter to continue or Ctrl+C to cancel..."

# Remove test database
echo "🗑️  Removing test database..."
rm -f data/autofarmer.db data/autofarmer.db-shm data/autofarmer.db-wal

# Restore production database
echo "♻️  Restoring production database..."
mv data/autofarmer.prod.db data/autofarmer.db
mv data/autofarmer.prod.db-shm data/autofarmer.db-shm 2>/dev/null
mv data/autofarmer.prod.db-wal data/autofarmer.db-wal 2>/dev/null

echo "✅ Production database restored!"
echo ""
echo "📊 Database contents:"
sqlite3 data/autofarmer.db "SELECT COUNT(*) || ' users' FROM users; SELECT COUNT(*) || ' wallets' FROM wallets; SELECT COUNT(*) || ' positions' FROM positions;"

echo ""
echo "▶️  You can now run: pnpm dev"
