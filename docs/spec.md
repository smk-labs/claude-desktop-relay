# Spec: the relay, the dashboard, and Auto mode

Covers the first three phases. The vocabulary is [CONTEXT.md](../CONTEXT.md); the
decisions behind it are in [docs/adr](adr).

## Problem Statement

Somebody who pays for several Claude subscriptions, across several accounts, has
no way to spend them from one place. Until now the only way to spend a Seat was to
open a whole second Claude Desktop logged into that account, so the machine
carried one profile per account, a background service to keep their conversation
lists in step, a per-profile copy of the Claude Code CLI, and a virtual machine
disk each. Tens of gigabytes of disk and a standing maintenance burden, to answer
one question: which subscription should pay for this session?

Worse, the answer was usually wrong. A Seat that resets in two hours and sits unused
loses that allowance for good, while the Seat in front of the user runs dry.

## Solution

One Window stays logged in forever. A small local service decides which Seat pays
for each Code session and swaps the credential on the way out. The user picks from a
short list, or lets Auto pick, or turns it off and spends the Window account's own
allowance.

Nothing in the Claude Desktop bundle is modified. Removing one file and stopping one
service returns the machine to normal.

## User Stories

1. As the user, I want one Claude window that is always logged in, so that I never
   sign in again to change which subscription pays.
2. As the user, I want to see every Seat I own in one list, so that I know what I
   have without opening eight windows.
3. As the user, I want each Seat's five-hour and seven-day Utilization on that list,
   so that I can tell at a glance which one has room.
4. As the user, I want each Seat's Multiplier shown, so that "40% left" means
   something comparable between a 20x Seat and a 1.25x one.
5. As the user, I want the time each allowance window resets, so that I can tell
   capacity that is about to expire from capacity I can save.
6. As the user, I want to pick a Seat by hand and have it stick, so that a deliberate
   choice is not overridden by the app.
7. As the user, I want an Auto mode that picks the best Seat for me, so that I stop
   thinking about it.
8. As the user, I want Auto to prefer the Seat whose allowance is about to reset
   unused, so that I stop throwing capacity away.
9. As the user, I want Auto to weight a Seat's Multiplier, so that a big Seat at 50%
   beats a small one at 10%.
10. As the user, I want a switch to be in force at once, even inside a conversation
    that is already running, so that the Payer I chose is the Payer that is paying.
11. As the user, I want an Off mode, so that everything lands on the Window account
    exactly as if the relay were not installed.
12. As the user, I want the current Payer named at the top of the interface, so that
    "who is paying right now" is never a guess.
13. As the user, I want the app to prove the swap worked from the server's own
    answer, so that I am never told success on a session that quietly billed the
    wrong Seat.
14. As the user, I want a loud, specific failure when the swap does not happen, so
    that I find out from the app and not from a bill.
15. As the user, I want the relay to fall back to the Window account when no Seat can
    serve, and to say so, so that work continues and I know why.
16. As the user, I want a Refusal on one Seat to move the work to another, so that a
    spent allowance costs me a moment, not an afternoon.
17. As the user, I want a Seat that just refused to be left alone for a while, so
    that Auto does not walk into the same wall repeatedly.
18. As the user, I want the relay never to conclude a Seat is spent from a Refusal it
    caused itself, so that a malformed probe does not retire a healthy Seat.
19. As the user, I want to add a Seat by following on-screen steps, so that minting a
    token is not something I have to remember how to do.
20. As the user, I want to re-mint an expired Send token from the interface, so that a
    yearly chore is one button.
21. As the user, I want my Send tokens stored where the machine keeps secrets, so
    that a stray file copy does not hand someone my subscriptions.
22. As the user, I want the relay to read nothing from my messages beyond the model
    and how far into the conversation I am, so that my prompts stay mine.
23. As the user, I want the list filterable and groupable by account and by
    organization, so that a long list of Seats stays legible.
24. As the user, I want Seats whose week has not started shown apart, so that I can
    see untouched capacity rather than hunting for zeroes.
25. As the user, I want token counts available but folded away, so that the first
    screen stays a percentage and the detail is there when I want it.
26. As the user, I want the relay to survive a reboot, so that I do not start it by
    hand.
27. As the user, I want the relay to run without administrator rights, so that
    installing it is not a security decision.
28. As the user, I want one command that undoes everything, so that trying this is
    reversible.
29. As the user, I want the app to notice when Claude Desktop updates in a way that
    breaks the mechanism, so that the failure is a message and not a mystery.
30. As the user, I want the Window account itself treated as one of the Seats, so
    that the subscription I already pay for is not left idle.

31. As the user, I want a history of what each Seat spent, so that I can see whether
    it reached 40% in an hour or over four days.
32. As the user, I want spending broken out by kind of token, so that I can tell an
    expensive habit from a cheap one.
33. As the user, I want to know which project the spending was for, so that I can see
    which repository is eating a subscription.
34. As the user, I want history kept without any of my prompts in it, so that a record
    of spending is not a record of my work.
35. As the user, I want old rows folded into daily totals, so that the history does
    not grow without end.

## Implementation Decisions

**One service, several deep modules.** A single Node process, no runtime
dependencies, launched as a per-user launchd agent. Modules, each hiding everything
about how it does its job:

- **Relay.** The HTTP CONNECT proxy. It is given a function that returns the token to
  use for a request and a callback that receives the facts of each exchange. Only
  `api.anthropic.com` is opened; every other host is tunnelled untouched. Chains to
  the machine's existing proxy so egress is unchanged. Swaps only on the message
  endpoint, never on every path under `/v1/`.
- **Seats.** The list of Seats and their credentials. Send tokens live in the
  Keychain; the store holds identity and Multiplier only.
- **Usage.** What is known about each Seat's allowance. Fed by the Relay's exchange
  facts, which carry the paying organization, both Utilizations, both reset times and
  the overage status; also fed by Stats. Holds the per-Seat, per-model cooldown a
  Refusal creates.
- **Stats.** Reads Multipliers and idle-Seat usage through Stats logins. Never
  required: every consumer must work when it returns nothing.
- **Chooser.** Pure function. Given the Seats, what Usage knows, the Mode, the manual
  pick and the model, it returns a Seat and a reason. No I/O, no clock of its own.
- **Conversation.** Decides whether a request begins a new conversation, from the
  model and the number of messages only. It is the one module allowed near the request
  body and it may not retain or emit any message content.
- **Launcher.** Starts the Window with the proxy variables in its environment and
  writes the one variable that must go through the app's encrypted environment store.
- **Verify.** Compares the Seat the Chooser picked against the organization the server
  says paid, per exchange, and turns a mismatch into a loud failure.
- **Control.** A local HTTP interface and the page it serves: list Seats, set the Mode,
  set the manual pick, read the current verdict.

**The Chooser's rule.** Score each Seat as its Multiplier times its remaining weekly
share, divided by the hours until that week resets raised to a power, so urgency
outweighs raw capacity; then adjust by how the five-hour window's remaining share
compares with the share of that window still ahead, which rewards capacity about to
expire and penalises a Seat on course to lock out. Free Seats never win. A Seat under
cooldown for the requested model is not a candidate. This rule is carried over from
claude-deck, where it was tuned in use.

**One Payer for the machine, in force now.** It is weighed again on every request
that is swapped, and a change reaches conversations already running. That re-sends
their history uncached to the new organization, which is real money on a long
session, so it is stated in the log after the fact and never made into a gate. The
hold this replaced is [the unship note](unship-holding-the-payer-for-a-conversation.md).

**A Refusal is evidence, not a verdict.** Before a Refusal counts against a Seat, the
request's own shape is checked. Any probe the service sends on its own behalf is shaped
like a real Code request or it proves nothing.

**Failure is closed, never quiet.** If the relay cannot serve, the request fails or
lands on the Window account with a stated reason. It must never silently charge a Seat
the user did not choose.

## Testing Decisions

A good test here drives a module through its own interface and asserts what a user or
the next module would observe: the header that left, the Seat that was chosen, the
message that was shown. None of them may reach the network, the Keychain or the real
Claude Desktop; the fakes go in at the module edges.

Three seams, and the first is the one that matters:

1. **Through the Relay, against a fake upstream.** Start the relay, point it at a local
   server holding our own certificate, drive real requests through it, and assert the
   outgoing authorization header, that other hosts are passed through untouched, that
   bodies stream rather than buffer, and that the exchange facts reported back match
   the headers the fake sent. This one seam covers the Relay, Verify and the wiring
   between them. Prior art: `dashboard/proxy-selftest.js` in claude-deck stands up
   three local fake proxies and proves a burned-token distinction with nothing
   reaching Anthropic.
2. **The Chooser, as a table.** A list of Seats with Multipliers, Utilizations, reset
   times and cooldowns in; an expected Seat and reason out. Cheap, exhaustive, and the
   only place the ranking rule is pinned down.
3. **Conversation, on recorded request shapes.** New conversation versus continuation,
   and a test that asserts no message content appears in anything the module emits.

Node's own test runner, no framework. Every test is runnable as a plain script, the
way claude-deck's two self-tests are, so a failure is readable without tooling.

## Out of Scope

- The Swift menu-bar app. Phase four; until then the interface is the page the service
  serves.
- Windows. Phase three at the earliest, and a translation of a settled design rather
  than a design (ADR 0007).
- Learning a Seat's absolute size from traffic, though the history in tickets 18 and
  19 is what will make it possible. The Multiplier comes from Stats, which
  states it outright; deriving token capacity is only for the folded-away detail and
  waits for phase two data.
- Two Windows of the same account at once, each on its own Payer.
- Pointing the engine at a non-Anthropic provider. See [later-ideas.md](later-ideas.md)
  for which destinations that is even possible for, and why Cursor is not one of them.
- Pointing the engine at anything other than Anthropic. Mechanically the same lever,
  a protocol translation in size; sketched in ticket 22.
- Anything that moves Cloud sessions, Remote Control, or sessions that run on another
  machine. The relay can only move a request that leaves from here.
- Refreshing or re-minting Stats logins. They are read until they die.

## Further Notes

The mechanism rests on measurements, not assumptions, and they are recorded in
[docs/mechanism.md](mechanism.md) with the dates. Two of them are worth repeating here
because they will bite whoever forgets them: a request without the Claude Code system
prompt is refused for every premium model with a message that reads like an exhausted
allowance, and the one-year Send token cannot read usage from any endpoint, so the
percentages only ever arrive attached to a real reply.
