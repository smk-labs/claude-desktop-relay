# One relay serves one Desktop folder

A relay is bound to exactly one Desktop folder and one port, and both are read
once, from the environment, when it starts. Two relays never share either. This is
what makes a Proving Window possible: a second Claude Desktop, with its own login,
its own store and its own Payer, relayed independently of the one the user works
in.

## Why not one relay for both

Because a request carries nothing that says which Window started it. Every Code
session speaks the same protocol to the same host with the same shape, so a relay
serving two Windows would have to guess which Payer a request belongs to, and the
whole point of this program is that it never guesses who pays.

The port is the discriminator instead, and it can be, because the address is
written into each Desktop folder's own environment store at install time and read
by that app once at startup (ADR 0009). Two folders, two stores, two addresses,
two relays. Nothing is shared and nothing has to be told apart.

## What that costs

Three environment variables rather than one, and a relay that is one process per
Window rather than one per machine:

- `CLAUDE_RELAY_HOME`: where this relay keeps its Seats, its choice, its usage
  memory and its log.
- `CLAUDE_RELAY_PORT`: where it answers. Fixed per relay, never chosen at random,
  because a store cannot be rewritten after the app has read it.
- `CLAUDE_RELAY_APP_SUPPORT`: the Desktop folder it writes its address into.

Unset, all three name the folder and the port the user's own Window uses, so
nothing about the ordinary case changes. Set, they describe a different Window
completely, which is the only way to prove anything on a real Claude Desktop
without touching the one somebody is working in.

## Consequences

- The Send tokens are in the machine's Keychain under one service name, so a
  Proving Window's relay reaches the same Seats. That is deliberate: proving the
  chain means proving it against a Seat that really pays. Its *choice* of Payer is
  its own, because that lives in its own home.
- Two relays on one machine each hold up to twelve exchanges in flight, so the
  bound of ticket 25 is per relay and not per machine. Two Proving Windows working
  hard at once could reach twenty-four, which is still far below the eighty-six
  that collapsed the route on 2026-08-22, but it is worth knowing rather than
  discovering.
- Uninstalling one relay leaves the other alone, because everything it owns is
  under its own home and its own Desktop folder. The Keychain is the one thing
  shared, which is why `uninstall` refuses to forget the Send tokens unless it is
  told to in so many words.
