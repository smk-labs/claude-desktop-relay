# Two accounts, one relayed

The blast radius is separated by profile, not by variable. Two Claude Desktop
accounts are open at once and only one of them is relayed:

- **The billing Window** is the account the user works in, on the Desktop folder
  the app uses by default. It carries no variable of ours at all. Its Code
  sessions pay from its own subscription and reach the API the way the machine
  already does.
- **The relayed Window** is a second account on a Desktop folder of its own. Every
  Code session in it is swapped onto a Seat. It holds no MCP server, no plugin and
  no setting, and nothing is ever synced into it.

Nothing is shared between them except the machine's Keychain, which is where the
Send tokens already live.

## Why this rather than a narrower variable

The plan before this one was to stop being a proxy: put `ANTHROPIC_BASE_URL` in
the app's store instead of `ALL_PROXY` and serve one local endpoint for Code's API
calls, so the app's other traffic never touched us. That lever does not exist. The
app overwrites `ANTHROPIC_BASE_URL` for every session it spawns. The proxy
variables are the only lever the app leaves alone, which is why the relay is a
proxy and stays one.

That measurement was written up in a handoff document that is not part of this
repository. The short form of it, so the reason survives here: the app builds each
Code session's environment with a fixed object of its own that names
`ANTHROPIC_BASE_URL`, and that name is also on the list it refuses to take from
the store, so there is no way to set it from outside. Both halves are in
[mechanism.md](../mechanism.md), among the five facts.

So the narrowing had to come from somewhere else, and a second profile is a
stronger one than any variable would have been. The disease was that a component
carrying Code's API calls stood in front of the whole app: ten MCP servers,
telemetry, everything, because every child the app starts inherits the store. A
profile with no MCP servers in it has nothing to stand in front of. The blast
radius is not narrowed, it is empty.

## What it costs, and what it does not

- **Two Windows open, on purpose.** That is the user's own decision and the reason
  this is cheap: there is no requirement that the two behave alike, so there is
  nothing to keep in step.
- **No sync, by rule.** Settings, MCP servers and plugins are not copied into the
  relayed Window and never will be. Copying them back is what would reintroduce
  the thing this removes.
- **And no sharing either, which is a separate thing and was nearly missed.**
  Claude Desktop's own connectors are per profile, so a fresh profile has none.
  But **Claude Code** reads `~/.claude` for its plugins, skills, settings and MCP
  servers, and that path is one directory shared by every Window on the machine,
  because `CLAUDE_CONFIG_DIR` is normally unset. A relayed Window reading it would
  start the user's own MCP servers as children of a relayed session, and each of
  them would inherit the relay's address from the store. The blast radius would be
  back, unchanged, while the profile still looked empty.

  So `install` writes `CLAUDE_CONFIG_DIR` into the store of any Window that is not
  the one the user works in, pointing at `code-config` under that relay's own home.
  The decision is taken from the Desktop folder rather than from a flag, so there
  is no way to install the isolated case without the isolation.

  That name can be set this way because the app neither computes it nor refuses it:
  measured 2026-08-24, `CLAUDE_CONFIG_DIR` is absent both from the fixed object the
  app applies after the store and from the ten names its own settings writer drops.
  Unlike `ANTHROPIC_BASE_URL`, which is in both.
- **No login is copied either.** The relayed Window is signed in as its own
  account, by hand, once. `prove --copy-login` exists for a Proving Window that
  has to be the same account; this is a different account, so the whole hazard in
  `docs/testing-on-a-second-profile.md` §2 does not arise.
- **The transport is unchanged.** CONNECT, the blind tunnel, the wildcard
  certificate, ALPN pinning and ADR 0011's `carryingASeat` split all stay. In
  particular `carryingASeat` is not redundant: it is what let the app's own traffic
  survive a dead VPN, and a relayed Window still starts children of its own.
- **Two relays, by ADR 0012.** The relayed Window gets its own home, its own port
  and its own service, because a relay serves exactly one Desktop folder. The Seat
  identities are seeded into that home; the Send tokens are read from the shared
  Keychain, as ADR 0012 already allows.

## One thing the app does not honour, found 2026-08-26

`CLAUDE_CONFIG_DIR` moves what the Code session writes and not what the desktop
side reads. Conversation history and the plugin screen both come from `~/.claude`
whatever it says, so a relayed Window loses the body of every conversation it
records. `code-config/projects` is a symlink to `~/.claude/projects` for that
reason. The measurement and the two wrong turns before it are
[ADR 0016](0016-a-window-is-opened-by-the-machine.md).

## Consequences

- The billing Window is not protected by anything here and does not need to be.
  Claude Code finds the machine's proxy by itself: measured on this machine, a
  session with no proxy variable at all reached the API, while a direct request
  with the proxy refused answers 403 and the same request through it answers 401.
  So removing our variables does not strand it.
- A change to the billing Window's store takes effect only when that Window is
  restarted, and nothing here restarts it. The user does that when they choose.
- `relay doctor` reads the store of the Desktop folder its identity names, so it
  must be pointed at the relayed Window to say anything useful.

## One consequence found on the way, and left as it is

`relay uninstall` cannot remove one relay on a machine that has two. It refuses
while any Seat holds a Send token, and the only way past that refusal is
`--and-forget-the-tokens`, which forgets them by name. The Keychain is shared, and
the other relay lists the same Seats, so taking that path to tidy one relay would
take the working relay's credentials with it.

So the billing Window's relay, once nothing pointed at it, was removed by hand:
its launchd job booted out, its plist deleted, its home archived into
a backup folder and then removed. The Keychain was not touched and every token was
still there afterwards, which was checked rather than assumed.

Left as it is on purpose. The guard is the one that exists because a whole set of
tokens was once lost to a tidy-up, and loosening it to make a second relay
convenient is
the wrong trade. What would be right is for `uninstall` to know that another relay
still lists these Seats and to leave the tokens alone without being asked; that is
a small change and nobody needs it yet, so it is written here rather than built.
