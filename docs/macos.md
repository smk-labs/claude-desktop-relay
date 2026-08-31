# claude-desktop-relay on macOS

One Claude Desktop Window. Several of your own Claude subscriptions behind it.

Claude Desktop runs Claude Code as a separate program and hands it a token saying
which account pays. It also, by its own design, sends that program's traffic through
whatever proxy the machine has. So a small local proxy can decide which of your own
subscriptions pays for a session, without modifying the app: nothing in
`/Applications/Claude.app` is touched and its signature stays valid.

It is not a way to share one subscription between people, and not a way around any
limit. Every Seat it uses is one you pay for, and running out of a Seat's allowance
fails the request rather than billing anything else.

[../README.md](../README.md) is the shared overview and how each module is built.
This file is everything a macOS reader needs and nothing else.

## Requirements

- macOS, with Claude Desktop at `/Applications/Claude.app`.
- Node 24 or later. TypeScript, no runtime dependencies.
- `openssl`, which macOS ships. It mints the local certificate authority, once.
- `/usr/bin/expect`, which macOS ships. Minting a Send token needs a terminal, and
  this gives it one without a pseudo-terminal of ours.
- A browser signed into your own claude.ai accounts, for the sitting that collects
  Seats.
- The Command Line Tools, only for the menu bar item: `xcode-select --install`.

Nothing here needs an administrator. There is one command in this document that does,
and it is a stale file left by an older Command Line Tools install.

## Install

```bash
npm install
npm run typecheck && npm test

alias relay='node <this repo>/scripts/relay.ts'

relay              # what is paying for this Window, how much room it has, what next
relay help         # everything there is
```

`relay` with no arguments answers the four halves of the daily question: which Seat is
paying, how much room it has, whether the mechanism is live, and what to type next. It
exits non-zero when the mechanism is broken, so the one word that answers the question
is also the health check. Nothing claims a Seat is paying while any part of the chain
is down.

## Collect your Seats

```bash
relay collect-seats                   # the sitting, one account at a time
relay collect-seats --list            # show the Worklist and stop
relay collect-seats --fresh           # discover your Seats again, replacing the list
relay collect-seats <seat>            # only that one, the same way
relay collect-seats --remint <seat>   # replace a token a Seat already holds
relay add-seat <seat>                 # the same flow, under the name people look for
```

It finds what you own rather than asking you to type it: your own claude.ai logins say
which accounts you have and which Organizations each belongs to, and the free and
API-only ones are dropped because a Seat that cannot pay is not a Seat. It names every
Seat and shows the whole list before asking for anything.

**Then you authorize links, and that is all you do.** For each Seat it says which
account and which Organization are coming, then runs `claude setup-token` itself,
which opens the link. That command runs a callback on this machine, so it finishes on
its own the moment the browser reaches it: no code, nothing typed. The token is read
off that run, proved against the server, put in the Keychain, and backed up. The line
printed beside the link about pasting a code is that command's own fallback for a
callback that never arrives. Nothing here answers it.

Say `s` at any question to stop and keep what is done, then run it again to carry on.
Nothing is remembered between runs except which browser profile each account uses,
because which Seats are filled is read from the Keychain each time. The Worklist is
`/Users/me/.claude-desktop-relay/worklist.json`; edit it and your edit is what is
used. For a Seat no login of yours lists, put it there by hand. There is deliberately
no way to hand a Send token in by typing it: a token that was not minted here was not
proved here either.

**Which Chrome profile.** Before each Seat it names the profile that account most
likely signs in on, read from the browser's own list, so you can put that window in
front before the link appears. It is a heads-up and not a control: `claude` opens the
link itself and it lands in whichever profile is there, and the link is printed too,
so a window that took it by mistake is one paste away from being fixed.

**The mistake this catches.** `claude setup-token` binds to whichever Organization was
active in your browser, so minting for the right account and the wrong Organization is
the likeliest mistake in a sitting and looks perfect from here. Every token is proved
by one real request before it is kept, and refused with the Organization the server
actually named if it is wrong. The flow says which Organization to have active and
does not make it active for you: doing that means writing into a running browser's
cookie store, which is silently ignored, and making it stick means closing the browser
you are working in.
[adr/0013-announce-the-organization-never-seed-it.md](adr/0013-announce-the-organization-never-seed-it.md).

**The credential that belongs to somebody else.** The `claude` command keeps its own
login in one Keychain entry, service `Claude Code-credentials`, and `CLAUDE_CONFIG_DIR`
does not namespace it, so an isolated config folder does not isolate it. The flow reads
that entry's date before each mint and after it, and stops the sitting if it moved
rather than replacing your own login fifteen more times. A reading that failed counts
as moved, because two failed readings would otherwise compare equal and read as safe.

**Nothing runs when nobody is at the keyboard.** Minting opens a real authorization
against whatever account the browser is signed into, and killing the process does not
take that back, so a run with no terminal says what it would have done and does none
of it.

A Seat that was in the Keychain before this existed has a name the flow does not
derive. It probes that token, says which Organization the server thinks it pays for,
and asks which of your Seats in that Organization it is. It never guesses: a Send
token proves an Organization and nothing about which account minted it.

## The Send tokens, and the one rule about them

**Do not delete the Keychain entries under `claude-desktop-relay`.** They are the Send
tokens: one per Seat, each from a sign-in by hand as its own account, each good for
about a year. Nothing in this repository can mint them again for you. They are in the
Keychain and in no file. `/Users/me/.claude-desktop-relay/seats.json` lists the Seats
and deliberately holds no credential, so backing that folder up saves nothing that
matters.

```bash
relay back-up-seats             # take a backup, after every sitting that fills a Seat
relay back-up-seats --restore   # put one back, Seats and logins together
relay back-up-seats --no-logins # the Send tokens only
```
It carries the **Stats logins** as well, and that is what makes an archive enough to
move to another machine. A Send token pays and can say nothing about a plan: every
plan name, every Multiplier and every idle Seat's usage is read from a claude.ai
session instead, and those sessions live inside Claude Desktop profiles that do not
travel. An archive of tokens alone restores a machine that bills correctly and reads
"not known" on every row. A Stats login is a credential too, so it is inside the same
cipher under the same passphrase and never beside it. `--no-logins` leaves them out.

It writes one AES-256-CBC archive under a passphrase you choose, readable only by you,
to `/Users/me/.claude-legacy-backup/send-tokens/`, with a plain note beside it saying
what it is. That folder is outside this repository, so nothing here can sweep it into
a commit. **Keep the passphrase somewhere you will find it: nothing can recover it,
and without it the backup is a file of noise.**

`relay uninstall` is the one command that removes the tokens, and it refuses unless
you say `--and-forget-the-tokens`. `relay` and `relay seats` say when tokens are held
with no backup, because the rule to take one used to live in a document, and on
2026-08-22 all sixteen were lost to one wrong command with nothing to restore from.

## Two accounts, one relayed

Two Claude Desktop accounts are open at once and only one of them is relayed. This is
the shape the program is set up for, and it is what keeps the relay from ever standing
in front of an app full of MCP servers again.

| | the billing Window | the relayed Window |
| --- | --- | --- |
| Desktop folder | `/Users/me/Library/Application Support/Claude` | `/Users/me/.claude-relayed/desktop` |
| account | the central billing account | its own second account |
| our variables in its store | none at all | address and certificate |
| who pays for a Code session | that account's own subscription | whichever Seat is chosen |
| Claude Desktop connectors | yours, untouched | none |
| Claude Code plugins, skills, MCP | `/Users/me/.claude`, yours | `/Users/me/.claude-relayed/code-config`, empty |
| relay | none | its own, on port 8980 |

Nothing is shared between the two except the Keychain, which is where the Send tokens
already are. Nothing is synced, on purpose: settings, MCP servers and plugins are what
made a dead VPN take a whole Window down, and a Desktop folder with none of them has
nothing to lose
([adr/0014-two-accounts-one-relayed.md](adr/0014-two-accounts-one-relayed.md)).

Two layers, and the second is the one people miss. Claude Desktop's connectors belong to a
Desktop folder, so a fresh one has none. But Claude Code reads `/Users/me/.claude` for
its plugins, skills and MCP servers, and that is one directory shared by every Window
on the machine. So `install` gives any Window that is not your own its own
`CLAUDE_CONFIG_DIR`. Without it, the relayed Window would start your ten MCP servers
as children of a relayed session while the Desktop folder still looked empty.

The billing Window needs nothing from this program and is not protected by it: Claude
Code finds the machine's proxy on its own.

```bash
mkdir -p ~/.claude-relayed/desktop

CLAUDE_RELAY_HOME=~/.claude-relayed \
CLAUDE_RELAY_APP_SUPPORT=~/.claude-relayed/desktop \
CLAUDE_RELAY_PORT=8980 relay install

cp ~/.claude-desktop-relay/seats.json ~/.claude-relayed/seats.json
```

The copy gives that home the Seat identities, so its Chooser knows what you own. No
credential moves: the Send tokens are read from the Keychain. Now open the Window,
from a shell with none of our variables set, and sign in as the second account:

```bash
env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY \
    -u https_proxy -u NO_PROXY -u no_proxy -u NODE_EXTRA_CA_CERTS \
    -u NODE_USE_SYSTEM_CA -u ANTHROPIC_BASE_URL \
  /usr/bin/open -n -a /Applications/Claude.app \
  --args --user-data-dir="$HOME/.claude-relayed/desktop"
```

Two things there are load-bearing. The machine is asked to open the application,
because an app we run ourselves stays inside the launcher's launchd job, gets no
application job of its own, and comes up slowly and loads nothing
([adr/0016-a-window-is-opened-by-the-machine.md](adr/0016-a-window-is-opened-by-the-machine.md)).
And the variables are stripped: `open` hands the application the environment `open`
itself was run with, so a Window opened from a shell that has them inherits all of
them, and then its store is not the only source of anything. That mistake produced a
whole day of confident wrong readings
([testing-on-a-second-profile.md](testing-on-a-second-profile.md)). The page and the
menu bar item open a Desktop folder with one click and build the environment
themselves, so that route cannot be got wrong.

Every command aimed at that Window takes the same three variables:

```bash
CLAUDE_RELAY_HOME=~/.claude-relayed \
CLAUDE_RELAY_APP_SUPPORT=~/.claude-relayed/desktop \
CLAUDE_RELAY_PORT=8980 relay auto
```

Leave `CLAUDE_RELAY_HOME` out and the command reads the default home,
`/Users/me/.claude-desktop-relay`, which on a machine set up this way was never made.
It then answers about the wrong folder: no Seats, nothing to back up, nobody paying,
while every Send token sits untouched in the Keychain. Nothing is wrong and nothing is
lost. The commands that report an empty list name the folder they read and point at
this variable.

## What install does, and what undo does

`relay install` makes the relay a launchd agent that starts at login and comes back if
it dies, written to
`/Users/me/Library/LaunchAgents/com.claude-desktop-relay.agent.8980.plist`. It writes
the relay's address, its certificate and its own `CLAUDE_CONFIG_DIR` into that Window's
store, `ccd-environment-config.json` inside its Desktop folder. Then open that Window
and it is relayed from the first session.

The relay serving the Window you work in answers on port 8978 and its agent is labelled
`com.claude-desktop-relay.agent`. A relay on a Window of its own sets `CLAUDE_RELAY_PORT`
and gets its own port and label, because one relay serves exactly one Desktop folder
([adr/0012-one-relay-serves-one-desktop-folder.md](adr/0012-one-relay-serves-one-desktop-folder.md)).
Run install with the variables set, not bare: bare, it installs on the Desktop folder
you work in, which is the one Window meant to carry nothing of ours.

**Why one restart.** The app reads that store once when it starts and caches it, and
resolves its proxy once the same way. A Window already running cannot be brought in, by
any route. What happens live, with nothing restarted, is choosing a Seat or choosing Off
([adr/0009-everything-through-the-store.md](adr/0009-everything-through-the-store.md)).

`relay uninstall` puts the machine back: the agent gone, our folder gone, our variables
removed from the app's own store while anything else in it survives. To take the relay
off a Window, run it there and restart that Window once. It refuses to forget your Send
tokens unless you say `--and-forget-the-tokens`, and that forgets all of them by name:
the Keychain is shared, so it would take every relay's credentials.

## The daily commands

Nothing needs restarting for any of these:

```bash
relay auto            # let it pick the best Seat for each new conversation
relay use <seat>      # pay with that Seat instead, from the next request
relay off             # leave every request on the Window account
relay on              # go back to the Seat it remembers
relay seats           # every Seat you own, and what each has left
relay verdict         # what the server said about the last swap
relay doctor          # is the mechanism still working, and what broke
relay refresh         # read what every Seat has spent, and any plan that changed
relay page            # open the page the relay serves
relay serve [port]    # run the relay in this terminal instead of as the agent
```

**Auto** picks the Seat with the most room, weighed again on every request. A switch is
in force at once, including inside a conversation that is already running: that
conversation is re-sent uncached to the new Organization, and the log says so after the
fact rather than asking first. A Refusal is an ordinary switch too, and then the same
request is sent again on the next best Seat before a byte of the Refusal reaches you.

**What it went on**, kept without a word of your work in it:

```bash
relay history                       # the last week, per Seat
relay history --day                 # the last day
relay history --month               # the last thirty days
relay history --projects --seats    # which repository is eating which Seat
relay history --tidy                # name any project still unknown, fold old rows
```

Costs there are what the work would have cost at API rates, from a dated table kept as
data, and never what you paid: a subscription is not per-token. No money is stored in a
row, so correcting the table corrects every past total.

## How much room a Seat has

Every row used to read `5h 8%  7d 1%`, which never said whether the percentage was
spent or left, put a duration where a window's name belonged, and never said when
either window turns over. That last half is what decides anything: a Seat at 90% that
resets in ten minutes is worth more than a Seat at 40% with six days to run.

    s 8% · in 2h 6m   w 1% · in 6d 8h

`s` is the five-hour session and `w` is the week. The session comes first, because it
is the window that stops work within the hour; the week decides which Seat to move to
next. One module owns that wording, `src/control/internal/room.ts`, and every surface
asks it. Where there is room for a legend the letters are explained, and where there
is not the words are spelled out, as in the menu bar's tooltip:

    alpha-main-4f1c · 20x
    Session: 63% spent, resets in 1h 12m. Week: 41% spent, resets in 2d 7h.
    Relay is on

**The figures keep themselves current.** A Send token cannot read usage from any
endpoint, so they only ever arrive attached to a reply the Seat already paid for, and a
Seat sitting idle has no news. Every screen ended up carrying "(2h 27m ago)" beside
numbers nobody could act on, and a timestamp is not an answer to "how much room is
left". So every quarter of an hour the relay sends one request per stale Seat, the
cheapest the server sells, and folds the reply's headers in exactly as live traffic is
folded in. It costs about fifteen tokens per stale Seat per round, at most four in the
air at once, and a single token cannot move a percentage point on either window.

    RELAY_REFRESH_MINUTES=0   switch the rounds off; the screens then say how old
                              each figure is, which is where this started
    RELAY_STALE_MINUTES=25    how old a reading may get before it is worth a request

`relay refresh` is a different thing: it reads your own Stats logins, which is the only
way a Multiplier or a plan change ever arrives.

## How it is proved

The only honest evidence that a swap worked is the server's own answer.

```bash
relay check-secret-store    # the real Keychain, byte for byte
relay check                 # the real server, one real session
relay prove                 # which paths land on the chosen Seat, on a Window of its own
```

`relay check` runs a real Code session through the relay having handed it a Send token
that **cannot work**. A session that succeeds can therefore only have succeeded because
the relay put the chosen Seat's token on the request. The server then names the
Organization that paid, and that is compared with the Seat that was picked. Agreement
between two Organization ids that both actually exist is the only route to a verdict of
`verified`: two blanks are not agreement, a redirect is not a success, and a request the
server never answered proves nothing.

The test suite never touches the network, the Keychain or Claude Desktop: it stands up a
local fake upstream holding our own certificate and drives real requests at it. The
three commands above are what cannot be faked honestly.

**Coverage is judged by negative control and never by counting.** A request that went
round the relay is absent altogether, and an absence looks exactly like work that never
happened. So `relay prove` sets up a **Proving Window**: a second Claude Desktop with
its own Desktop folder at `/Users/me/.claude-desktop-relay-proving`, its own login, its
own relay on port 8979 and its own Payer, whose store carries a credential that cannot
buy anything. Work that completes in it can only have completed through the relay, and
the Window you work in is never touched.

## The page and the menu bar item

The relay serves its own screen on its own port. Nothing extra is installed, no runtime
dependency was added, and it reads exactly one JSON document.

```bash
relay page
```

- **The page**, at the relay's port. A masthead counting the Seats, the accounts and the
  combined Multiplier; a Paying now panel naming the Seat, its plan, its Organization
  and both meters with their reset times; the Seats worth switching to as one click
  each. Figures update in place. It reads `GET /state` and posts to `/act` to switch.
- **The analytics view**, in the same page: which Seat, which model, which project, and
  what the work would have cost at published API rates, each token bucket priced at its
  own rate rather than one total split four ways.
- **The four states that are not the happy path**: no Seats collected yet, usage
  unreadable, the mechanism broken, and every Seat spent. Each says what happened and
  what to do, and none says only that something is absent.
- **The menu bar item**, one Swift file over the same local API at `GET /tray`. The
  paying Seat, the Mode as Auto, Manual and Off, six Seats as one click each, and a way
  to the page.

**Every Desktop folder, and one click to open any of them.** Both surfaces name the one
these figures are about, because there are several and only one is relayed, and both
list the rest: relayed by this relay, by another one, or not at all, open or not, and
where each lives.

    Relaying  /Users/me/.claude-relayed/desktop · every Code session in it

    Main      me@example.com · Example             not relayed · open
    Relayed   me-second@example.com · Example Two  relayed · open

The list is discovered rather than configured, so a Desktop folder made tomorrow appears
without anybody editing anything, and whether one is relayed is read out of that
folder's own store. A store that will not open is reported as unreadable and never as
"not relayed": that would be a guess dressed as a fact about the one thing the section
exists to answer. The email address is on disk nowhere, so it is asked for once every
half hour with that folder's own OAuth token, which is read, used and dropped.

Whether a folder is open is read from the process list, and one already open is raised
rather than started again: a second start gave two applications writing one store.
`open -a` is not how any of them is started, because macOS reads that as "the app is
open" and activates whatever is running, which is why the first version of the button
appeared to do nothing. It is `open -n -a`. The environment is built rather than
inherited, because a Window inherits whatever starts it: from the relay's own agent it
got launchd's bare `PATH` and could find no MCP server configured as `npx ...`, and
from a relayed Code session it got that session's `HTTPS_PROXY` and our certificate. So
what may travel is named, and `PATH` is the user's login `PATH`, read once from their
login shell.

Opening is all it does. Nothing here closes a Window, and turning the relay on or off
for a Desktop folder is `relay install` on that folder's own home.

**The menu bar item, installed.** One Swift file, compiled on demand by the `swiftc`
that ships with the Command Line Tools, then wrapped in a bundle so it survives a
restart:

```bash
CLAUDE_RELAY_HOME=~/.claude-relayed \
CLAUDE_RELAY_APP_SUPPORT=~/.claude-relayed/desktop \
CLAUDE_RELAY_PORT=8980 relay tray --install
```

That writes `/Applications/Relay.app`, or the same folder in your home if
`/Applications` is not writable by you, and needs no more rights than you already have.
The bundle is `LSUIElement`, so it is a status item with no Dock icon. The port is
written into it at install time, because a bundle opened from the Finder is given no
arguments, so a second relay on a second port gets its own bundle. It is signed ad-hoc,
which gives it the stable identity the window server wants before it hands out a place
in the menu bar.

**If it will not build, one stale file is usually why.** An older Command Line Tools
left `/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap` behind,
dated August 2023, defining a module the current toolchain already defines in
`bridging.modulemap` beside it, so every `import AppKit` fails with `redefinition of
module 'SwiftBridging'`. `relay tray` recognises that error by name. Moving the old
file aside is the whole fix, it is reversible, and it is the one thing here that needs
an administrator:

```bash
sudo mv /Library/Developer/CommandLineTools/usr/include/swift/module.modulemap /Library/Developer/CommandLineTools/usr/include/swift/module.modulemap.stale-2023
```

The page is unaffected either way.

## Two rules about how traffic leaves

**It never goes round your proxy or VPN.** When the machine names a way out, read from
`scutil --proxy`, the relay uses it or refuses. If your tunnel is down, nothing reaches
Anthropic and the relay says so; it does not quietly send the request, its credential
and the fact of this machine talking to Anthropic out over the ordinary connection
instead
([adr/0011-never-leave-except-the-way-the-machine-would.md](adr/0011-never-leave-except-the-way-the-machine-would.md)).
A machine that names nothing goes straight out, because that is what the machine itself
would do, and a transparent VPN on a TUN device is exactly that case. A machine that
names only a SOCKS proxy is carried through it, with the host sent as a name so the
proxy resolves it: resolving locally would put a DNS question for `api.anthropic.com`
out over the ordinary connection, which is what the tunnel exists to prevent. Proved
with the direct route pointed at a dead port: with the rule on, Anthropic never
answered; with it off, the same request came back 401.

**It never asks for more at once than the route can carry.** One exchange used to be one
connection, so 86 concurrent requests meant 86 simultaneous connections through one
local proxy. Most sat in silence waiting their turn and the proxy closed them for being
quiet: 190 failed requests out of about 1,760, all of which would have worked a moment
later. There is now a bound of twelve in flight, and the turn is taken before anything
is dialled, because a tunnel that is not open yet cannot be hung up on for being quiet.
Connections are reused, with an idle bound of five seconds against a proxy measured to
hang up at about fifteen. The measurement is in [mechanism.md](mechanism.md).

## Two traps, both already paid for

A request without the Claude Code system prompt is refused for every premium model with
a message that reads like a spent allowance, while the Seat's own reported Utilization
sits near zero. So a Refusal is evidence about one request and never a verdict about a
Seat ([adr/0005-a-refusal-is-not-proof.md](adr/0005-a-refusal-is-not-proof.md)).

A client told its tunnel is open before the upstream pipe exists loses the bytes it
wrote in between: the handshake dies and the window renders black with nothing in any
log. The bytes that arrive attached to the CONNECT request are pushed back onto the
socket, which mutation testing confirms is load-bearing.

## Where everything lives on this machine

| what | where |
| --- | --- |
| the Send tokens | the Keychain, service `claude-desktop-relay` |
| the backup archive | `/Users/me/.claude-legacy-backup/send-tokens/` |
| everything else of ours | `/Users/me/.claude-desktop-relay/`, or what `CLAUDE_RELAY_HOME` names |
| the Seats, the Worklist, the usage memory, the history, the log | inside that folder |
| the local certificate authority | `ca/` inside that folder |
| the relay as a service | `/Users/me/Library/LaunchAgents/com.claude-desktop-relay.agent[.<port>].plist` |
| the Window the user works in | `/Users/me/Library/Application Support/Claude` |
| our variables inside a Desktop folder | `ccd-environment-config.json`, encrypted by the app |
| the menu bar item | `/Applications/Relay.app` |
| the `claude` command's own login | the Keychain, service `Claude Code-credentials` |

[../CONTEXT.md](../CONTEXT.md) is the vocabulary, and the code uses those words.
[adr/](adr/) holds the decisions, [spec.md](spec.md) the plan, and
[mechanism.md](mechanism.md) the measurements with their dates. MIT licensed.
