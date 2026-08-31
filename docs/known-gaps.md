# What this beta does not do, and what an audit found and this release left

Written 2026-08-28, before the first public release. Every item here was found by
reading the code against its own documents, and every one is stated because a gap
somebody has written down is a gap, while a gap nobody has written down is a
surprise.

## The one that makes this a beta

**Adding an account is a sitting, not a screen.** `relay collect-seats` finds every
account you are already signed in to and walks you through them one at a time,
resumably, backing up after each. It works. It is not something to hand to
somebody who has never opened a terminal, and there is no way yet to see what you
have, retire one, or read what each is costing you in one place. Everything under
that screen exists and is tested. The screen does not.

## The suite is honest about two machines and quiet about the third

Whether the program is running on Windows is read from `process.platform` into a
module constant, and nothing in `test/` replaces it. So on a Mac the Windows half
of every branch that dispatches on the machine is not executed by the suite, and
the Windows-only tests are skipped rather than run. `test/profiles.test.ts` shows
the shape of the fix: `asFromTheDock` takes the machine as an argument and is
driven with both answers.

The branches this leaves unexercised on whichever machine you are not sitting at:
the Windows secret store (`src/dpapi`, `src/seats/internal/windows-vault.ts`), the
Windows read of the app's own key (`src/app-store/internal/safe-storage.ts`),
finding the executable (`src/window/internal/launch.ts`), the quoted-executable
parse in `src/window/internal/running.ts`, and the screen-buffer diff that reads
back the authorization link (`src/minting/internal/windows-terminal.ts`).

That last one is not hypothetical. The process list reader was broken on macOS for
weeks, in the half that macOS itself runs, and no test saw it because the fixtures
were built in whichever spelling the host happened to use. A rule that holds on
one of two machines is worse than no rule, because nobody is watching the one it
does not hold on.

## A Windows machine behind a SOCKS-only proxy is refused

macOS carries it: `src/socks` speaks SOCKS5 and the relay dials through it, which
is what [ADR 0011](adr/0011-never-leave-except-the-way-the-machine-would.md) asked
for once bypassing was ruled out. The Windows reader returns a refusal instead.
Refusing is the safe answer and never the wrong one, since the alternative would
be going round the proxy, but it is a smaller product on that machine and the code
that would carry it is already there.

## Three more credentials still leave without asking the machine

Found 2026-08-30, while chasing something else. The background usage refresher
sent a Seat's Send token straight out of the machine: `node:https`, no agent, no
proxy, four at a time, never once asking how traffic leaves. That one is fixed and
[has a test](../test/refresh-through-the-machines-route.test.ts). Three callers in
the same shape are not, and they are listed here rather than quietly left:

- ~~`src/send-token/internal/probe.ts`~~ **fixed 2026-08-30**, and it was not only
  a leak. On a machine whose way out is a proxy, every probe failed, and a probe
  that fails makes the sitting throw away the token it has just minted, because a
  token it could not prove is a token it will not keep. Somebody authorized a
  mint, watched it succeed and ended up with nothing, once per Seat, with no
  message naming the cause. It dials through `dialUpstream` now and has a ceiling
  of its own.
- `src/profiles/internal/identity.ts` sends a Window account's own bearer token to
  the profile endpoint with `fetch`.
- `src/stats-login/internal/bootstrap.ts` and `usage.ts` send a Stats login cookie
  to claude.ai with `fetch`.

All three run in a sitting or a command somebody typed, never in the service, so
none of them is the unattended background traffic the refresher was. That is why
they are a gap and not the same emergency, and it is not a defence: on a machine
whose only route out is the configured proxy, each is a credential going round it.
`dialUpstream` is exported from `src/relay` now and takes a `Route`, so the fix is
the same three-line one in each place. `fetch` is the awkward half: it has no seam
for a socket, so those two want an `undici` dispatcher or a rewrite onto
`node:http`, and neither is a change to make in a release week.

The refresher is also outside the relay's own pool and gate, on purpose. Its
probes each cost a fresh handshake and a round of four sits beside whatever the
relay has in the air rather than inside its bound of twelve. At two requests an
hour per Seat that is not worth a shared pool; at a hundred Seats it would be.

## Three things are implemented twice

None of these is a bug today. All three are the arrangement that produces one,
because two implementations agree until the day one of them is corrected.

- `linux/internal/app-store-linux.ts` is a near copy of
  `src/app-store/internal/environment-store.ts`, including the rule about deleting
  the file only when nothing of the app's is left in it.
  `src/app-store/internal/safe-storage.ts` already defines the `Lock` seam that
  the macOS and Windows halves plug into, and Linux should be a third one.
- `src/stats-login/internal/cookie-store.ts` re-declares the Chromium v10
  constants that `src/app-store/internal/safe-storage.ts` owns, and reaches past
  `decryptFromApp`, which exists so that one place knows how the app locks a file.
- The refresh scheduler is 58 lines repeated between `scripts/serve.ts` and
  `linux/serve.ts`. It belongs in `src/usage`.

## The boundary rule does not watch `linux/`

`src/boundaries` fails the suite when anything reaches past a module's `index.ts`,
and its list of watched folders is `src/`, `test/` and `scripts/`. `linux/` is
typechecked and not watched, and it has three live crossings, each of which has an
`index.ts` export already available to it.

## Two trays say something untrue in one state

With the relay unreachable, the macOS menu still draws `Paying now` and `The
Window account`, which is a positive claim about billing made at the moment the
program cannot know. The Windows tray draws the down state correctly and then
drops `Open Relay…` from that menu, so the page is unreachable exactly when
somebody would want to look at it.
