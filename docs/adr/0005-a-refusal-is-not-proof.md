# A Refusal is never trusted as "this Seat is out"

Requests missing the Claude Code system prompt are refused for every premium model
with a rate-limit error whose message is the word "Error", while the Seat's own
reported Utilization sits near zero and the account's app shows full capacity.
Measured 2026-08-21: adding that system prompt turned the same request from refused
to accepted. Haiku is exempt, which makes the false signal look like a per-model
limit.

## Consequences

The relay treats a Refusal as evidence about one request. It re-checks the request's
own shape before it will believe a Seat is spent, and any probe it sends on its own
is shaped like a real Code request or it proves nothing.

## The shape test is not the only evidence (2026-08-26)

Shape alone was too narrow. Over six hours of real traffic one Seat answered eight
429s and every one of them failed the shape test, so nothing was put on cooldown and
no work was moved, while the same replies carried a five-hour Utilization of 1.02.
The Refusal this ADR is about is the one that arrives with the Seat untouched, so a
window the server itself puts at or past its whole cannot be it.

So a Refusal is about the Seat when the request was shaped like Code **or** when the
reply's own Utilization says a window is spent. The second half reads the server's
statement instead of guessing at our own request, and the ranking no longer depends
on a Refusal at all: a Seat known to be at or past its five-hour window is ruled out
until that window turns over.

