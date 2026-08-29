# Two credentials per Seat, each with one job

A Send token can pay for requests and cannot read anything else: five different
usage and profile endpoints all refuse it for lack of scope, measured 2026-08-21.
So reading a Seat's Multiplier and its idle usage needs a Stats login as well.

## Consequences

The two are never interchangeable and never merged. The Send token is the pillar:
without it nothing can be paid for. The Stats login only makes the picture nicer,
and the app must keep working when one dies. Multipliers are read once and stored,
because they change rarely; usage of the Seat in use comes free with every reply.
