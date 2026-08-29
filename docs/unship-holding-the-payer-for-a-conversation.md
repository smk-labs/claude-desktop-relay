# Unship: holding the Payer for the life of a conversation

Plain-language: a switch used to wait for the next conversation. It no longer waits.
When the Payer changes, every request after that moment is charged to the new Seat,
including requests inside conversations that are already running.

Decided 2026-08-23. This overrides the "Auto decides per conversation" paragraph in
[spec.md](spec.md) and the "Switching" section of [design.md](design.md). Those two
files are the brief and have been corrected to match.

**Done on 2026-08-23.** `src/payer/internal/auto.ts` no longer holds anything per
conversation, `src/payer` reports a switch once per change with what it re-cached,
`relay auto` and `relay status` say so, and the tests assert the opposite of what
they used to. ADR 0003 is marked superseded rather than rewritten.

## Why it goes

The rule bought one thing, a warm prompt cache, and charged three things for it: a
Payer you chose that was not paying yet, a page that had to explain the delay, and a
second Seat visible on screen that the user had not asked for. Nobody could hold it in
their head, and the interface spent its clearest space apologising for it. The cache
saving is real and it is smaller than the cost of not understanding your own tool.

## What changes in the engine

- **Chooser / Payer.** Drop the per-conversation lock. The Payer is one value for the
  machine, read fresh on every request that the relay swaps.
- **Conversation.** The module still decides new-conversation versus continuation,
  because the history and Auto's ranking want it. It no longer gates the swap.
- **Rotate on a Refusal** stops being
  a special case. A Refusal picks a new Payer the same way any switch does. The Seat
  still goes on cooldown for that model, and the switch is still stated.
- **Manual and the tray.** A click takes effect now. Delete the pending state, the
  "takes effect on the next conversation" wording, and the "Apply now" control with
  its token estimate. There is nothing left for them to say.

## What the user must be told, once

Switching mid-conversation re-sends that conversation uncached to the new
organization. On a long session that is real money: the design's own example was 38
exchanges, about 412k tokens. The page should state the cost **after** the fact, in
the log, not as a gate before it:

    14:26:04  switched  Acme-2, 6.25x, in force now, 2 conversations re-cached

That is the whole treatment. No confirmation dialog, no estimate beforehand.

## Tests to change

`test/conversation.test.ts` and `test/auto-mode.test.ts` assert the hold. `test/rotate-on-a-refusal.test.ts`
asserts the mid-conversation rotation as an exception; it becomes an ordinary switch.
Replace the hold assertions with the opposite: a Payer change is visible on the very
next request of a conversation already in flight.

## One Window

The interface now assumes a single Window, because a second one only appears if the
user signs out and in again. `Proving Window` stays what it always was: a thing the
tests open, never a thing the page draws. The per-Window Payer idea in
[later-ideas.md](later-ideas.md) is dead rather than deferred, since one Payer for the
machine is now the whole model.
