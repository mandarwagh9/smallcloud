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
    node -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('vacuum into ' + JSON.stringify(process.argv[2]));
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

# Restore: stop the server, replace the data dir with the archive contents, start it.
#   tar -xzf smallcloud-<stamp>.tar.gz -C /data
