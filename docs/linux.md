# claude-desktop-relay on Linux

One Claude Desktop Window. Several of your own Claude subscriptions behind it.

Claude Code sessions started from Claude Desktop are paid for by the Seat you
choose. Command line and a tray icon, with no page. This is the smaller of the
three products and says so throughout: what is not here is listed at the end,
with the reason for each.

Everything that decides is the same code the other two machines run. The relay,
the ranking, the Payer, the usage memory, the verdict, the history, the journal,
the certificate and the Seat store all come from `src/` unchanged. That reuse is
the point rather than a convenience. The relay module carries the bound on how
many exchanges may be in the air at once, and the idle bound that closes reused
upstream connections, and those two are what stand between a Claude Code loop and
a connection pile-up. A Linux relay written fresh would have had to learn both
again.

## What you need

- Linux with a desktop session, and Claude Desktop installed under a root of its
  own (see below).
- **Node 24 or later.** No runtime dependencies at all.
- **`openssl`**, which mints the local certificate authority once.
- **`yad`** for the tray icon, if you want one. It is the only package this needs
  that a desktop machine may not already have (`apt install yad`, about 700KB,
  and nothing new of its own since GTK is already there).
- `systemd --user`, for the relay and the tray to start themselves.

### The isolated Claude Desktop, and why this port expects one

Claude Desktop on Linux is started here through a launcher under a root you name,
by default `~/desktop-trial`, and `CLAUDE_DESKTOP_TRIAL_ROOT` moves it. That root
holds the Window's Desktop folder, its Claude Code configuration and its own
launcher. The wrapper in `linux/bin/claude-desktop-relayed` adds exactly two
things to that launcher's environment and then gets out of the way: it does not
replace it, because the launcher underneath holds the display guard and the
`CLAUDE_CONFIG_DIR` isolation, and neither of those is this program's to
reimplement.

A second root is also how anything here is tried without touching the Window you
are actually using.

## Install it once

```bash
node linux/relay.ts trust            # the Window's own store learns the relay
node linux/relay.ts install-service  # the relay starts itself; the tray starts with the session
```

Then close Claude Desktop and open it again, once. The app reads its own store
when it starts, so a Window that was already running cannot be brought in. That is
the same rule as the other two machines,
[ADR 0009](adr/0009-everything-through-the-store.md).

An alias makes the daily question one word:

```bash
alias relay-linux='node /path/to/this/repo/linux/relay.ts'
```

## Using it

```bash
relay-linux                  # who is paying right now, and how much room it has
relay-linux seats            # every Seat and the room it has left
relay-linux auto             # let the Seat with the most room pay, weighed every request
relay-linux use <seat>       # pay with that Seat and hold it there
relay-linux manual           # hold the Seat that is picked, whatever the ranking says
relay-linux off              # leave everything on the Window account
relay-linux history          # every exchange a Seat paid for, and on which project
relay-linux refresh          # ask every Seat what it has spent, not just the stale ones
relay-linux launch           # open Claude Desktop pointed at the relay
relay-linux serve [port]     # run the relay in this terminal instead of as a service
relay-linux trust            # the Window's own store learns the relay
relay-linux install-service  # the relay starts itself, the tray with the session
relay-linux restore-seats    # put the Send tokens back from a backup
relay-linux help             # all of it
```

`relay-linux` with no arguments answers the daily question and exits non-zero when
the mechanism is broken, so the one word that asks it is also the health check.

This is a smaller command surface than the macOS `relay` on purpose. That one
carries install, uninstall, the doctor and the page, and a door with handles that
do nothing is worse than a smaller door.

The tests for this side are `node --test "linux/test/*.test.ts"`, from the
repository root. The shared engine's tests are `npm test`.

## Nobody has to remember anything

Three things had to be true for that sentence to hold, and each is a different
mechanism because each is a different job.

**The relay is up before anybody arrives.** A `systemd --user` service with
`Restart=always`, enabled with lingering on, so it is running after a reboot with
no session open. This matters more than it sounds. A Window whose Code sessions
are pointed at a relay that is not there fails every request, and nothing on
screen explains why. Killed with `kill -9`, it is back in two seconds, proved by
doing it.

```bash
systemctl --user status claude-relay
systemctl --user restart claude-relay     # after changing the code
```

The unit is named for the port it serves, so a second relay on a second Window
gets `claude-relay.<port>` and cannot quietly replace the first. That is
[ADR 0012](adr/0012-one-relay-serves-one-desktop-folder.md) enforced rather than
remembered. A relay on the default port keeps the plain name, so an install made
before this existed is untouched.

**Any way of opening Claude Desktop is relayed.** The relay's address is in the
Window's own store beside the certificate, and the app applies that store to every
Code session it starts, whatever started the app. So the desktop icon, a menu
entry, or a shortcut somebody made a month ago are all relayed. `relay-linux
launch` still exists and hands the address over at launch as well, but it is a
convenience now rather than the mechanism. The one rule that remains is the app's
own: it reads that store when it starts, so a Window that was already open when
the store changed has to be opened again. `relay-linux` says so by comparing the
two timestamps, rather than leaving it to be guessed.

**Switching is a click.** That is the tray.

## The tray

An icon in the notification area carrying the same four things the macOS menu
carries: which Seat is paying, a short list to switch to, the mode, and a way to
open the app.

- **Right click** is the menu: Auto, Off, and the Seats worth switching to with
  their weekly share. A tick marks the Seat that is paying and the mode that is
  on. The Seat that is paying is always in the list, whatever its size, because a
  menu that cannot show you what you are switching away from is half a menu.
- **Left click** opens the whole `relay-linux` screen in a window.
- **Hovering** says who is paying and how much room is left, with no click at all.
- When the mechanism is down, the first item in the menu is **Start the relay**.
  An icon that can only report a problem is an alarm. The point of being in the
  panel is that the answer sits in the same place as the news.

It is a `systemd --user` service of its own with `Restart=always`, and it also has
a name and a face in the applications menu. An autostart entry was the first
answer and it was the wrong one: it runs once at login, so the icon was gone for
good the moment the panel restarted or a remote session was reconnected. The tray
now finds its own display, never one belonging to another user of the machine, and
exits when its icon dies, which turns "keep trying" into the ordinary path.
Measured: kill the icon and it is back in a second, kill the whole tray and it is
back in five.

The icon is the patch cord from the design: two dots and a cord between them,
joined and green when a Seat is paying, joined but thinned to a thread and amber
when the Seat that is paying is running out, apart and grey when the Window
account is paying, severed and red when the mechanism is down. State by shape as
well as colour, because colour alone is unreliable on a light or a dark panel and
for some eyes.

Which of the four it is comes from the relay itself rather than being worked out
again in the panel, so the icon and the screen cannot disagree. An answer the
panel does not recognise draws the severed one, because a state nobody planned for
is a state to report and not one to guess at.

It is `yad --notification --listen`. Nothing else on a minimal desktop could draw
a tray icon reliably, which is also why the icons are drawn rather than named out
of an icon theme that may not be installed.

Two things in that script are scars rather than choices, and both are commented
where they live. The menu has no heading line, because the first version opened
with "Paying now: <seat>" and a pointer entering a menu selects the top item,
which drew the one line somebody opened the menu to read as blue text on a blue
highlight. And the tray is restarted by the pid it writes down, never by a
pattern, because a pattern that names the script also names the shell starting it,
and the starter killed itself twice before that was believed.

## How the certificate reaches a Code session

Through Claude Desktop's own encrypted environment store, the same as the other
machines, and the road to that answer is worth recording because the obvious
shortcut looks like it works.

The app builds its Code sessions' CA bundle from `tls.getCACertificates('default')`,
`('system')` and `('extra')`, and `'extra'` is `NODE_EXTRA_CA_CERTS`. So handing
the authority to the app at launch ought to land it inside the bundle the app
computes. Run against plain `node`, that is exactly what happens: 512 certificates
with ours among them, 511 without.

**The packaged Electron app does not see it.** Started with the variable set, the
app wrote its bundle with 485 certificates and ours absent, and its own status
read `NODE_EXTRA_CA_CERTS` as unset. Measured 2026-08-25. The plain-`node` result
is a true fact about Node and a misleading one about the app, which is the whole
trap: a test that passes for the wrong reason.

So the certificate goes where [ADR 0006](adr/0006-launch-env-for-proxy-store-for-the-certificate.md)
always put it, into the Window's own `ccd-environment-config.json`, which the app
applies last when it builds a Code session's environment, after its own computed
bundle. Two variables, and the second is not optional, because ours alone would
replace the app's bundle rather than add to it:

```
NODE_EXTRA_CA_CERTS   our authority
NODE_USE_SYSTEM_CA=1  and keep trusting the machine's own
```

`relay-linux trust` writes it, and `relay-linux launch` writes it for you before
starting the app.

The lock on that store is Chromium's Linux scheme, which is **not** the macOS one:
AES-128-CBC, salt `saltysalt`, a fixed initialisation vector, the `v11` prefix
that means the key came from the login keyring, and **one** derivation round
rather than 1003. One wrong number there produces a store the app cannot read and
does not complain about, so the key is never trusted, it is proved. Before
anything is written, `linux/internal/prove-store.ts` decrypts a value the app
itself encrypted, a cookie in its own profile, which Chromium locks with the same
key. Nothing of that value is read or kept; the only answer taken is yes or no.

The launcher hands over exactly one thing, the proxy address, in every case and
every scheme. Case matters and it is not a detail: the login shell exports the
lowercase names and HTTP clients read those first, so setting only `HTTPS_PROXY`
looks right in `env` output and silently does nothing.

The complete undo is to delete that one file and start Claude Desktop the ordinary
way.

## How room is said

```
s 8% · in 1h 57m   w 1% · in 6d 8h
```

`s` is the five-hour session and `w` is the week, session first because that is the
one that decides sooner. The percentage is **spent**, and the time is when that
window comes back. A window that has already turned over reads `fresh` rather than
`0%`, because zero means measured and this is not the same thing. A reading older
than an hour carries its age, and a fresh one does not: a timestamp on every row
is a texture the eye stops reading, and then the one row where it matters is
invisible too.

What this replaced was `5h 8%  7d 1%`, and it was wrong in three ways at once. It
never said whether the percentage was spent or left. It put a duration where the
window's *name* belonged, so `7d 1%` read as "one percent in seven days" rather
than "one percent of the week". And it never said when either window turns over,
which is the half of the answer that decides anything: a Seat at 90% that resets in
ten minutes is worth more than a Seat at 40% with six days to run.

One module decides that wording, `src/control/internal/room.ts`, shared with the
other two machines, and every surface asks it: the list, the menu, the tooltip. The
tray used to pick the weekly figure back out of the finished line with a regular
expression, which is exactly how a menu ends up showing something other than what
it means.

## Keeping the numbers current, rather than dating them

A Send token cannot read usage from any endpoint, so the figures only ever arrive
attached to a reply the Seat already paid for. A Seat sitting idle has no news, and
the first version of the list said so: every row carried "(2h 27m ago)" beside
numbers nobody could act on. A timestamp is not an answer to "how much room is
left". It is an apology for not having one.

So the relay asks. Every quarter of an hour it sends one request per stale Seat,
the cheapest the server sells, and folds the reply's own headers in exactly as live
traffic is folded in. That is not a trick: the request genuinely is an exchange
that Seat paid for, so it is remembered as one rather than as a reading taken on
the side. The probe is shaped like a Code session's request or it proves nothing
([ADR 0005](adr/0005-a-refusal-is-not-proof.md)): without the Claude Code system
prompt the server refuses every premium model with a message that reads like an
exhausted allowance, and a refresher doing that would report healthy Seats as
spent.

What it costs, stated rather than buried: one Haiku request of about fifteen tokens
per stale Seat per round, at most four in the air at once. A single token cannot
move a percentage point on either window. A Seat that is out of allowance answers
429, which is a true fact about that Seat and is remembered as one.

```
RELAY_REFRESH_MINUTES=0   switch the rounds off; the screens then say how old
                          each figure is, which is where this started
RELAY_STALE_MINUTES=25    how old a reading may get before it is worth a request
```

## Where the Send tokens live, and what that costs

**One file, `~/.claude-desktop-relay/send-tokens.json`, mode 0600, in a directory
mode 0700. Not encrypted.**

The Mac keeps them in the Keychain and Windows in `CryptProtectData`. Linux has no
equivalent this program can rely on. The only secret store on an ordinary desktop
is the login keyring, which is unlocked by the desktop session, so a relay started
over ssh or from a boot job could not read its own tokens. A store that works only
while somebody is logged in at a screen is worse than a file, because the failure
arrives as a Seat that mysteriously cannot pay.

What that costs, stated plainly:

- Anything running as your user, and root, can read every token. On the Mac the
  Keychain would at least make a new program ask.
- Other users of the machine cannot: ordinary Unix permissions hold, and every
  write goes to a 0600 temporary name and is renamed into place, so the file is
  never briefly readable by anyone else.
- A backup of your home directory carries the credentials. The macOS `seats.json`
  does not, and this file is the exception to that rule.
- Encrypting it would be theatre unless the key lived somewhere else, and on this
  machine there is nowhere else to put it.

Tokens are restored from an encrypted archive taken on another machine:

```bash
relay-linux restore-seats
```

The passphrase is read from the terminal, or from standard input when there is
none, so it can cross an ssh connection without ever being an argument or an
environment variable that `ps` would show to anyone else on the machine.

**The archive carries the Stats logins too, and on this machine that is the only
way they ever arrive.** There is no Claude Desktop profile here to read one out
of. Without them a restored machine pays correctly and reads "not known" for every
plan and every idle Seat, which is most of what a screen is for. They land in
`~/.claude-desktop-relay-secrets/stats-logins.json`, mode 0600 in a 0700
directory, for the same reason and at the same cost as the Send tokens above:
there is nowhere on this machine to keep a key that a relay started from a boot
job could still reach. Seats are put back before logins, so an interruption leaves
a machine that pays and reports less, never one that reports well and cannot pay.

## Proving it, rather than believing it

```bash
node linux/prove.ts
```

Real requests to the real upstream, through the running relay, one per Seat. The
caller's own credential is deliberately worthless every time, so a 200 can only
have come from the relay's swap, and each line is judged by the
`anthropic-organization-id` the server returns rather than by anything this program
logged. It ends with the two negative controls: with the relay off, the worthless
credential must be refused 401, and a real one must reach its own Organization and
no other.

## Not here, on purpose

- **The page.** The tray and the command line are the whole interface.
- **Minting new Send tokens.** `claude setup-token` needs a terminal this port does
  not drive, so Seats are filled on a machine that has one and restored here from a
  backup.
- **The Stats logins**, which on the other machines read what an idle account owns
  and what it is worth. So a Seat's remaining room is learned only from the headers
  on real replies, and a Seat that has not paid for anything yet reads "not known"
  rather than a figure that was guessed.
- **VPN and SOCKS egress.** Traffic here leaves directly, which is what this
  machine does. The rule from
  [ADR 0011](adr/0011-never-leave-except-the-way-the-machine-would.md) is
  unchanged: the relay uses the way out the machine names, or it refuses, and it
  never goes round one.
- **Taking a backup**, and the doctor, and uninstall. Take the backup on the
  machine that mints.

Back to the [overview](../README.md) for what this is and how it is proved.
