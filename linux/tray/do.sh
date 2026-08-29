#!/usr/bin/env bash
# One click from the tray menu: run the command, then wake the tray so what it
# shows catches up at once. A click that appears to do nothing for twenty seconds
# gets clicked again, and the second click is the one nobody meant.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${NODE:-/usr/bin/node}" "$HERE/../relay.ts" "$@" >>"${RELAY_TRAY_LOG:-/dev/null}" 2>&1
[ -n "${RELAY_TRAY_POKE:-}" ] && : > "$RELAY_TRAY_POKE"
exit 0
