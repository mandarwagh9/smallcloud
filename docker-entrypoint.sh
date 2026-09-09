#!/bin/sh
# Enforce the file modes the isolation story depends on, then start the server.
set -e

DATA="${SC_DATA_DIR:-/data}"
mkdir -p "$DATA/apps"

# App processes run as SC_APP_UID. They must be able to reach their own directories,
# but never the platform database. See SECURITY.md.
if [ -n "$SC_APP_UID" ]; then
  chown -R "$SC_APP_UID:${SC_APP_GID:-$SC_APP_UID}" "$DATA/apps"
  chmod 711 "$DATA"
  [ -f "$DATA/platform.db" ] && chmod 600 "$DATA/platform.db"
  for f in "$DATA"/platform.db-wal "$DATA"/platform.db-shm; do
    [ -f "$f" ] && chmod 600 "$f"
  done
fi

exec "$@"
