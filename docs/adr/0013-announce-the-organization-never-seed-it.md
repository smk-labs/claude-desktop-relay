# Announce the Organization, never seed it

A Send token binds to whichever Organization was active in the browser when it was
minted, and a token for the right account and the wrong Organization looks perfect
from here. Ticket 28 asked whether the sitting should make the right Organization
active before minting, rather than catching the mistake afterwards with the Probe.

The answer is no, for one reason that is not about difficulty.

## What seeding would mean

`lastActiveOrg` is a cookie on `.claude.ai`, encrypted with the profile's own
Chromium key, and its plaintext is some leading bytes followed by a 36 byte
Organization UUID. The old claude-deck repo does splice a new UUID into it, in
`dashboard/cookie-crypto.js`, and it works: it decrypts the profile's existing row,
keeps everything before the trailing 36 bytes, and puts the new id in their place.
Nothing about the cryptography is in doubt and none of it would have to be worked
out again.

That file also carries the sentence that settles this:

> Caller MUST guarantee the profile is not currently running. Writing to a live
> Cookies WAL file from outside is externally silent (no crash, no lock error) but
> the running app can later overwrite or ignore it.

## Why that sentence rules it out here

claude-deck seeded profiles it owned. They were Claude Desktop profiles under
`~/Library/Application Support/Claude Profiles/<name>`, it started them itself, and
it could gate the write on the profile being closed through real control flow.

The browser this flow needs is the user's own Chrome, with twenty-eight profiles
and their work in it. Two things follow, and either one is enough:

- **Making the write stick means the browser must not be running.** Nothing here
  may close an application the user is working in. That is the same rule the Window
  has, for the same reason: a Window is never quit, killed or restarted, because the
  person is in it. A browser is not a lesser case of that rule.
- **A write that does not stick fails silently.** The running browser holds the
  cookies in memory and writes them back on its own schedule, so the splice is
  either ignored or overwritten, with no error either way. A guard that quietly does
  nothing is worse than no guard, because it invites the Probe to be trusted less.

So the sitting cannot make the Organization active, and pretending to would replace
one silent mistake with a quieter one.

## The decision

- **Announce it.** Before anything runs, the flow says the account, the Organization
  label, the Organization id and the Chrome profile to have in front, so the person
  can make it active while the previous Seat finishes. `src/sitting`.
- **Prove it.** Every token is Probed against the server before it is kept, and a
  token that pays for a different Organization is refused with the id the server
  actually named, not stored, and left on the list to mint again. That was already
  the rule (ADR 0005 on what a Refusal proves) and it stays the rule.
- **Never write into the user's browser, and never drive it either.** Not the cookie
  store, not which profile a link opens in. `claude` opens the link itself and it
  lands wherever the browser puts it; the flow says which window that should be.
  Reading is the whole of what is done here, as it already was for the Stats logins.

## What would change this

One measurement, and it has not been taken: a claude.ai address that makes an
Organization active by being visited, so the browser sets its own cookie the way it
always does and nothing writes behind its back. If such an address exists, the flow
would open it in the right profile first and the authorize link second, and this ADR
would be replaced rather than amended.

Measure it in the Proving Window, never in the browser the user works in. Guessing
the address instead is the mistake ADR 0010 is about: derived, never invented.

## Consequences

- The likeliest mistake in a sitting stays possible and stays caught. The cost of it
  is one Seat minted again, which is one authorization, and the Probe names the
  Organization the server saw so the reason is never a guess.
- The announcement is doing real work, so it is a value and not four printed lines:
  the terminal and any interface show the same one, from `announcementInWords`.
