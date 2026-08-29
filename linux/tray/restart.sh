#!/usr/bin/env bash
# Stop the tray if one is running, and start a fresh one.
#
# By the pid it wrote down, never by a pattern: a pattern that names this script
# also names the shell that runs it, and the starter kills itself. That happened
# twice before this file existed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="${XDG_RUNTIME_DIR:-/tmp}/claude-relay-tray.pid"

if [ -f "$PIDFILE" ]; then
  OLD="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null
    for _ in $(seq 1 10); do kill -0 "$OLD" 2>/dev/null || break; sleep 1; done
    kill -9 "$OLD" 2>/dev/null
  fi
  rm -f "$PIDFILE"
fi

exec setsid "$HERE/relay-tray.sh"
