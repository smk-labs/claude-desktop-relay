# Keep the allowance headers verbatim, parse only what was measured

Four header names were measured on real replies and are written down in
[mechanism.md](../mechanism.md): the paying organization, both Utilizations, and
the overage status with its reason. The reset times were not. No document in this
repo names the headers that carry them, and the one-year Send token cannot read
usage from any endpoint, so there is nowhere else to look: the names only arrive
attached to a real reply.

The spec asks the relay to report both reset times. Guessing a name that mirrors
the Utilization ones would either work silently or fail silently, and a Seat whose
reset time reads as "unknown" for a year because of a typo in a header name is
exactly the kind of failure this project is meant not to have.

So the relay keeps every header the reply carried, verbatim, in the facts of each
exchange, alongside the five fields it can name. Not a filtered subset: filtering
on a prefix would be a second guess, and a reset time arriving under a name we did
not expect would be dropped before anyone could measure it. A reply header cannot
carry message content, so keeping all of them costs nothing the spec cares about.

## Consequences

Reset times are available as soon as one real reply has been seen, by reading the
kept headers and naming what is there. Until then the typed fields are the five
measured ones, and a consumer that wants a reset time reads the map and finds
nothing rather than finding a wrong answer.

The typed fields repeat values that are also in the map. A consumer that reads both
and adds them up would count twice, so the typed fields are the ones to read and
the map is for what has no field yet.

The first real session is therefore also a measurement: whoever runs it should
record the allowance headers it came back with, add the names to
[mechanism.md](../mechanism.md) with the date, and promote them to typed fields.

## Since measured

On 2026-08-21 a real reply settled the names this ADR was written to avoid
guessing. The reset times arrive as `anthropic-ratelimit-unified-5h-reset` and
`-7d-reset`, in seconds since 1970, and are now typed fields. The measurement also
showed the overage reason header is `anthropic-ratelimit-unified-overage-disabled-reason`,
where this repo had recorded the shorter `overage-disabled-reason`: code written to
the short name would have read null forever and never said so, which is the exact
failure this decision was made to avoid. See [mechanism.md](../mechanism.md).

Keeping every reply header stays the rule. It is what made the correction a change
of one constant rather than a lost measurement, and there are still four headers
here that nothing reads yet.
