#!/usr/bin/env bash
# Consistent backup of a smallcloud data directory.
#
#   ./scripts/backup.sh /data /backups
#
# SQLite files are copied with VACUUM INTO so a running server cannot leave a
# half-written page in the archive. Everything else is copied as-is.
set -euo pipefail

DATA_DIR="${1:-${SC_DATA_DIR:-./data}}"
OUT_DIR="${2:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

[ -d "$DATA_DIR" ] || { echo "no such data dir: $DATA_DIR" >&2; exit 1; }
mkdir -p "$OUT_DIR" "$STAGE/apps"

snapshot() { # snapshot <src.db> <dest.db>
  if [ -f "$1" ]; then
    # Single-quote the path with '' escaping, the way src/api.ts does. JSON.stringify produced a
    # double-quoted argument, which SQLite treats as an identifier, and whose backslashes on
    # Windows became literal -- so VACUUM INTO threw and, under set -e, the whole backup aborted
    # before any archive was written.
    node --no-warnings -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      const dest = process.argv[2].split(\"'\").join(\"''\");
      db.exec(\"vacuum into '\" + dest + \"'\");
      db.close();
    " "$1" "$2"
  fi
}

echo "snapshotting platform database"
snapshot "$DATA_DIR/platform.db" "$STAGE/platform.db"

for app_dir in "$DATA_DIR"/apps/*/; do
  [ -d "$app_dir" ] || continue
  id="$(basename "$app_dir")"
  mkdir -p "$STAGE/apps/$id/data"
  echo "snapshotting app $id"
  snapshot "$app_dir/data/app.db" "$STAGE/apps/$id/data/app.db"
  [ -d "$app_dir/bundle" ] && cp -r "$app_dir/bundle" "$STAGE/apps/$id/bundle"
  [ -d "$app_dir/data/files" ] && cp -r "$app_dir/data/files" "$STAGE/apps/$id/data/files"
done

ARCHIVE="$OUT_DIR/smallcloud-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" .
echo "wrote $ARCHIVE"

# To restore, use scripts/restore.sh -- do NOT just extract over a live data dir. The archive's
# databases are clean snapshots with no -wal/-shm, but a running (or crashed) server leaves
# -wal/-shm beside the originals, and those stale journals would apply on top of the restored
# databases and corrupt or silently undo the restore.
#   ./scripts/restore.sh smallcloud-<stamp>.tar.gz /data
