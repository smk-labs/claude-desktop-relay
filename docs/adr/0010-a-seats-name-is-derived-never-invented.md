# A Seat's name is derived from what it is, never invented

A Seat's name is the key everywhere: it names the Keychain entry, it is what the
Payer file points at, and it is what the user types to switch. Somebody with
several accounts owns more Seats than they want to name, and asking them to think
of a name apiece is both tedious and the kind of thing that gets done differently
on the second sitting.

So the name is a function of the account and the Organization: the email's local
part, part of the Organization label, and four characters of the Organization id.
`bo@example.com` in `Acme` is always `bo-acme-c3d4`.

The id fragment is there because the label is not unique. The account
`fin-user@example.com` belongs to two different Organizations that are both
labelled "Acme", so a name built from the account and the label alone would
be the same for both. The id is the only thing that identifies an Organization
(see [0008](0008-keep-the-allowance-headers-verbatim.md) for the same distinction
applied to proof).

## Consequences

Being derived is what makes the flow resumable. Nothing has to remember which
Seat was half-done, because the name of a Seat is a fact about the Seat: a run
re-derives every name, looks in the Keychain, and continues.

Four characters of an id is short for reading, not proof, so `buildWorklist`
refuses outright when two Seats would land on one name rather than letting one
overwrite the other's Send token.

**The label is in the name, and a label can change.** This is the cost of the
decision rather than an oversight. Rename an Organization on claude.ai and a
freshly derived name for that Seat differs from the one its Send token is stored
under, which shows up as a Seat that reads missing and a held Seat that belongs
to no entry. Two things make that a nuisance rather than a loss: the Worklist is
saved to a file and a plain run prefers the file, so only `--fresh` re-derives at
all, and the flow settles a held Seat that matches no entry rather than ignoring
it. The alternative, an Organization id and nothing else, was rejected: the
Worklist is a list a person reads down and picks from, and `bo-c3d4e5f6` does
not say which Organization it is.

A Seat added by hand before this existed has a name that is not derived, so the
flow cannot match it to a Worklist entry. Nothing guesses: a Send token proves
which Organization it pays for and can say nothing about which account minted it
([0002](0002-two-credentials-per-seat.md)), and six of this user's Seats sit in
one Organization. The flow probes such a Seat, reports the Organization the
server names, and asks which of the Seats in that Organization it is. Guessing
would name a working token after the wrong Seat, and the Seat it was really for
would then read as filled for as long as the token lasted.
