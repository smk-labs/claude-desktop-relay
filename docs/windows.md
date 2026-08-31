# claude-desktop-relay on Windows

One Claude Desktop Window. Several of your own Claude subscriptions behind it.

Claude Desktop runs Claude Code as a separate program and hands it a token saying
which account pays. It also, by its own design, sends that program's traffic through
whatever proxy the machine has. So a small local proxy can decide which of your own
subscriptions pays for a session, without modifying the app: nothing inside the Claude
Desktop install is touched.

It is not a way to share one subscription between people, and not a way around any
limit. Every Seat it uses is one you pay for, and running out of a Seat's allowance
fails the request rather than billing anything else.

[../README.md](../README.md) is the shared overview and how each module is built.
This file is everything a Windows reader needs and nothing else.

## Requirements

- Windows, with Claude Desktop installed. All three install routes are found by name:
  `%LOCALAPPDATA%\Programs\claude-desktop\Claude.exe`, the Squirrel layout under
  `%LOCALAPPDATA%\AnthropicClaude\app-<version>\`, and the Store package under
  `%ProgramFiles%\WindowsApps`. None is written down as a constant, because one of
  those paths carries a version number and would be wrong the first time the app
  updated.
- Node 24 or later. TypeScript, no runtime dependencies.
- Git for Windows, which is where `openssl` comes from. It mints the local certificate
  authority, once. It is looked for on `PATH` and then in the places Git puts it, and
  a machine without one is told so in a sentence rather than by `spawn openssl ENOENT`.
- The PowerShell that ships with Windows. It runs the notification area item and reads
  back the console a mint writes to. Nothing is installed, downloaded or vendored.
- A browser signed into your own claude.ai accounts, for the sitting that collects
  Seats.

Nothing here needs an administrator, and nothing here asks for one.

## Install

```powershell
npm install
npm run typecheck; npm test

function relay { node C:\Users\me\claude-desktop-relay\scripts\relay.ts @args }

relay              # what is paying for this Window, how much room it has, what next
relay help         # everything there is
```

Put that function in your PowerShell profile and the daily question is one word.
`relay` with no arguments answers the four halves of it: which Seat is paying, how
much room it has, whether the mechanism is live, and what to type next. It exits
non-zero when the mechanism is broken, so the one word that answers the question is
also the health check. Nothing claims a Seat is paying while any part of the chain is
down.

## Collect your Seats

```powershell
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
off that run, proved against the server, locked by `CryptProtectData`, and backed up.
The line printed beside the link about pasting a code is that command's own fallback
for a callback that never arrives. Nothing here answers it.

Say `s` at any question to stop and keep what is done, then run it again to carry on.
Nothing is remembered between runs except which browser profile each account uses,
because which Seats are filled is read from the secret store each time. The Worklist is
`C:\Users\me\.claude-desktop-relay\worklist.json`; edit it and your edit is what is
used. For a Seat no login of yours lists, put it there by hand. There is deliberately
no way to hand a Send token in by typing it: a token that was not minted here was not
proved here either.

**Minting opens a console window, and that is right rather than a concession.**
`claude setup-token` writes to a terminal or it writes nothing: piped stdio produced
zero bytes in ten seconds, measured. So the mint runs in a real console that PowerShell
reads back with `GetBufferContents`. The window is visible because a mint is an
interactive authorization, and nothing here runs one when nobody is at the keyboard:
killing the process does not take back an authorization the browser already completed.
The buffer is made a thousand columns wide first, because `claude` wraps its output to
the terminal's width and a four hundred character link with newlines in the middle
cannot be unwrapped afterwards.

**The Stats logins are read once and kept, because a running Window cannot be read.**
Claude Desktop holds a Desktop folder's cookie store open exclusively while it runs, so
where the Windows are open almost always there is nothing to read where it lives. A
login is read once, from a Desktop folder that is closed or from a folder of logins you
already have, and kept in `C:\Users\me\.claude-desktop-relay-secrets\stats-logins.json`,
each one locked by `CryptProtectData` like the Send tokens.

```powershell
relay collect-seats --import-logins <folder>   # read files holding a sessionKey, keep them
relay collect-seats --logins <folder>          # read Desktop folders from somewhere else
```

`--import-logins` never writes to the folder it reads. A Stats login can read and never
sends ([adr/0002-two-credentials-per-seat.md](adr/0002-two-credentials-per-seat.md)).
Keeping one is still keeping a credential, which is why it is locked and why it sits
beside the Send tokens rather than in a relay's home.

**Which Chrome profile.** Before each Seat it names the profile that account most
likely signs in on, read from the browser's own list, so you can put that window in
front before the link appears. It is a heads-up and not a control: `claude` opens the
link itself and it lands in whichever profile is there, and the link is printed too, so
a window that took it by mistake is one paste away from being fixed.

**The mistake this catches.** `claude setup-token` binds to whichever Organization was
active in your browser, so minting for the right account and the wrong Organization is
the likeliest mistake in a sitting and looks perfect from here. Every token is proved
by one real request before it is kept, and refused with the Organization the server
actually named if it is wrong. The flow says which Organization to have active and does
not make it active for you: doing that means writing into a running browser's cookie
store, which is silently ignored, and making it stick means closing the browser you are
working in.
[adr/0013-announce-the-organization-never-seed-it.md](adr/0013-announce-the-organization-never-seed-it.md).

**The credential that belongs to somebody else.** The `claude` command keeps its own
login in `.credentials.json`, and `CLAUDE_CONFIG_DIR` does not move it, so an isolated
config folder does not isolate it. The flow reads that file's date before each mint and
after it, and stops the sitting if it moved rather than replacing your own login fifteen
more times. A reading that failed counts as moved, because two failed readings would
otherwise compare equal and read as safe.

A Seat that was in the secret store before this existed has a name the flow does not
derive. It probes that token, says which Organization the server thinks it pays for, and
asks which of your Seats in that Organization it is. It never guesses: a Send token
proves an Organization and nothing about which account minted it.

## The Send tokens, and the one rule about them

**Do not delete `C:\Users\me\.claude-desktop-relay-secrets\send-tokens.json`.** It holds
the Send tokens: one per Seat, each from a sign-in by hand as its own account, each good
for about a year. Nothing in this repository can mint them again for you.

They are locked with `CryptProtectData`, which ties the bytes to the account you are
logged in as: no passphrase to hold, no prompt to answer, and another account on the box
cannot open them. That file sits deliberately outside every relay's home, so undoing one
relay cannot take another's credentials. `C:\Users\me\.claude-desktop-relay\seats.json`
lists the Seats and deliberately holds no credential.

```powershell
relay check-secret-store        # prove the round trip against the real thing
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

The backup is one AES-256-CBC archive under a passphrase you choose, written to
`C:\Users\me\.claude-legacy-backup\send-tokens\` with a plain note beside it saying what
it is. That folder is outside this repository, so nothing here can sweep it into a
commit. **Keep the passphrase somewhere you will find it: nothing can recover it, and
without it the backup is a file of noise.** It is also the only copy that survives
losing the Windows account the tokens are locked to.

`relay uninstall` is the one command that removes the tokens, and it refuses unless you
say `--and-forget-the-tokens`. `relay` and `relay seats` say when tokens are held with
no backup, because the rule to take one used to live in a document, and on 2026-08-22
all sixteen were lost to one wrong command with nothing to restore from.

## Two accounts, one relayed

Two Claude Desktop accounts are open at once and only one of them is relayed. This is
the shape the program is set up for, and it is what keeps the relay from ever standing
in front of an app full of MCP servers again.

| | the billing Window | the relayed Window |
| --- | --- | --- |
| Desktop folder | `C:\Users\me\AppData\Roaming\Claude` | `C:\Users\me\.claude-relayed\desktop` |
| account | the central billing account | its own second account |
| our variables in its store | none at all | address and certificate |
| who pays for a Code session | that account's own subscription | whichever Seat is chosen |
| Claude Desktop connectors | yours, untouched | none |
| Claude Code plugins, skills, MCP | `C:\Users\me\.claude`, yours | `C:\Users\me\.claude-relayed\code-config`, empty |
| relay | none | its own, on port 8980 |

Nothing is shared between the two except the machine's secret store, which is where the
Send tokens already are. Nothing is synced, on purpose: settings, MCP servers and
plugins are what made a dead VPN take a whole Window down, and a Desktop folder with
none of them has nothing to lose
([adr/0014-two-accounts-one-relayed.md](adr/0014-two-accounts-one-relayed.md)).

Two layers, and the second is the one people miss. Claude Desktop's connectors belong to a
Desktop folder, so a fresh one has none. But Claude Code reads `C:\Users\me\.claude` for
its plugins, skills and MCP servers, and that is one directory shared by every Window on
the machine. So `install` gives any Window that is not your own its own
`CLAUDE_CONFIG_DIR`. Without it, the relayed Window would start your ten MCP servers as
children of a relayed session while the Desktop folder still looked empty.

The billing Window needs nothing from this program and is not protected by it: Claude
Code finds the machine's proxy on its own.

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude-relayed\desktop"

$env:CLAUDE_RELAY_HOME        = "$HOME\.claude-relayed"
$env:CLAUDE_RELAY_APP_SUPPORT = "$HOME\.claude-relayed\desktop"
$env:CLAUDE_RELAY_PORT        = "8980"
relay install

Copy-Item "$HOME\.claude-desktop-relay\seats.json" "$HOME\.claude-relayed\seats.json"
```

The copy gives that home the Seat identities, so its Chooser knows what you own. No
credential moves: the Send tokens are read from the secret store. Now open the Window,
from a PowerShell with none of our variables set, and sign in as the second account:

```powershell
& "$env:LOCALAPPDATA\Programs\claude-desktop\Claude.exe" --user-data-dir="$HOME\.claude-relayed\desktop"
```

Starting the executable directly is right here: the shell you type in already sits
inside your own logged-in session, so the app gets what it would have got from the Start
menu. `--user-data-dir` is what makes a second Claude Desktop a second Window rather
than a second view of the same one. Do not start it from a shell that has our variables
set: a Window inherits whatever starts it, so it would come up holding our address and
our certificate, and then its store is not the only source of anything. The page and the
notification area item open a Desktop folder with one click and strip everything of ours
first, so that route cannot be got wrong.

Every command aimed at that Window takes the same three variables:

```powershell
$env:CLAUDE_RELAY_HOME        = "$HOME\.claude-relayed"
$env:CLAUDE_RELAY_APP_SUPPORT = "$HOME\.claude-relayed\desktop"
$env:CLAUDE_RELAY_PORT        = "8980"
relay auto
```

Leave `CLAUDE_RELAY_HOME` out and the command reads the default home,
`C:\Users\me\.claude-desktop-relay`, which on a machine set up this way was never made.
It then answers about the wrong folder: no Seats, nothing to back up, nobody paying,
while every Send token sits untouched in the secret store. Nothing is wrong and nothing
is lost. The commands that report an empty list name the folder they read and point at
this variable.

## What install does, and what undo does

Run `relay install`, then close Claude Desktop and open it again, once.

**The relay is a login item that supervises itself.** The Task Scheduler was the closer
match to a real service and it is refused outright for an ordinary account here:
`schtasks /Create` and `Register-ScheduledTask` both answer "Access is denied", for a
task as trivial as `echo`, at the root and in a folder of its own. So `install` writes
one `.vbs` into your own Startup folder,
`C:\Users\me\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`, which needs
no more rights than you already have. That script sets the three variables saying which
Window this relay serves, starts the relay with no console window, waits for it, sleeps
five seconds and starts it again. `wscript.exe` is the windowless script host, which is
why `node.exe` leaves no black window on your desktop for as long as the relay lives.
Deleting the file is the whole undo.

`install` also writes the relay's address, its certificate and its own
`CLAUDE_CONFIG_DIR` into that Window's store, `ccd-environment-config.json` inside its
Desktop folder. That store is locked with AES-256-GCM under a key the app keeps beside
it in `Local State`, wrapped by Windows for the logged-in account. That was proved
rather than believed, by decrypting a value Claude Desktop itself had written.

The relay serving the Window you work in answers on port 8978 and its login item is
named `claude-desktop-relay.vbs`. A relay on a Window of its own sets `CLAUDE_RELAY_PORT`
and gets its own port and file name, because one relay serves exactly one Desktop folder
([adr/0012-one-relay-serves-one-desktop-folder.md](adr/0012-one-relay-serves-one-desktop-folder.md)).
Run install with the variables set, not bare: bare, it installs on the Desktop folder
you work in, which is the one Window meant to carry nothing of ours.

**Why one restart.** The app reads that store once when it starts and caches it, and
resolves its proxy once the same way. A Window already running cannot be brought in, by
any route. What happens live, with nothing restarted, is choosing a Seat or choosing Off
([adr/0009-everything-through-the-store.md](adr/0009-everything-through-the-store.md)).

`relay uninstall` puts the machine back: the login item gone, our folder gone, our
variables removed from the app's own store while anything else in it survives. To take
the relay off a Window, run it there and restart that Window once. It refuses to forget
your Send tokens unless you say `--and-forget-the-tokens`, and that forgets all of them
by name: the secret store is shared, so it would take every relay's credentials.

## The daily commands

Nothing needs restarting for any of these:

```powershell
relay auto            # let it pick the best Seat for each new conversation
relay use <seat>      # pay with that Seat instead, from the next request
relay off             # leave every request on the Window account
relay on              # go back to the Seat it remembers
relay seats           # every Seat you own, and what each has left
relay verdict         # what the server said about the last swap
relay doctor          # is the mechanism still working, and what broke
relay refresh         # read what every Seat has spent, and any plan that changed
relay page            # open the page the relay serves
relay serve [port]    # run the relay in this terminal instead of as the login item
```

**Auto** picks the Seat with the most room, weighed again on every request. A switch is
in force at once, including inside a conversation that is already running: that
conversation is re-sent uncached to the new Organization, and the log says so after the
fact rather than asking first. A Refusal is an ordinary switch too, and then the same
request is sent again on the next best Seat before a byte of the Refusal reaches you.

**What it went on**, kept without a word of your work in it:

```powershell
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

    alpha-main-4f1c · 20x    s fresh   w 15% · in 3d 5h

`s` is the five-hour session and `w` is the week. The session comes first, because it is
the window that stops work within the hour; the week decides which Seat to move to next.
One module owns that wording, `src/control/internal/room.ts`, and every surface asks it:
the notification area item, its tooltip, `relay seats` and the page. The shell lays them
out and computes nothing. Where there is room for a legend the letters are explained,
and where there is not the words are spelled out, as in the tooltip:

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

```powershell
relay check-secret-store    # the real CryptProtectData round trip
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

The test suite never touches the network, the secret store or Claude Desktop: it stands
up a local fake upstream holding our own certificate and drives real requests at it. Two
of its tests are skipped here and say why in their own text: the one about delivering a
signal to a child, which Windows does not do, and the one about a Window started with no
folder named, which cannot happen here.

**Coverage is judged by negative control and never by counting.** A request that went
round the relay is absent altogether, and an absence looks exactly like work that never
happened. So `relay prove` sets up a **Proving Window**: a second Claude Desktop with
its own Desktop folder at `C:\Users\me\.claude-desktop-relay-proving`, its own login,
its own relay on port 8979 and its own Payer, whose store carries a credential that
cannot buy anything. Work that completes in it can only have completed through the
relay, and the Window you work in is never touched.

## The page and the notification area item

The relay serves its own screen on its own port. Nothing extra is installed, no runtime
dependency was added, and it reads exactly one JSON document.

```powershell
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
- **The notification area item**, one PowerShell file over the same local API at
  `GET /tray`. The paying Seat, the Mode as Auto, Manual and Off, six Seats as one click
  each, and a way to the page. Four icon states, told apart by shape as well as colour.

The menu's sections, their order and their words are written down once, in
`src/tray/internal/menu.ts`, and `test/tray-parity.test.ts` reads every shell and fails
when one of them says something else. That test exists because they did drift: one said
"Switch to" and another "PAY WITH". The order is:

    Paying now      the Seat, its plan, and what it has spent
    Mode            Auto · Manual · Off, ticked
    Switch to       up to six Seats, one click each; sets Manual
    Claude Desktop  every Desktop folder, click to open, the relayed one ticked
    Relaying …      which Desktop folder these figures are about
    Refreshed …     when the figures were last read, and how long ago
    Open Relay…     the whole screen
    Quit Relay tray

**Every Desktop folder, and one click to open any of them.** Both surfaces name the one
these figures are about, because there are several and only one is relayed, and both
list the rest: relayed by this relay, by another one, or not at all, open or not, and
where each lives.

    Relaying  C:\Users\me\.claude-relayed\desktop · every Code session in it

    Main      me@example.com · Example             not relayed · open
    Relayed   me-second@example.com · Example Two  relayed · open

The list is discovered rather than configured, so a Desktop folder made tomorrow appears
without anybody editing anything, and whether one is relayed is read out of that
folder's own store. A store that will not open is reported as unreadable and never as
"not relayed": that would be a guess dressed as a fact about the one thing the section
exists to answer. The email address is on disk nowhere, so it is asked for once every
half hour with that folder's own OAuth token, which is read, used and dropped.

**A Desktop folder answers for itself about whether it is open.** Every one of them
holds a `lockfile` in its own folder for as long as it runs, which is how the app
refuses to open one folder twice. Asking that file is exactly the question ADR 0012
asks, about exactly one folder, in no measurable time. The alternative was a process
list, and that means starting PowerShell: half a second, every time, for an answer the
page asks for on every refresh.

The environment a Window is opened with is not inherited whole. The launcher here sits
inside your own logged-in session, holding what Explorer would have given the app, and
that environment is large, machine specific and not ours to enumerate: `SYSTEMROOT`,
`APPDATA`, `PROGRAMW6432`, the OneDrive names, whatever an installer added. So what is
dropped is named instead, and it is ours: the proxy variables, our certificate, and the
variables a Code session hands on. Nothing is lost by dropping them, because a relayed
Desktop folder is relayed by what is in its own store.

Opening is all it does. Nothing here closes a Window, and turning the relay on or off
for a Desktop folder is `relay install` on that folder's own home.

**The notification area item, installed.** It is one PowerShell file, run rather than
compiled, so there is nothing to build.

```powershell
$env:CLAUDE_RELAY_HOME        = "$HOME\.claude-relayed"
$env:CLAUDE_RELAY_APP_SUPPORT = "$HOME\.claude-relayed\desktop"
$env:CLAUDE_RELAY_PORT        = "8980"
relay tray --install
```

That writes a second `.vbs` into the same Startup folder the relay's own login item
uses, so the item comes back after a restart, and starts it now as well. The port is
written into that file, because a login item is given no arguments, so a second relay on
a second port gets its own file reading its own relay. Installing twice stops any item
already running first, so you get one in the tray rather than two reading the same
relay. Quit it from its own menu.

## Two rules about how traffic leaves

**It never goes round your proxy or VPN.** When the machine names a way out, the relay
uses it or refuses. If your tunnel is down, nothing reaches Anthropic and the relay says
so; it does not quietly send the request, its credential and the fact of this machine
talking to Anthropic out over the ordinary connection instead
([adr/0011-never-leave-except-the-way-the-machine-would.md](adr/0011-never-leave-except-the-way-the-machine-would.md)).

The answer is read from the registry, under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, which is the setting
every HTTP client on the machine reads. It is not read from the environment, which is
the wrong source once we have started: the Window's Code sessions have our own address
in theirs, and a relay that read that would chain to itself. A machine that names an
HTTPS proxy is chained through it. A machine that names nothing goes straight out,
because that is what the machine itself would do. A machine that names only a SOCKS
proxy is refused with the reason, because the relay here speaks HTTP CONNECT and
bypassing is the leak that ADR removed. That refusal is a real answer rather than a gap:
"names no way out" and "names a SOCKS proxy" look the same to code that reads one
setting, and the second must never be silently treated as the first.

**It never asks for more at once than the route can carry.** One exchange used to be one
connection, so 86 concurrent requests meant 86 simultaneous connections through one
local proxy. Most sat in silence waiting their turn and the proxy closed them for being
quiet: 190 failed requests out of about 1,760, all of which would have worked a moment
later. There is now a bound of twelve in flight, and the turn is taken before anything
is dialled, because a tunnel that is not open yet cannot be hung up on for being quiet.
Connections are reused, with an idle bound of five seconds against a proxy measured to
hang up at about fifteen. The measurement is in [mechanism.md](mechanism.md).

## Three traps, all already paid for

A request without the Claude Code system prompt is refused for every premium model with
a message that reads like a spent allowance, while the Seat's own reported Utilization
sits near zero. So a Refusal is evidence about one request and never a verdict about a
Seat ([adr/0005-a-refusal-is-not-proof.md](adr/0005-a-refusal-is-not-proof.md)).

A client told its tunnel is open before the upstream pipe exists loses the bytes it
wrote in between: the handshake dies and the window renders black with nothing in any
log. The bytes that arrive attached to the CONNECT request are pushed back onto the
socket, which mutation testing confirms is load-bearing.

And one that cost an afternoon. Under `%APPDATA%` and `%LOCALAPPDATA%`, renaming a file
onto a name that does not exist yet, in the same directory, fails `EXDEV` every time,
while `copyFile` and `writeFile` in that same directory both succeed. The app's own
store lives under `%APPDATA%` and is not ours to move somewhere friendlier, so
`src/json-file` falls back to a copy after the rename has had its chances. It is not
atomic and does not pretend to be; it is what stands between this and an install that
cannot write the store at all.

## Where everything lives on this machine

| what | where |
| --- | --- |
| the Send tokens | `C:\Users\me\.claude-desktop-relay-secrets\send-tokens.json`, locked by `CryptProtectData` |
| the kept Stats logins | `C:\Users\me\.claude-desktop-relay-secrets\stats-logins.json`, locked the same way |
| the backup archive | `C:\Users\me\.claude-legacy-backup\send-tokens\` |
| everything else of ours | `C:\Users\me\.claude-desktop-relay\`, or what `CLAUDE_RELAY_HOME` names |
| the Seats, the Worklist, the usage memory, the history, the log | inside that folder |
| the local certificate authority | `ca\` inside that folder |
| the relay and the tray as login items | `...\Microsoft\Windows\Start Menu\Programs\Startup\` |
| the Window the user works in | `C:\Users\me\AppData\Roaming\Claude` |
| our variables inside a Desktop folder | `ccd-environment-config.json`, encrypted by the app |
| the `claude` command's own login | `.credentials.json` |

[../CONTEXT.md](../CONTEXT.md) is the vocabulary, and the code uses those words.
[adr/](adr/) holds the decisions, [spec.md](spec.md) the plan, and
[mechanism.md](mechanism.md) the measurements with their dates. MIT licensed.
