#!/usr/bin/env bash
# The whole answer in a window, for a left click on the tray icon.
#
# The menu is for doing something; this is for reading. It is the same text the
# command prints, in a window, because a second wording of the same facts is a
# second thing to keep true.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXT="$(timeout 20 "${NODE:-/usr/bin/node}" "$HERE/../relay.ts" status 2>&1)"
printf '%s\n' "$TEXT" | yad --text-info --title="Relay" --width=760 --height=340 \
  --fontname="Monospace 10" --wrap --button="Close:0" --center 2>/dev/null || true
