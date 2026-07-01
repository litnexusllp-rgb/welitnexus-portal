#!/usr/bin/env bash
# Downloads a dated backup of the LIT Nexus portal database to a local folder.
# Schedule this (cron on Mac/Linux, Task Scheduler on Windows via WSL/git-bash)
# to keep off-cloud copies of all your data — including invoices.
#
# Setup:
#   1. In Railway, set a BACKUP_TOKEN variable (a long random string).
#   2. Edit the two values below.
#   3. chmod +x scripts/backup.sh
#   4. Test:  ./scripts/backup.sh
#   5. Schedule daily, e.g. crontab -e:
#        0 2 * * *  /full/path/to/scripts/backup.sh   # every day at 2 AM
#
# Old backups older than KEEP_DAYS are pruned so the folder doesn't grow forever.

set -euo pipefail

# ---- edit these two ----
PORTAL_URL="https://welitnexus-portal-production.up.railway.app"   # your Railway URL
BACKUP_TOKEN="paste-your-BACKUP_TOKEN-here"
# ------------------------

DEST_DIR="${BACKUP_DIR:-$HOME/litnexus-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$DEST_DIR"
STAMP="$(date +%Y-%m-%d-%H%M)"
OUT="$DEST_DIR/litnexus-portal-$STAMP.db"

echo "Backing up to $OUT ..."
curl -fsS "$PORTAL_URL/api/backup?token=$BACKUP_TOKEN" -o "$OUT"

# Sanity check: a SQLite file starts with "SQLite format 3"
if head -c 16 "$OUT" | grep -q "SQLite format 3"; then
  echo "OK: $(du -h "$OUT" | cut -f1) saved."
else
  echo "ERROR: response was not a database file — check URL/token." >&2
  rm -f "$OUT"; exit 1
fi

# Prune old backups
find "$DEST_DIR" -name 'litnexus-portal-*.db' -type f -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true
