#!/usr/bin/env bash
# What the applications menu runs.
#
# Two things, because somebody opening this from a menu wants both: the icon back
# in the panel if it is missing, and something to read now. The tray is a service,
# so asking that service is right; starting a second one by hand is not.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The unit to wake, handed over by the applications entry that runs this. One
# relay per Desktop folder means one tray unit each (ADR 0012), and a name spelled
# here as well would be the wrong one for every relay but the first.
UNIT="${1:-claude-relay-tray}"
systemctl --user start "$UNIT" 2>/dev/null || "$HERE/restart.sh" &
exec "$HERE/status-window.sh"
