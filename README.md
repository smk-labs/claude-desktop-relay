# claude-desktop-relay

One Claude Desktop window. Several of your own Claude subscriptions behind it.

Claude Desktop runs Claude Code as a separate program and hands it a token saying
which account pays. It also, by its own design, sends that program's traffic
through whatever proxy the machine has. So a small local proxy can decide which of
your own subscriptions pays for a session, without modifying the app: nothing
inside the Claude Desktop bundle is touched and its signature stays valid.

It picks the account with the most room by itself, moves off one that turns it
away, remembers what each has spent and on which project, and answers all of it
from one command. There is a page and a tray as well as the terminal.

## What it is not

Not a way to share one subscription between people, and not a way around any
limit. Every account it uses is one you pay for, and running out of an account's
allowance fails the request rather than billing anything else.

## This is a beta, and here is the exact reason

**Adding an account works, and it is a sitting rather than a screen.** One command
finds every account you are already signed in to, then walks you through them one
at a time: it mints the credential, asks the server which Organization that
credential actually pays for, keeps it, and moves on. It is resumable, and it
backs up after every account. What it is not yet is something you would hand to
somebody who has never opened a terminal. Claude Code itself is good company for
that first sitting.

**Coming next: adding and managing accounts without the sitting.** One place that
lists what you have, adds one, retires one, and says what each is costing you.
Everything underneath it already exists and is tested. What is missing is the
front of it.

Nothing else here is beta. The engine is finished and every claim it makes about
who paid is settled by the server's own answer rather than by anything this
program logged. What this release knows it does not do, including what an audit
found and this release left alone, is written down in
[docs/known-gaps.md](docs/known-gaps.md) rather than left to be discovered.

## Three machines, one program

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| the relay, the ranking, the history | yes | yes | yes |
| one command for all of it | yes | yes | yes |
| the tray | yes | yes | yes |
| starts itself with the machine | yes | yes | yes |
| the page | yes | yes | no |
| adds accounts without copying and pasting | yes | yes | no |
| reads idle accounts' usage from your own logins | yes | yes | carried in, not read |
| carries a machine that names only a SOCKS proxy | yes | no | no |

The relay itself, and everything that decides with it, is one body of code on all
three. What differs is at the edges: where credentials are kept, how the machine
says a program should start with the session, how a window is opened. macOS and
Windows share their entry points and dispatch on the machine inside the handful of
files that genuinely differ, which is
[ADR 0015](docs/adr/0015-one-body-of-code-two-machines.md) and the list of what
those edges are. Linux keeps its own smaller entry points and borrows the same
engine, which is why the bounds that were learned the hard way on macOS, on how
many exchanges may be in the air and how long a reused connection may idle, hold
there without having been learned twice.

## Pick your machine

Each of these is the whole guide for one machine and mentions no other.

- **[macOS](docs/macos.md)**
- **[Windows](docs/windows.md)**
- **[Linux](docs/linux.md)**

A release archive carries one machine and one README, so nothing you read in it is
about a machine you do not have:
`claude-desktop-relay-macos-<version>.tar.gz`,
`claude-desktop-relay-windows-<version>.zip`,
`claude-desktop-relay-linux-<version>.tar.gz`.

## How it is proved

The claim is that a chosen account paid for a request, and the only thing that can
settle it is the server. So that is what is asked. A request is sent shaped the way
a Claude Code session's request is shaped, and the reply names the Organization
that was billed. Shaped that way or it proves nothing: without the Claude Code
system prompt the server refuses every premium model with a message that reads
like a spent allowance, while the account's own reported usage sits near zero. So
a refused request is evidence about one request and never a verdict about an
account ([ADR 0005](docs/adr/0005-a-refusal-is-not-proof.md)).

[docs/mechanism.md](docs/mechanism.md) is the record of what was measured, with
dates. [docs/adr](docs/adr) holds the decisions and why each one was taken.

## How it is built

TypeScript for Node 24 or later, with **no runtime dependencies at all**. Each
folder under `src/` is a module whose `index.ts` is its whole interface, and
nothing outside it may reach into its subfolders. That is a test rather than a
convention: the suite fails on a crossing, and the rule is proved red against a
tree written to a temporary folder.

```bash
npm install
npm run typecheck && npm test
```

## The words this uses

An account, an Organization, a Seat and a Payer are four different things here,
and using one where another is meant is how a program tells itself a swap worked
when it did not. Comparing an Organization's label against its id is the specific
version of that mistake. [CONTEXT.md](CONTEXT.md) is the vocabulary, and it is
worth five minutes before anything else.

## Licence

MIT. See [LICENSE](LICENSE).
