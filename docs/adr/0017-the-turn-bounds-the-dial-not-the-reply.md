# 0017. The turn bounds the dial, not the reply

2026-08-30

## What was decided

The relay keeps two bounds instead of one.

- **`gate`, twelve.** Held from the dial, through sending the request, until the
  head of the reply arrives. This is the bound that protects the route.
- **`exchanges`, forty-eight.** Held from the start of the exchange until the last
  byte reaches the caller. This is the bound that protects the machine.

A turn is handed back the moment the reply's head is in. What follows runs under
the looser bound.

## Why

The single bound was written on 2026-08-22, after the relay held 86 exchanges at
once and the machine's proxy hung up on most of them. That reading was right and
is not being revisited. What was missed is that it sized a bound on *dials* and
then applied it to *whole exchanges*, and those are different populations.

Six days of this relay's own log say what that cost:

- **14.3% of all requests never got sent.** 3,414 of them died waiting for a turn.
  On 2026-08-30 the figure for the day was 39.5%.
- **Half of all requests waited more than ten seconds** for a turn. A tenth waited
  more than ten minutes. The worst wait recorded was 51.7 minutes.
- **Every busy hour landed in the same narrow band**: between 31 and 38 seconds of
  turn-holding per request served, across 1,148 to 1,383 requests an hour.

That band is the tell. It is not load, it is arithmetic: twelve turns divided by
about thirty seconds of reply is roughly 1,400 requests an hour, and the relay
was sitting on that ceiling every time it was busy. The comment in `gate.ts` said
"the queue behind it drains in the time one exchange takes", and that was the
assumption that did not hold, by three orders of magnitude.

## Why releasing at the head is safe

The objection to answering this by releasing the turn earlier is a good one, and
it is the reason the line is drawn at the head rather than anywhere else.

The 2026-08-22 collapse was not caused by handshakes. This repository's own note
in `internal/pool.ts` records the mechanism: the machine's proxy hangs up on a
**quiet tunnel** at about fifteen seconds, and the 86 exchanges "sat in silence
waiting their turn". The dangerous population is open and silent, not open and
busy.

So the question is which part of an exchange is silent. It is the part before the
head: the dial, the request, and the wait for the first token. That whole stretch
stays inside the turn. After the head the reply is arriving, the tunnel is
visibly alive, and it is no longer the shape that collapsed anything.

## Why forty-eight

Measured on the machine this runs on rather than chosen.

`launchctl limit maxfiles` gives this service a soft limit of **256** descriptors,
and the relay holds **42** at idle. An exchange costs two, one to the caller and
one to the upstream, so forty-eight costs 96 against 214 free. That leaves room
for the pool's warm sockets and for the fact that the pool keeps an agent per
Seat, so its socket bound is per Seat and not global.

Memory is the other wall and it is the reason not to go higher: a held body may
be 4MB (`internal/body.ts`), so this is also a cap of 192MB on bodies in hand.

## What this changes elsewhere

- `pool.ts` sizes `maxSockets` from the exchange bound, not the gate. Sizing it
  from the gate would have queued streaming exchanges inside Node's own agent,
  which is the one queue in this program with nothing watching it.
- Two assertions in `test/relay-under-load.test.ts` were rewritten. Both kept
  passing under the split while no longer measuring what their names claimed,
  which is the failure mode a green suite cannot report.

## What was not decided

The blind tunnel path takes no turn at all and never has. Every MCP server and
every non-Anthropic host opens unlimited concurrent tunnels through the same
machine proxy, outside both bounds. If the proxy's socket table is really what
collapses, that is a larger hole than anything here, and it is left open
deliberately rather than by oversight: closing it means bounding traffic that is
the app's own and would have gone straight out if this program had never been
installed. See ADR 0011 for why that distinction is load-bearing.
