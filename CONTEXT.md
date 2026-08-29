# Claude Desktop Relay

One Claude Desktop window stays logged into one account forever. The relay decides
which of the user's own subscriptions pays for each Claude Code session.

## Language

### The window

**Window**:
A running Claude Desktop instance. There is one the user works in, and that one is
what "the Window" means everywhere unless something says otherwise. Nothing closes
it: `closeWindowOn` refuses its Desktop folder whatever it is asked.
_Avoid_: profile, instance, app

**Desktop folder**:
The folder a Claude Desktop instance keeps its own state in, the environment store
included. It is the only thing that tells one Claude Desktop apart from another, so
a second folder is a second Window, with its own login, its own store and its own
Payer.
_Avoid_: profile, user data dir, support folder

**Proving Window**:
A Window kept only to prove the mechanism, with its own Desktop folder, its own
relay and its own Payer. It may be opened and closed freely, which the Window may
never be. Every claim about a path being covered is measured here.
_Avoid_: clone, test window, second profile

**Window account**:
The account the Window is logged in as. It owns the UI, the settings and the
entitlements, and it can also pay.
_Avoid_: front account, default profile

**Code session**:
The Claude Code program the Window launches as a separate process. Its requests
are the only ones the relay can move.
_Avoid_: CLI, agent, terminal

### Who pays

**Seat**:
One account in one Organization that can pay for requests. This is the unit that
holds an allowance, and the unit the user picks between. One account with three
Organizations is three Seats, unless one of those Organizations is free or exists
only to evaluate the API, because an Organization that cannot pay yields no Seat.
Its name is derived from the account and the Organization rather than invented, so
the same pair always yields the same name.
_Avoid_: profile, account, line, pair

**Organization**:
The billed group a Seat belongs to. It has two names that are never
interchangeable: an **Organization id**, which is what the server calls it and the
only thing a claim about who paid can be checked against, and an **Organization
label**, which is what the user reads and what the user may change at any time.
Comparing a label against an id is how an app tells itself a swap worked when it
did not.
_Avoid_: org, team, workspace, tenant

**Payer**:
The Seat currently chosen to pay for a Code session's requests.
_Avoid_: active profile, current account

**Multiplier**:
A Seat's weekly capacity relative to a Pro plan, as a number: 20, 6.25, 5, 1.25, 1,
or 0 for free.
_Avoid_: plan, tier, seat tier

**Worklist**:
Every Seat the user owns, discovered from their own logins rather than typed, each
one either filled or missing. A Seat is **filled** when it holds a Send token and
**missing** when it does not.
_Avoid_: inventory, todo, queue, list of accounts

### Credentials

**Send token**:
The long-lived credential that lets a Seat pay for requests. One per Seat. It can
send and nothing else.
_Avoid_: oauth token, api key, setup token

**Stats login**:
A claude.ai browser session belonging to an account, used only to read that
account's Seats, their Multipliers, and their usage. It can read and never sends.
_Avoid_: session key, cookie, login

**CLI login**:
The credential the `claude` command keeps for itself, in one Keychain entry keyed
by the OS user. `CLAUDE_CONFIG_DIR` moves every file that command writes and does
not move this, so an isolated config folder does not isolate it. It is the user's
own login: nothing here writes to it, and a mint that did would be seen before a
second one ran.
_Avoid_: claude credentials, machine login, keychain entry

**Probe**:
One real request the app sends on its own behalf, shaped like a Code session's, to
make the server name the Organization that paid. It is the only way to learn which
Seat a Send token belongs to, and it is shaped that way or it proves nothing
(ADR 0005).
_Avoid_: ping, health check, test request

### Allowance

**Allowance window**:
A period over which a Seat's usage is capped. There are two, five hours and seven
days, and they run independently.
_Avoid_: quota period, limit

**Utilization**:
The share of an Allowance window a Seat has already spent, as the server reports it.
_Avoid_: usage, percentage

**Refusal**:
A server answer that declines a request. A Refusal is evidence about one request,
never proof that a Seat is out of allowance.
_Avoid_: rate limit, 429, exhausted

### Behaviour

**Mode**:
How the Payer is chosen. **Auto** picks the best Seat, **Manual** holds the Seat the
user picked, **Off** leaves every request on the Window account.
_Avoid_: state, setting
