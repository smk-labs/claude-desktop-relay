# Proxy variables at launch, the certificate through the encrypted store

The Window builds each Code session's environment from its own environment first,
then its computed proxy values, then the user environment store last. So proxy
variables set at launch survive, but the certificate variable does not: the app
computes its own value in the middle step and overwrites ours. Measured on Windows
2026-08-21, where the traffic reached the relay and the certificate was rejected.

## Consequences

Only one variable needs the encrypted store, which is also the only part that needs
per-platform crypto. Everything else is passed at launch and is identical on macOS
and Windows.

## Since written

Two variables go through the store, not one: `NODE_EXTRA_CA_CERTS` and
`NODE_USE_SYSTEM_CA`. The second is a companion, so that adding our authority does
not stop a Code session trusting the machine's own roots. The point of the decision
is unchanged, and the split is still one concern against everything else: the
proxy names are handed over at launch, the certificate and its companion are not.

The names live in one place, `src/app-store`, derived from the function that writes
them, so what the undo command removes cannot drift from what the start command
put there.

## Superseded in scope by ADR 0009

The measurement here holds: the app overwrites the certificate variable and not the
proxy names. What has changed is that the user opens the Window from the UI, so
there is no launch of ours to hand anything to, and every variable goes through the
store instead. See [0009](0009-everything-through-the-store.md).
