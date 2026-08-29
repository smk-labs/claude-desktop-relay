# Coverage: which paths land on the Seat we chose

Measured, path by path, on a Proving Window with a negative control armed: that
Window's own credential cannot buy anything, so work that completes can only have
completed through the relay. Counting requests would prove nothing, because a
request that went round the relay is simply absent and an absence looks exactly
like work that never happened.

Written by `relay prove --matrix`. Re-runnable: after a Claude Desktop update,
`relay prove --start <path>` each row again.

| Path | Result | Measured | What the relay saw |
| --- | --- | --- | --- |
| A plain conversation in the Window | covered | 2026-08-23, Claude Desktop 1.34493.1 | 57 verified, 0 to another Organization, 33 unproved |
| A single subagent inside a session | not measured yet | — | — |
| Several subagents at once | not measured yet | — | — |
| A workflow fanning out across agents | covered | 2026-08-23, Claude Desktop 1.34493.1 | 180 verified, 0 to another Organization, 91 unproved |
| A nested claude started from a shell command | not measured yet | — | — |
| Auto-compaction and the app's own summarising | not measured yet | — | — |
| Conversation titles and other small side-requests | not measured yet | — | — |
| A scheduled task firing with nobody watching | not measured yet | — | — |
| Work inside the Cowork virtual machine | not measured yet | — | — |
| A session on another machine over a remote connection | not measured yet | — | — |
| A cloud session | not measured yet | — | — |
| Traffic from MCP servers | not measured yet | — | — |

## Known limits

Nothing measured so far falls outside the relay.

## What each row means

- **A plain conversation in the Window** — The baseline. If this fails, nothing below means anything.
- **A single subagent inside a session** — Same process, same environment. Expected covered by construction.
- **Several subagents at once** — Adds concurrency, which is where the collapse of 2026-08-22 lived.
- **A workflow fanning out across agents** — Same process again, but many agents and a real fan-out.
- **A nested claude started from a shell command** — A separate process. Covered only if the app passes its environment down.
- **Auto-compaction and the app's own summarising** — A request the app makes for itself, not one the user asked for.
- **Conversation titles and other small side-requests** — These may come from the app rather than a Code session, which is a different process.
- **A scheduled task firing with nobody watching** — Fires without a session in front of it, so it may be started differently.
- **Work inside the Cowork virtual machine** — Its own network stack and its own address. The one most likely not covered.
- **A session on another machine over a remote connection** — Out of scope by the spec. Recorded as a stated limit rather than an omission.
- **A cloud session** — The request never leaves from here, so the relay cannot move it.
- **Traffic from MCP servers** — An MCP server talks to its own host with its own credential and costs no allowance. What it returns becomes input tokens on whichever Seat is paying.
