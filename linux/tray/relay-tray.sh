#!/usr/bin/env bash
# The relay in the notification area, so switching Seats is a click.
#
# `yad --notification --listen` is the whole of the graphical part: it draws one
# icon in the panel's notification area and reads commands on standard input, so
# this is a loop that says what the icon should look like and what its menu should
# hold. No toolkit code, no window, nothing to keep alive but a pipe.
#
# The menu is rebuilt on every tick because what it says changes: which Seat is
# paying, how much room each one has left, and whether the mechanism is up.
#
# Nothing here decides anything. `state.ts` says which of the four icons to draw
# and which unit to restart, and this reads what it says: the icon used to be
# worked out again from three of these fields, which gave the panel three states
# where the relay has four and let the panel and the relay disagree.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- find the screen to draw on -------------------------------------------------
# Supervised rather than started by hand, so this cannot assume it inherited a
# desktop session. It finds one, and refuses when there is none rather than
# drawing nowhere: exiting non-zero is what tells the supervisor to try again in a
# few seconds, which is how the icon reappears by itself after a reconnect.
#
# Only this user's own displays are ever considered, and only from 150 up. The
# socket has to be owned by whoever is running this, because on a machine other
# people are logged into their X sockets sit in the same directory, and attaching
# to one of theirs would put our icon in somebody else's panel.
if [ -z "${DISPLAY:-}" ] || [ ! -e "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
  FOUND=""
  for socket in $(ls -t /tmp/.X11-unix/X* 2>/dev/null); do
    n="${socket##*/X}"
    case "$n" in ''|*[!0-9]*) continue ;; esac
    [ "$n" -ge 150 ] || continue
    [ "$(stat -c %U "$socket" 2>/dev/null)" = "$(id -un)" ] || continue
    FOUND=":$n"
    break
  done
  if [ -z "$FOUND" ]; then
    echo "no display of ours is open yet, so there is no panel to sit in" >&2
    exit 1
  fi
  export DISPLAY="$FOUND"
fi

: "${XAUTHORITY:=$HOME/.Xauthority}"
export XAUTHORITY
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR
: "${DBUS_SESSION_BUS_ADDRESS:=unix:path=$XDG_RUNTIME_DIR/bus}"
export DBUS_SESSION_BUS_ADDRESS
# -------------------------------------------------------------------------------
RELAY="$HERE/../relay.ts"
STATE="$HERE/state.ts"
NODE="${NODE:-/usr/bin/node}"
# Every wait has a ceiling, including this one: a tick that hangs would freeze
# the menu on a stale answer with no sign that it is stale.
TICK="${RELAY_TRAY_TICK:-20}"
AT_MOST=15

# How many Seats to offer. The macOS tray offers a handful on purpose: a system
# menu is not a place for a table, and a Seat list in a panel menu is a table.
OFFER=6

# One tray, whatever happens. The autostart entry runs this at login and a person
# may well run it by hand as well, and two icons that disagree by a tick is the
# kind of thing that makes somebody stop trusting the one number they came for.
LOCK="${XDG_RUNTIME_DIR:-/tmp}/claude-relay-tray.lock"
PIDFILE="${XDG_RUNTIME_DIR:-/tmp}/claude-relay-tray.pid"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "a tray is already running; this one is not needed" >&2
  exit 0
fi
# Written so that restarting this can be "kill what the file names" rather than
# "kill whatever matches a pattern". Twice now, a pattern that named this script
# also named the shell that was starting it, and the starter killed itself.
printf '%s\n' "$$" > "$PIDFILE"

# The folder this relay keeps its own files in, read the way `bin/claude-desktop-relayed`
# reads it. A shell cannot import `home.folder`, and a second relay writes under
# its own home rather than over the first one's.
RELAY_HOME="${CLAUDE_RELAY_HOME:-$HOME/.claude-desktop-relay}"

# Drawn once, and named by absolute path from here on: see icons.sh for why a
# theme icon name is not usable on this machine.
ICONS="${RELAY_TRAY_ICONS:-$RELAY_HOME/icons}"
"$HERE/icons.sh" "$ICONS" || true

FIFO="$(mktemp -u "${XDG_RUNTIME_DIR:-/tmp}/claude-relay-tray.XXXXXX")"
mkfifo -m 600 "$FIFO"
cleanup() { rm -f "$FIFO" "$PIDFILE"; [ -n "${YAD_PID:-}" ] && kill "$YAD_PID" 2>/dev/null; }
trap cleanup EXIT INT TERM

# A left click reads, a right click acts. Both are the shape a person expects of
# a tray icon, and neither needs the other.
yad --notification --listen --no-middle --text="Relay" --command="$HERE/status-window.sh" < "$FIFO" &
YAD_PID=$!
exec 3>"$FIFO"

# Every menu item goes through `do.sh`, which runs the command and then wakes this
# loop, so a click is reflected at once rather than at the end of the tick it
# landed in. The variables it needs are exported, because yad runs those commands
# in a shell of its own.
export RELAY_TRAY_POKE="$FIFO.poke"
export RELAY_TRAY_LOG="${RELAY_TRAY_LOG:-$RELAY_HOME/tray.log}"
export NODE
DO="$HERE/do.sh"

say() { printf '%s\n' "$1" >&3; }

while :; do
  STATE_TEXT="$(timeout "$AT_MOST" "$NODE" "$STATE" 2>/dev/null)"

  if [ -z "$STATE_TEXT" ]; then
    say "icon:$ICONS/broken.png"
    say "tooltip:Relay: cannot read its own state"
    # "Try again" read the state again for real. It was bound to the shell builtin
    # `true`, so the one item offered in the one state a person needs an item did
    # nothing at all: the menu closed and the panel sat on the same answer for the
    # rest of the tick. `do.sh` runs the command, writes what it said to the tray
    # log, and wakes this loop, so the answer is redrawn at once and there is a
    # trace of why it failed.
    say "menu:Try again!$DO status|Quit Relay tray!quit"
    sleep "$TICK"
    continue
  fi

  MODE="$(awk -F'\t' '$1=="mode"{print $2}' <<<"$STATE_TEXT")"
  REFRESHED="$(awk -F'\t' '$1=="refreshed"{print $2}' <<<"$STATE_TEXT")"
  PAYING="$(awk -F'\t' '$1=="paying"{print $2}' <<<"$STATE_TEXT")"
  ROOM="$(awk -F'\t' '$1=="paying"{print $3}' <<<"$STATE_TEXT")"
  WORKING="$(awk -F'\t' '$1=="working"{print $2}' <<<"$STATE_TEXT")"
  WINDOW="$(awk -F'\t' '$1=="window"{print $2}' <<<"$STATE_TEXT")"
  ICON="$(awk -F'\t' '$1=="icon"{print $2}' <<<"$STATE_TEXT")"
  RELAYING="$(awk -F'\t' '$1=="relaying"{print $2}' <<<"$STATE_TEXT")"
  UNIT="$(awk -F'\t' '$1=="service"{print $2}' <<<"$STATE_TEXT")"
  SEATS="$(awk -F'\t' '$1=="seat"' <<<"$STATE_TEXT")"

  # The relay's own answer, not a second opinion. The four names are its `Icon`
  # type and the drawings are named after them, so adding a state is a drawing and
  # a name and nothing here. Anything else means the two sides no longer agree
  # about what the states are, which is worth drawing as broken rather than
  # guessing at.
  case "$ICON" in
    on|strained|off|broken) ;;
    *) ICON="broken" ;;
  esac
  say "icon:$ICONS/$ICON.png"

  # The whole summary without a click, on one line because the pipe reads one
  # command per line. Two facts the other two trays put in headings live here
  # instead, for the reason the menu below has no headings at all: which Claude
  # Desktop these figures are about (ADR 0014), and that picking a Seat sets
  # Manual. A menu that changes the Mode without saying so changes it behind the
  # reader's back.
  if [ "$PAYING" = "-" ]; then
    TIP="Relay: off, the Window account is paying"
  else
    TIP="$PAYING is paying. $ROOM"
  fi
  [ -n "$RELAYING" ] && TIP="$TIP · Relaying $RELAYING"
  [ -n "$SEATS" ] && TIP="$TIP · Picking a Seat sets Manual"
  say "tooltip:$TIP"

  # yad separates items with | and a label from its command with !, so neither
  # may appear in a label. Seat names and percentages never do.
  #
  # No heading items. The first version opened with "Paying now: <seat>" and
  # "Mode: <mode>", and the first thing a pointer does on entering a menu is
  # select the top item, which drew that line as blue text on a blue highlight:
  # the one line somebody opened the menu to read was the one they could not.
  # Both facts are still here, in the places that suit them. The tick says which
  # Seat is paying and which mode is on, the tooltip says it without a click, and
  # a left click opens the whole screen in a window.
  #
  # Labels are kept short for the same reason. The five-hour figure and the age of
  # the reading are gone from here: the week is what decides which Seat to move
  # to, and the rest is on the screen a left click opens.
  tick() { [ "$1" = "yes" ] && printf '\xe2\x9c\x93 ' || printf '   '; }

  # When the mechanism is down, the first thing in the menu is the thing that
  # fixes it. An icon that can only tell you something is broken is an alarm; the
  # point of putting it in the panel is that the answer is in the same place as
  # the news.
  MENU=""
  if [ "$WORKING" != "yes" ]; then
    MENU="Start the relay!systemctl --user restart ${UNIT:-claude-relay}|"
  fi

  # The three Modes, in the order the macOS and Windows trays draw them, and all
  # three of them: this menu offered Auto and Off only, so the one machine where a
  # Seat could be pinned by hand was the one where the menu could not say so.
  MENU="$MENU$(tick "$([ "$MODE" = auto ] && echo yes || echo no)")Auto!$DO auto"
  MENU="$MENU|$(tick "$([ "$MODE" = manual ] && echo yes || echo no)")Manual!$DO manual"
  MENU="$MENU|$(tick "$([ "$MODE" = off ] && echo yes || echo no)")Off!$DO off"

  # Six rows in all, which is `AT_MOST_SEATS` in src/tray/internal/menu.ts and what
  # the other two trays draw. This took the Seat that is paying and then six more,
  # so the one menu of the three that could show seven did.
  #
  # The Seat that is paying goes first and is always in the list, whatever its
  # size: a menu that shows six Seats and not the one with the tick beside it is a
  # menu that cannot answer "switch away from this".
  MINE="$(awk -F'\t' '$5=="yes"' <<<"$SEATS")"
  OTHERS="$(awk -F'\t' '$5!="yes"' <<<"$SEATS")"
  OFFERED="$(printf '%s\n%s\n' "$MINE" "$OTHERS" | sed '/^$/d' | head -"$OFFER")"

  while IFS=$'\t' read -r _ name plan room paying; do
    [ -n "$name" ] || continue
    # Shown exactly as it arrives. This used to pick the weekly figure back out of
    # the line with a regular expression, which is how "7d 1%" ended up in a menu
    # meaning something other than what it looked like. The one place that decides
    # how room is worded is src/control/internal/room.ts.
    MENU="$MENU|$(tick "$paying")$name · $plan    $room!$DO use $name"
  done <<<"$OFFERED"

  # Claude Desktop, then the way to the whole screen, then leaving: the same tail
  # the other two trays have. Said as what it is when it is closed, because
  # "Open Claude Desktop" on a Window that is already open answers nothing.
  if [ "$WINDOW" = "closed" ]; then
    MENU="$MENU|   Claude Desktop is closed, open it!$DO launch"
  else
    MENU="$MENU|   Open Claude Desktop!$DO launch"
  fi
  # When these figures were read. Every number above is a reading from an earlier
  # moment, and a panel that never dates itself looks equally current an hour on.
  # `true` and not a command: this row is a date, not a thing to do. Clicking it
  # closes the menu and changes nothing, which is what a person expects of a label
  # in a menu that has no labels.
  [ -n "$REFRESHED" ] && MENU="$MENU|   $REFRESHED!true"
  MENU="$MENU|   Open Relay…!$HERE/status-window.sh"
  MENU="$MENU|   Quit Relay tray!quit"
  say "menu:$MENU"

  # Woken early by an action, so a click is reflected at once rather than at the
  # end of the tick it landed in.
  for _ in $(seq 1 "$TICK"); do
    sleep 1
    if [ -e "$FIFO.poke" ]; then rm -f "$FIFO.poke"; break; fi
  done

  # The icon is gone when yad is gone, and yad goes when the panel restarts or the
  # session ends. Leaving is the right move: a loop still talking into a dead pipe
  # is a tray nobody can see, and the supervisor will have a fresh one drawing
  # within seconds. This is why the icon came back after a reconnect and the first
  # version did not.
  if ! kill -0 "$YAD_PID" 2>/dev/null; then
    echo "the icon is gone (yad exited), leaving so a fresh one is started" >&2
    exit 1
  fi
done
