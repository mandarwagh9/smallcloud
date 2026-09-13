#!/usr/bin/env bash
# Restore a smallcloud data directory from a backup made by scripts/backup.sh.
#
#   ./scripts/restore.sh smallcloud-<stamp>.tar.gz /data
#
# Stop the server first. This replaces the data directory rather than merging into it: a live
# or crashed server leaves platform.db-wal / app.db-wal (and -shm) beside the databases, and
# extracting clean snapshots on top of them would let the stale journals apply and corrupt or
# undo the restore. So the old directory is moved aside and the archive is extracted into an
# empty one.
set -euo pipefail

ARCHIVE="${1:?usage: restore.sh <archive.tar.gz> <data-dir>}"
DATA_DIR="${2:?usage: restore.sh <archive.tar.gz> <data-dir>}"
[ -f "$ARCHIVE" ] || { echo "no such archive: $ARCHIVE" >&2; exit 1; }

if pgrep -f 'dist/cli.js serve' >/dev/null 2>&1 || pgrep -f 'cli.ts serve' >/dev/null 2>&1; then
  echo "a smallcloud server appears to be running; stop it before restoring" >&2
  exit 1
fi

if [ -e "$DATA_DIR" ]; then
  ASIDE="${DATA_DIR%/}.old-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "moving existing data dir aside -> $ASIDE"
  mv "$DATA_DIR" "$ASIDE"
fi
mkdir -p "$DATA_DIR"
tar -xzf "$ARCHIVE" -C "$DATA_DIR"

# Belt and braces: the archive should contain no journals, but never restore one.
find "$DATA_DIR" -name '*.db-wal' -delete
find "$DATA_DIR" -name '*.db-shm' -delete

# The restored files are owned by whoever ran this (root); drop the ownership marker so the
# server re-chowns the tree to the app user once on its next start (see runtime handOverDataDir).
find "$DATA_DIR" -name '.sc-owned' -delete

echo "restored $ARCHIVE into $DATA_DIR"
echo "start the server; if all is well you can remove the aside copy."
