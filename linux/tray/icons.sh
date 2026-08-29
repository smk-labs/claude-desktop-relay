#!/usr/bin/env bash
# The tray icon, drawn rather than named.
#
# A name would be the ordinary way, and it does not work here: the desktop's
# active icon theme is not installed on this machine, so GTK resolves almost
# nothing and draws a grey placeholder instead. Ours are drawn with the drawing
# tool the box already has, so they depend on no theme and no image delegate.
#
# The shape is the one the design settled on: a patch cord, two dots and a short
# cord between them, carrying the state by shape as well as colour, because
# colour alone is unreliable on a light or a dark panel and for some eyes.
#
#   on        the cord is joined, full thickness, green   a Seat is paying
#   strained  the cord is joined and drawn thin, amber    that Seat is running out
#   off       the cord is apart, grey                     the Window account is paying
#   broken    the cord is severed, red                    the mechanism is not working
#
# Four, not three, because the relay has four states and the panel had three: a
# Seat past three quarters of its week drew the same icon as a fresh one, so the
# icon said all was well until the request that was refused. `strained` is joined
# like `on` and thinned rather than parted, which is the shape a cord under strain
# has and is not the shape of either of the two broken states.
set -euo pipefail

# The folder this relay keeps its own files in, read the way `bin/claude-desktop-relayed`
# reads it. A shell cannot import `home.folder`, and a second relay draws its icons
# under its own home rather than over the first one's.
OUT="${1:-${CLAUDE_RELAY_HOME:-$HOME/.claude-desktop-relay}/icons}"
mkdir -p "$OUT"

# Redrawn only when missing: four drawings per tray tick would be silly, and a
# drawing that never changes has nothing to catch up with.
[ -f "$OUT/on.png" ] && [ -f "$OUT/strained.png" ] && [ -f "$OUT/off.png" ] && [ -f "$OUT/broken.png" ] && exit 0

dot() { echo "circle $1,11 $1,8"; }

convert -size 22x22 xc:none \
  -fill "#3fa46a" -draw "$(dot 5)" -draw "$(dot 17)" \
  -stroke "#3fa46a" -strokewidth 3 -draw "line 5,11 17,11" \
  "$OUT/on.png"

# Joined, and thinned to a thread in the middle: the cord is still carrying, and
# it is the shape rather than the amber that says it is about to stop.
convert -size 22x22 xc:none \
  -fill "#d08a2f" -draw "$(dot 5)" -draw "$(dot 17)" \
  -stroke "#d08a2f" -strokewidth 3 -draw "line 5,11 9,11" -draw "line 13,11 17,11" \
  -strokewidth 1 -draw "line 9,11 13,11" \
  "$OUT/strained.png"

convert -size 22x22 xc:none \
  -fill "#8a8a8a" -draw "$(dot 5)" -draw "$(dot 17)" \
  -stroke "#8a8a8a" -strokewidth 3 -draw "line 5,11 8,11" -draw "line 14,11 17,11" \
  "$OUT/off.png"

convert -size 22x22 xc:none \
  -fill "#c8452f" -draw "$(dot 5)" -draw "$(dot 17)" \
  -stroke "#c8452f" -strokewidth 3 -draw "line 5,11 9,11" -draw "line 13,11 17,11" \
  -strokewidth 2 -draw "line 9,7 13,15" \
  "$OUT/broken.png"
