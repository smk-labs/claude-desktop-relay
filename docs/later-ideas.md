# Later ideas, and one distinction that decides which are possible

Not scheduled. Recorded so the reasoning is not redone from scratch.

## Pointing the engine at another provider

The relay terminates TLS on the message endpoint, so it can send a request anywhere,
not only replace its credential. Claude Desktop sets the base URL for its Code
sessions itself and that name sits on the app's own blocklist, so the relay is the
only lever there is on Desktop. In the CLI no relay is needed at all: the base URL is
just a setting.

**The distinction that decides everything: does the destination sell an endpoint, or
only an agent?**

- **An endpoint** speaks a message protocol and accepts a credential per request.
  OpenRouter has an Anthropic-compatible one; so do the other API providers, and so
  would a model served on one's own GPU. For these the relay path is real work but
  ordinary work: translate the protocol in both directions and be honest about what
  does not survive translation.
- **An agent** has its own loop, its own tools and no per-message surface. Cursor is
  this: its subscription is spent by its editor and its CLI, and there is no
  subscription-backed API to point anything at. Pointing the relay at it is not hard,
  it is meaningless — there is nothing there to receive the request.

So for Cursor, **delegation stays the right shape**: run its agent alongside and hand
it whole self-contained tasks, which is what the `cursor-delegate` plugin already
does. Wrapping an agent to look like a model endpoint would put one agent loop inside
another, and both would fight over the same job.

## What translation would cost, if it is ever done

Everything our own app is built on comes from Anthropic's rate-limit headers: which
organization paid, how much of each window is spent, when it resets. No other provider
sends them. The moment a request is routed elsewhere, Seats, Utilization and the whole
notion of a best Seat stop meaning anything for that request, because the other side
is priced per token rather than per subscription.

That is not a reason against it. It is the reason it must be a separate mode with its
own accounting, never a Seat in the same list.

## Corner cases anyone attempting this should expect

Streaming event shapes, tool-use and thinking blocks, cache control, the model list
the app's own picker reads, the beta flags, the usage fields, and the refusal
behaviour. A partial translation does not fail loudly; it fails as a series of small
inexplicable defects, which is the worst failure mode this repo has a rule about.
