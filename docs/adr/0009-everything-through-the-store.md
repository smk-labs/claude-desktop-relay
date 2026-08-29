# Everything through the app's own store, because the user opens the Window

ADR 0006 split the variables in two: the proxy names handed to the Window at
launch, the certificate through the app's encrypted store. That split assumed we
launch the Window. The user does not want that. They open Claude Desktop from the
UI, as they always have, and expect the relay to be there.

Nothing can be handed at launch to a Window we did not start. So everything goes
through the store: the eight proxy names in every case and scheme, and the
certificate with its companion. Neither is on the app's own blocklist, and the
store is applied last when the app builds a Code session's environment, so both
win over the values the app computed for itself.

Measured on 2026-08-21, and the measurement is why this is written down rather than
assumed. The app reads that store exactly once, caches it for the life of the
process, and watches nothing. Its proxy is resolved once through Electron and
memoised the same way. See [mechanism.md](../mechanism.md).

## Consequences

**One restart, once.** Writing the store takes effect for every Window opened
after the app is next started, however the user opens it. There is no way to
attach or detach a Window that is already running, and no amount of cleverness
changes that: both doors are read once.

**Turning the relay on and off is not a plumbing change.** It happens inside the
relay, live, by choosing a Seat or choosing Off. Off passes the caller's own
credential through untouched, which is what makes it indistinguishable from not
having installed this. That is the seamless part, and it needs no restart of
anything.

**The relay has to outlive every session.** The store points Code sessions at a
fixed address, so if nothing is listening there, Code sessions cannot reach the
network at all. The app itself is unaffected: it uses the system proxy, not these
variables. So a relay that is down costs Code sessions and not the whole app, but
it still has to be a service that starts at login and comes back when it dies.
That makes ticket 17 a prerequisite for this design rather than a later nicety.

**The address has to be fixed.** A port chosen at random cannot be written into a
store that is read once. The relay takes a port and keeps it.

**The way out stays one command.** Removing our names from the store returns the
machine to normal at the app's next start, and anything the app or the user keeps
in that store is left alone.

## What this replaces

ADR 0006's reasoning about which variable needs the store is still correct and its
measurement still stands. What changes is scope: it is not one variable, it is all
of them, because the launch-time half of that decision assumed a launch we do not
perform.
