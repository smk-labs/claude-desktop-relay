> Primary source. Everything here was measured against one Claude Desktop build,
> on the dates named, and is written down so nobody has to measure it again.

# Swapping the account behind Claude Code Desktop, without touching the app

Plain-language: Claude Desktop runs Claude Code as a separate program on this Mac
and hands it a token saying which account pays. It also, by its own design, sends
that program's traffic through whatever proxy the machine has. So a small local
proxy can replace the token on the way out. The window stays logged into one
account forever; the model spend comes from whichever account you pick.

Proven end to end on 2026-08-21 against Claude Desktop 1.34493.1 / CLI 2.1.237.
Nothing in `/Applications/Claude.app` was modified; its signature stays valid.

## The five facts the whole thing rests on

Each was read out of the app or measured live, not assumed.

- **The child gets its token in the environment.** One function inside the app's
  bundle builds the Code session's environment, and among the objects it merges in
  is a fixed one that sets `CLAUDE_CODE_OAUTH_TOKEN` and
  `ANTHROPIC_BASE_URL: https://api.anthropic.com`.
- **The app routes that child through the machine's proxy on purpose.** It logs
  `[CCD] Resolved system proxy for Code sessions: http://127.0.0.1:2080`, and the
  same step sets `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`.
- **A caller-supplied value wins.** The builder only fills a proxy key when it is
  absent in *both* cases, lowercase and uppercase, and then applies the user
  environment store on top of everything it computed.
- **The env store is writable from outside.** `<userData>/ccd-environment-config.json`,
  key `envVars`, value = base64 of `safeStorage.encryptString(JSON)`. On macOS that
  is Chromium v10 (AES-128-CBC, key from Keychain `Claude Safe Storage`/`Claude Key`),
  exactly what `dashboard/cookie-crypto.js` already implements.
- **The app's blocklist for that store does not cover proxy names.** The list it
  refuses to take from the store is
  `PATH, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN, ANTHROPIC_CUSTOM_HEADERS, ANTHROPIC_BASE_URL,
  DISABLE_AUTOUPDATER, CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES, CLAUDE_CODE_DISABLE_CRON`.
  `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` are absent, so both can be set.

## The trap that cost an hour: case matters

The login shell already exports lowercase `https_proxy`, and the app imports it
(`[CCD] Resolved 32 login-shell env vars`). Setting only `HTTPS_PROXY` looks
correct in `env` output and does nothing, because HTTP clients read the lowercase
name first. **Set every case and every scheme**, or the swap silently never fires:

```
HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy
```

`all_proxy` was `socks5h://…` here; it must be overridden too, to an `http://`
value, because the local proxy speaks HTTP CONNECT.

## Tokens

`claude setup-token` mints a long-lived (`~1 year`) `sk-ant-oat01-…` subscription
token, per **account + org** (it binds to whichever org was active in the browser).
So the unit of switching is an account/org pair, e.g. `ana-acme`, not an
account. Mint each one under an isolated `CLAUDE_CONFIG_DIR` so the real
`~/.claude` login is never touched:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-mint/<name>" claude setup-token
```

The server accepts these on `/v1/messages` with `authorization: Bearer …` plus
`anthropic-beta: oauth-2025-04-20`. Verified: HTTP 200, and
`overage-status: rejected` / `overage-disabled-reason: org_level_disabled`, i.e.
running out of subscription fails the request instead of billing API credit.

## Verification comes free, from the response headers

Every `/v1/messages` reply states who paid. This is the only honest proof and it
also replaces the usage API (which a setup-token cannot reach: it is inference-only,
`/api/oauth/profile` answers 403 `scope requirement any_of(user:profile, user:office)`).

```
anthropic-organization-id: c3d4e5f6-…
anthropic-ratelimit-unified-5h-utilization: 0.39
anthropic-ratelimit-unified-7d-utilization: 0.24
anthropic-ratelimit-unified-overage-status: rejected
```

Measured during the proof: 64 of 64 `/v1/messages` on the swapped org, the
swapped account's 5h window climbing `0.36 → 0.37 → 0.39`, and the window's own
logged-in account still at `5h = 0.0`.

## Setup, in order

1. **CA + leaf** (once). `NODE_EXTRA_CA_CERTS` is additive, so only our CA is needed.

```bash
mkdir -p ~/.claude-3p/ca && cd ~/.claude-3p/ca
openssl req -x509 -newkey rsa:2048 -sha256 -days 730 -nodes \
  -keyout ca.key -out ca.crt -subj "/CN=claude-deck local proxy CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr \
  -subj "/CN=api.anthropic.com"
printf 'subjectAltName=DNS:api.anthropic.com\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > leaf.ext
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out leaf.crt -days 730 -sha256 -extfile leaf.ext
chmod 600 *.key
```

2. **Write the env store** into the profile that should be re-routed. Only that
   profile is affected; every other window is untouched.

```js
// node, run from the claude-deck repo
const fs = require('fs'), path = require('path');
const c = require('./dashboard/cookie-crypto.js');
const dir = process.env.HOME + '/Library/Application Support/Claude Profiles/<name>';
const P = 'http://127.0.0.1:8977';
const vars = {
  HTTPS_PROXY: P, https_proxy: P, HTTP_PROXY: P, http_proxy: P,
  ALL_PROXY: P,   all_proxy: P,
  NO_PROXY: 'localhost,127.0.0.1,::1,.local',
  no_proxy: 'localhost,127.0.0.1,::1,.local',
  NODE_EXTRA_CA_CERTS: process.env.HOME + '/.claude-3p/ca/ca.crt',
  NODE_USE_SYSTEM_CA: '1',
};
const enc = c.encryptV10(c.deriveKey('mac'), Buffer.from(JSON.stringify(vars), 'utf8'));
fs.writeFileSync(path.join(dir, 'ccd-environment-config.json'),
  JSON.stringify({ envVars: enc.toString('base64') }, null, 2), { mode: 0o600 });
```

3. **Start the proxy, then restart that profile's window.** The store is read at
   app start. Removing the JSON file is the complete undo.

## A simpler delivery than the encrypted store: half of it works (measured)

The builder starts from the app's own environment and the computed system proxy
only fills a key that is absent. So the proxy variables can also be handed to the
**app process itself at launch**, and the Code child inherits them. That needs no
`safeStorage` crypto at all and is identical on both platforms:

```bash
HTTPS_PROXY=http://127.0.0.1:8977 https_proxy=… ALL_PROXY=… all_proxy=… \
NODE_EXTRA_CA_CERTS=~/.claude-3p/ca/ca.crt \
/Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=<profile>
```

Tested 2026-08-21 on a clean profile with no env store at all:

- **The proxy variables do survive.** The child connected straight to the local
  proxy (`OPEN api.anthropic.com:443` logged), so for those names the launch
  environment is enough and the encrypted store is not needed.
- **`NODE_EXTRA_CA_CERTS` does not.** The handshake failed
  (`ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC` on our side, `SSL certificate
  verification failed` in the app), because the app computes its own CA bundle for
  Code sessions and that lands after the app's own environment. Only the env
  store, which the builder applies last of all, survives it.

So the split for a rewrite: proxy names at launch, and the CA through the env
store. The store is needed for exactly one variable, not for the whole set.

## Windows

The mechanism is platform-independent, with three differences.

- **No case trap.** Windows environment variables are case-insensitive, so there
  is only one `HTTPS_PROXY` and the whole lowercase/uppercase problem disappears.
  The app's own merge step even has a win32 branch that collapses case collisions.
- **The env store is encrypted differently.** `safeStorage` on Windows is DPAPI
  (CurrentUser), not the Chromium `os_crypt` key that `cookie-crypto.js` reads for
  cookies. Writing that file from outside is unverified. The launch-environment
  route above sidesteps it entirely, and `Start-ClaudeInstance` already sets env
  vars per launch.
- **Paths and CA tooling.** Data dirs are `~\ClaudeProfiles\<name>`; the app's proxy
  resolution reads the WinINET registry values instead of `scutil`. `openssl` is not
  present by default, so generate the CA once (Git for Windows ships it, or copy the
  pair from the Mac).

Everything else is the same: the CLI honours the same variables, `NODE_EXTRA_CA_CERTS`
works, and the proxy is plain Node.

## The proxy

Working code, as proven. Only `api.anthropic.com` is opened; every other host is
blind-tunnelled, so nothing else in the session changes. It chains to the
machine's existing proxy, so egress is unchanged. `CD_SWAP=1` turns the rewrite
on; without it the same process is an observer, which is how you should always
start.

Two details that are not optional:

- **`client.pause()` until the upstream pipe is wired**, then `resume()`. Without
  it the bytes right after the first chunk are dropped, TLS dies and the window
  renders black. That cost a full debug cycle.
- **ALPN pinned to `http/1.1`** on both sides, so there is no HTTP/2 framing to
  reimplement. Response bodies are piped, never buffered, so streaming is intact.

Source: `~/.claude-3p/proxy.js` in this experiment; copy it into the repo when
this becomes a product. Shape:

```
http.createServer(...).on('connect', (req, client) => {
  const [host, p] = req.url.split(':');
  if (host === 'api.anthropic.com') inspect(client);   // terminate TLS, rewrite
  else blindTunnel(client, host, Number(p || 443));    // everything else
})

// inspect(): TLSSocket({isServer, key: leaf.key, cert: leaf.crt, ALPNProtocols:['http/1.1']})
//   -> http.createServer handler
//   -> if (/^\/v1\//.test(req.url)) headers.authorization = 'Bearer ' + activeToken()
//   -> CONNECT upstream (127.0.0.1:2080), tls.connect({socket, servername}), forward
//   -> log statusCode + anthropic-organization-id + the two utilization headers
//   -> up_res.pipe(res)
```

`activeToken()` re-reads a file on every request, so switching accounts needs no
restart of the app or the proxy.

## Scope: what this can and cannot move

The rule is where the result lands, not where the request starts.

- **Local Code sessions**: fully switchable. Proven.
- **MCP servers, local or remote**: irrelevant to billing. Their own traffic goes
  to their own hosts with their own credentials and costs no Anthropic quota. But
  what a tool returns enters the conversation, so those input tokens are billed to
  the swapped account.
- **Cloud sessions**: the token can be swapped, but the session is then created in
  the other account's namespace and the window (logged in as the front account)
  cannot see it. Billable, not usable.
- **Remote Control**: refused by the CLI before any network call, because
  long-lived tokens are inference-only. The proxy never gets a turn.
- **Entitlements, Customize, account settings**: bound to the front account. So the
  front account must be a paid one; a free account cannot even start a Code session,
  which means no request would ever reach the proxy.
- **SSH / Docker / WSL sessions**: unresolved. A dedicated `ssh-remote` entrypoint
  and remote transcripts suggest the agent runs on the far machine, in which case
  the request leaves from there and a local proxy never sees it. A reverse SSH
  tunnel would cover it. One session settles this; not tested yet.

## The upstream must be adaptive, or TUN mode kills it

Plain-language: when the VPN switches to TUN mode it carries traffic at the
network layer and stops listening on its local port, while leaving the system
proxy settings pointing at that now-dead port.

The prototype chains unconditionally to `127.0.0.1:2080`, so in TUN mode every
Code request fails on `connect ECONNREFUSED`. The fix is the rule this repo
already proved once in `dashboard/proxy.js`: **treat a refused proxy as absent,
not as a failure.**

- try the upstream; on `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` /
  `EADDRNOTAVAIL` (all of which prove the TCP connect never completed) open a
  direct socket to the target instead
- latch that verdict for ~60s so a dead port is dialled once a minute, not once
  per request
- never fall back on a timeout or on a proxy that answered: those mean the route
  exists and is unhappy, and going around them would silently unproxy traffic

Direct works in TUN mode precisely because the VPN is intercepting at the network
layer, so nothing else has to change.

## Failure modes, and they all fail closed

- Certificate pinning on `api.anthropic.com` would end it immediately. None today:
  the CLI pins only the enterprise cloud gateway.
- Device or per-message attestation would reject a swapped token. The app already
  carries gates for a device attesting to itself and for a device it does not trust.
- Adding the proxy names to the store's blocklist would close the entry point.
- A setup-token expiring or being revoked is routine re-minting.
- If the proxy process dies, sessions error. They do not silently bill the wrong
  account, which is the property worth keeping in any rewrite.

## Costs to state plainly

- The app's own UI shows the **logged-in** account's usage, not the paying one. A
  dashboard must cover this or it is confusing.
- All Code traffic passes through local code, which sees every request and response
  in the clear. Own machine, but real.
- One more homegrown component on the critical path.

## What is left to build

- Turn the prototype into a supervised service (launchd user agent, no sudo).
- A token store per account/org pair, and a one-file active selection.
- Automatic selection from the utilization headers: pick the pair with the most
  headroom, rotate on `429` or when a window is spent.
- A minimal dashboard: active pair, live utilization per pair, one button to switch.
  Model choice stays in the app's own picker, which already lists 10 models via
  `api.anthropic.com/v1/models`.

## Dead ends, so nobody repeats them

- **The app's 3P ("custom-3p") mode** delivers a switchable backend via
  `inferenceProvider=anthropic` + `inferenceCredentialKind=helper-script`, and the
  inference half genuinely works: an `sk-ant-oat` token is detected and sent as a
  Bearer credential. What does not work is the web surface. The UI is a bundled
  offline snapshot served from `Resources/ion-dist` over `app://localhost`, handed
  a flag payload whose every map is empty, so MCP App widgets from Code tool
  results and thinking blocks never render. Turning on the one flag that gates
  those widgets does not fix it; 19 more features read the same empty document.
  Read the correction dated 2026-08-24 below before calling this a dead end: it is
  a dead end for the claude.ai chat surface, not for Code.
- **Patching `app.asar`** is unnecessary for anything here and reintroduces
  codesign, entitlements and AMFI. The renderer files under `Resources/ion-dist`
  are outside the asar and outside `ElectronAsarIntegrity`, but "outside the asar"
  is not "outside the signature": `ion-dist` sits in `Contents/Resources`, which the
  resource seal covers, so editing one file there makes
  `codesign --verify /Applications/Claude.app` fail. Measured 2026-08-24, both
  directions. Cheap to edit is not the same as free.
- **`claude-swap`** and similar swap the CLI's own stored credential. Desktop passes
  `CLAUDE_CODE_OAUTH_TOKEN` in the environment, which outranks the stored login, so
  that approach has no effect on Desktop sessions.

## The allowance headers, measured in full (2026-08-21)

One real reply to `POST /v1/messages`, with a one-year Send token and
`anthropic-beta: oauth-2025-04-20`, on `claude-haiku-4-5-20251001`. Every header
below arrived; the names are verbatim.

```
anthropic-organization-id: c3d4e5f6-0000-4000-8000-000000000003
anthropic-ratelimit-unified-status: allowed
anthropic-ratelimit-unified-5h-status: allowed
anthropic-ratelimit-unified-5h-reset: 1787357400
anthropic-ratelimit-unified-5h-utilization: 0.02
anthropic-ratelimit-unified-7d-status: allowed
anthropic-ratelimit-unified-7d-reset: 1787677200
anthropic-ratelimit-unified-7d-utilization: 0.25
anthropic-ratelimit-unified-representative-claim: five_hour
anthropic-ratelimit-unified-fallback-percentage: 0.5
anthropic-ratelimit-unified-reset: 1787357400
anthropic-ratelimit-unified-overage-status: rejected
anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled
```

Three things this settled, each of which had been guessed before:

- **The reset times exist**, under `anthropic-ratelimit-unified-5h-reset` and
  `-7d-reset`, as seconds since 1970. ADR 0008 was written because these names
  were unknown; they are known now and are typed fields.
- **The overage reason header is `anthropic-ratelimit-unified-overage-disabled-reason`**,
  not the shorter `overage-disabled-reason` recorded earlier. Code written to the
  shorter name would have read null forever and said nothing about it.
- **An Organization id is a bare UUID**, not prefixed with `org-`. Anything that
  validates the shape of an Organization id has to accept a UUID.

There is also more here than the spec asked for: a per-window `status`, a
`representative-claim` naming which window is the binding one, a
`fallback-percentage`, and an overall `unified-reset`. Phase two should read them
rather than compute its own version of the same thing.

## A running Window cannot be brought into the relay from outside (2026-08-21)

Read from the app's own bundle, then measured.

**What the code says.** Inside the app's bundle, the reader for
`ccd-environment-config.json` opens the file with mode `0600`, reads the `envVars`
key once, and keeps the answer in a module-level variable for the life of the
process. That variable is only ever cleared by the app's own writer, in the same
process. Nothing watches the file: no `fs.watch`, no `watchFile`, no chokidar. So
a store written by another process is never noticed.

The proxy is the same story. The resolver memoises, and the real work happens once
through Electron's own `resolveProxy` with a two second timeout, whose answer
becomes `HTTPS_PROXY`, `HTTP_PROXY` and a fixed `NO_PROXY`. A success is kept for
the life of the process. Only a failure is retried. So changing the machine's proxy
settings does not reach a running app either.

**The measurement.** With the relay listening on 127.0.0.1:8978 and all ten
variables written into the store, a new Code session was started inside a Window
that had been running since before the store existed. The session worked and
answered normally, so it certainly reached the API. The relay logged nothing at
all: no new line after the two exchanges the check had driven through it minutes
earlier. Its traffic went straight to the machine's proxy on 2080, the value the
app had resolved and cached at startup.

**Consequences.** There is no way to attach or detach the relay on a Window that
is already open. Both doors, the store and the proxy, are read once. So the design
is: write the store once, and one restart of the app puts it in force for every
Window opened from then on, however the user opens it. After that, turning the
relay on and off is not a plumbing change at all, it happens inside the relay,
live, by choosing a Seat or choosing Off.

This also means the relay has to outlive any one session, because the store points
Code sessions at it. That makes ticket 17 a prerequisite for the seamless
behaviour rather than a later nicety.

**One reassurance, measured at the same time.** The app itself does not use these
variables; it reaches the network through the system proxy. They are handed only to
the Code sessions it spawns. So a relay that is down breaks Code sessions and
leaves the app itself working.

**The store's other keys are safe.** The app writes through `electron-store`,
setting one top-level key at a time, which replaces that key and preserves the
rest, so our writer preserving them matches the app's own behaviour.

## What actually fails, and what never has (2026-08-21)

A relay in front of a real Window, watched across 846 successful message
exchanges. Two theories about the failures were wrong before the instrumentation
settled it, so the numbers are here rather than the reasoning.

**No message request has ever failed.** Not one, across 846. Every single failure
was `POST /api/event_logging/v2/batch`, the app's own telemetry upload.

**The correlate is duration, not concurrency.** Every failure lived between 15.6
and 26.2 seconds and then had its connection dropped by the other end. At the
moment each one died there were only one to four other exchanges in the air, while
the relay had handled 47 at once without trouble and 115 requests in a minute.

```
open-failed: POST /api/event_logging/v2/batch: answered nothing: socket hang up.
Lived 16829ms, closed by us: false, 3 other exchanges in the air, most so far 24.
```

`closed by us: false` is the field that made this readable. Without it a socket the
relay destroyed and a socket the other end dropped look the same, and every
explanation stays a guess.

**Consequences.** Pooling connections would have fixed none of this, and it was
twice about to be built. A long-running telemetry post being dropped after fifteen
seconds looks like an idle timeout somewhere between here and the server, most
likely the machine's own proxy; the app batches and retries that traffic itself, so
nothing is lost. What matters is that the path the user's work travels on has a
clean record.

**Also measured: a caller that changes its mind is not a failure.** Twenty three of
those in the same window, some after 150 seconds of streaming, which is a Code
session abandoning work it no longer needs. Counting them as failures is what made
an early reading say four percent of requests were breaking when none of the user's
were.

## Reading the Seats an account owns, without a Send token (2026-08-22)

A Send token is inference-only and cannot read a profile (ADR 0002), so the
Seats a user owns have to come from somewhere else. They come from the account's
own claude.ai login, and everything below was measured rather than assumed.

**Where the logins are.** `~/.claude-legacy-backup/2026-08-21/profiles/<name>/`,
one folder per old Claude Desktop profile, each with a `Cookies` store. Eight of
the nine still held a live session on 2026-08-22; the ninth, `claude`, is signed
out. Any folder of Claude Desktop profiles reads the same way, including the
live one.

**How the login is locked.** Chromium `v10` on macOS: the Keychain entry
`Claude Safe Storage`, through PBKDF2-SHA1 with the literal salt `saltysalt`,
1003 rounds, 16 bytes, then AES-128-CBC under an IV of sixteen spaces. The
plaintext carries a 32-byte hash of the host before the value, so the value is
found by looking for the `sk-ant-` marker rather than by cutting a fixed length:
a change to that prefix then fails to find a login instead of quietly returning a
corrupted one.

**The store is read with `node:sqlite`, read-only, with parameters.** The old
reader in claude-deck shells out to the `sqlite3` CLI and builds SQL text,
because that CLI takes no parameters. Node has had a built-in since 22.5, so
there is no CLI to find on a PATH and no value that ever becomes part of a query.
Only three columns are named, which is also why a fixture store with three
columns is a fair test of it.

**One endpoint answers everything.** `GET https://claude.ai/api/bootstrap` with
`cookie: sessionKey=…`. It must carry a browser's own `user-agent`, `accept` and
`referer` or Cloudflare answers with a page instead of an answer. The fields
that matter:

```
account.email_address                              the account
account.memberships[].organization.uuid            the Organization id, a bare UUID
account.memberships[].organization.name            the Organization label
account.memberships[].organization.rate_limit_tier
account.memberships[].organization.raven_type
account.memberships[].organization.capabilities
account.memberships[].seat_tier
```

`/api/organizations` returns the same Organizations with more detail and is not
needed: bootstrap alone carries the seat tier, which is the only place a Team
Seat's premium or standard grade appears at all. Every Organization in a Team
reports the same `rate_limit_tier`, so the tier on its own cannot tell them
apart.

**The Multiplier, from the tier and the seat tier together.** Measured across
every account in the set:

```
default_claude_max_20x                    20
default_claude_max_5x                      5
default_raven + seat_tier team_tier_1      6.25
default_raven + seat_tier team_standard    1.25
…pro…                                      1
default_claude_ai                          0
```

**Which Organizations are not Seats.** Two kinds, and both are read off the
server's own words rather than decided here. An Organization whose
`capabilities` does not include `chat` exists to evaluate the API and can never
pay for a Code session: those are the `auto_trust_tier_*` and
`auto_api_evaluation` ones. An Organization on `default_claude_ai` is free and
has nothing to spend. Of this user's 25 Organizations, 9 are dropped for those
two reasons and 16 are Seats.

**Cross-checked against the snapshot, 2026-08-22.**
`~/.claude-legacy-backup/2026-08-21/seat-inventory.json` was written the day
before by different code reading the same accounts, so it is an independent
second opinion and is used as one, never as the source. Comparing it against
what discovery found: 16 paying Seats on each side, and every account,
Organization id and Multiplier identical, including the two that are easy to get
wrong. `ana@example.com` holds a premium grade in Acme-2 where three other
accounts hold standard, and both sides say so. Nothing in either list is absent
from the other. The comparison is not a test in the suite, because the snapshot
carries real email addresses and Organization ids and this repo is meant to go
public.

## Proving which Seat a Send token belongs to (2026-08-22)

One real `POST /v1/messages`, on the cheapest model, with `max_tokens: 1`. It
costs 22 input tokens and 1 output token, and the reply names the Organization
that paid. This is the only way to check a freshly minted token, because
`claude setup-token` binds to whichever Organization was active in the browser
and a token for the right account and the wrong Organization is indistinguishable
from a correct one until the server answers.

```
authorization: Bearer sk-ant-oat01-…
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01

{"model":"claude-haiku-4-5-20251001","max_tokens":1,
 "system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],
 "messages":[{"role":"user","content":"hi"}]}
```

The system prompt is load-bearing, not decoration: ADR 0005. Removing it from
the probe is mutation-tested, and the test that guards it fails when it goes.

**What a Probe cannot say: which account.** The reply names an Organization and
nothing else, and six of this user's Seats sit in `c3d4e5f6`. The Seat `parked`,
carried over from the phase-one experiment with "unknown" for its account, was
identified another way and the method is worth writing down: its reply reported
`5h=0.33, 7d=0.29`, and reading each account's own usage in Acme through its
Stats login at the same moment gave `bo@example.com` at `session=33,
weekly_all=29` with every other account at or near zero. That is a measurement,
not an inference, and it is why `parked` is now `bo-acme-c3d4`. The flow itself
does not do this: it asks.

## What a Seat has spent, from the account's own login (2026-08-22)

The percentages only ever arrive attached to a real reply, so a Seat nobody has
used today is a blank in every comparison. The account's own login answers for
it. Measured against `cy@example.com` on 2026-08-22:

```
GET https://claude.ai/api/organizations/<organization-id>/usage
cookie: sessionKey=…            and the same browser headers as bootstrap

{"five_hour":{"utilization":14,"resets_at":"2026-08-22T08:09:59.525042+00:00", …},
 "seven_day":{"utilization":15,"resets_at":"2026-08-28T12:59:59.525060+00:00", …},
 "limits":[…], "spend":…, "member_dashboard_available":…}
```

Four things worth writing down, because each of them is a bug if forgotten.

- **It is per Seat, not per Organization.** The answer is what the *calling
  account* has spent in that Organization, which is exactly a Seat. Six accounts
  in `c3d4e5f6` give six different answers.
- **`utilization` is a percentage here and a share on a reply header.** 14
  against `0.14`. The reader divides by a hundred at the edge, so one quantity
  has one scale everywhere inside.
- **An Organization the account cannot pay in answers 403, or answers with both
  windows null.** Neither is "nothing spent"; both read as unknown.
- **`/api/organizations/<id>/usage_limits` does not exist** (404), and
  `/rate_limits` answers about API rate limiters, not about allowance. `usage` is
  the one to ask.

Two endpoints were probed and rejected for this job: `/api/oauth/usage` answers
401 to a Stats login, and there is no Claude Code specific usage path.

## The collapse of 2026-08-22, and the four theories that were wrong

A live window lost its Code sessions. 190 of about 1,760 exchanges failed in one
sitting, roughly one in ten. Written up in full because the shape of the failure
is the shape of the design.

**What the log actually said.** Two different failures, not one:

```
 47  the dial itself failed        "Could not reach api.anthropic.com:443: read ECONNRESET"
143  dial and TLS fine, then died  "answered nothing: socket hang up ... closed by us: false"
```

Mode B is the dominant one, so the tunnel to Anthropic was established and then
went quiet. `closed by us: false` says the relay was not the one who hung up.

**The lifetimes are a timeout, not randomness.** Of 143 answerless requests, 72
died at 15 seconds and 15 more at 16, with a second cluster at 21 and 22:

```
15s  ████████████████████████████████████████████████████████████████████████ 72
16s  ███████████████ 15
21s  ████████████████ 16
22s  ████████████████ 16
```

Something was killing tunnels at a fixed age. The machine's proxy on
`127.0.0.1:2080` was up throughout: not one `machine-proxy-unreachable` notice in
the whole log, so every one of those requests went through it.

**The concurrency, and where the failures sat.** The relay's own high-water mark
climbed 61, 63, 76, 84, 86. The worst minute was `00:32`, with 82 failures in 128
exchanges, and `00:32:36` is when the relay had just started: every Code session
retried at once and 86 requests arrived together. The same pattern sits after the
other start at `23:16`.

**The mechanism.** One exchange is one connection to the upstream, so 86
concurrent requests meant 86 simultaneous TLS connections through one local
proxy. The far end cannot work on 86 things at once, so most of them sat in
silence waiting their turn. A proxy cannot tell a queued tunnel from a dead one;
it saw tunnels with no bytes in them and closed them. Every one of those requests
would have succeeded had it been asked a moment later. This is congestion
collapse, and the cure for congestion collapse is never a longer timeout. It is
asking for less at once.

**The fix.** A gate in front of the relay's exchange path: twelve in the air at
most, and the rest queue. The turn is taken *before* anything is dialled, which
is the whole point, because a tunnel that is not open yet cannot be hung up on
for being quiet. `src/relay/internal/gate.ts`.

Reproduced and proved in `test/relay-under-load.test.ts`: the same burst against
the same impatient proxy and the same slow upstream fails without the gate and
loses nothing with it. Remove the bound and the test fails.

### Four theories that were wrong, in the order they were tried

Kept because each one was plausible, each one cost time, and each was killed by a
measurement rather than by argument.

1. **"Destroying the TLS socket leaves the raw socket open."** Tested in
   isolation: it closes it. Wrong.
2. **"Node's global agent is holding the sockets."** Six concurrent requests,
   six sockets apparently leaked. Wrong, and the experiment was invalid: it
   counted sockets the probe itself had opened, while the HTTP request was going
   somewhere else entirely.
3. **"So pass `agent: false`."** This one is worth remembering because it is
   actively dangerous. Node only honours `options.createConnection` when there is
   *no* agent; `agent: false` builds one, ignores `createConnection`, and dials
   the host itself. The relay went straight out to the real Cloudflare and round
   the machine's proxy. A test caught it. Never set it.
4. **"The relay leaks a connection per request."** Ground truth from libuv inside
   the running process: 90 requests, TCP handles flat at the baseline of two,
   nothing left open. No leak. What looked like one was a stand-in proxy in the
   test helpers that piped without propagating a half-close, so a tunnel the
   relay had finished with stayed open in the fake and nowhere else.

The lesson is the one already in the handoff, and it held again: instrument
before fixing. Four theories, four measurements, and only the fifth reading of
the evidence was the right one.

### What is still on the table

One exchange is still one connection. The gate means at most twelve of them are
being set up at any moment, which is far from the point where the route gives
out, but a burst of forty requests is still forty handshakes through the proxy.
Reuse would cut that to a handful. It is not done here, deliberately: a pooled
connection can be killed by that same fifteen-second patience while it sits idle
between requests, and handing a dead socket to the next request trades a
measured problem for an unmeasured one. `test/relay-under-load.test.ts` pins the
current number so the improvement is visible when it lands.

## 2026-08-22, later: connection reuse landed, and a Proving Window on the real machine

### Reuse, and the idle bound that makes it safe

The section above ends with "one exchange is still one connection" and the reason
not to fix it yet: a pooled connection can be killed by the proxy's own fifteen
second patience while it sits idle, and handing a dead socket to the next request
trades a measured problem for an unmeasured one.

That is now done, and the answer to the unmeasured half is a bound rather than a
retry. Idle connections are dropped after **five seconds**, a third of the fifteen
that was measured, because fifteen is one measurement of one proxy and the next one
may be less patient. A connection is never retried when it dies mid-request either:
telling "the server never read it" from "the server read it and then the connection
died" means guessing, and guessing wrong charges a Seat twice for one request.

Measured through the fake upstream: twenty requests arriving together are served
over **twelve** connections rather than twenty, and three requests one after another
open **one**. `test/relay-under-load.test.ts` pinned the old number and now pins the
new one.

### The chain, on the real machine, through a second Claude Desktop

A Proving Window was set up and driven with real network traffic. What was proved,
and what was not, kept apart on purpose.

Proved, measured:

- Its relay is a launchd job of its own, `com.claude-desktop-relay.agent.8979`,
  running from its own clone of this repository at HEAD, listening on 8979.
- A second Claude Desktop runs on its own Desktop folder,
  `~/.claude-desktop-relay-proving/desktop`, alongside the live one. Two processes, two
  folders, and `ps` tells them apart by `--user-data-dir`.
- Its store holds our ten variables, and `relay doctor` against it reports all five
  parts ok: the store where it has always been, our variables in it as written, the
  certificate good for another 729 days, the relay listening, the service running.
- **The whole request path works with real traffic.** One Code-shaped request through
  it: the relay answered `HTTP/1.1 200 Connection Established`, TLS terminated
  against our own authority with `authorized = true`, the request was re-originated
  to `api.anthropic.com` through the machine's own proxy at 127.0.0.1:2080, a real
  answer came back from the internet, and the relay judged it and wrote the verdict
  into its own bounded log:
  `unverified: POST /v1/messages: unproved, because no Seat was chosen for it`.
- **The live Window was untouched throughout.** No plist under the plain label, no
  store file in `~/Library/Application Support/Claude`, nothing listening on 8978.

Not proved, and neither can be until the Send tokens are minted again:

- **The swap.** There is no Send token on this machine to swap in, so every exchange
  above is honestly recorded as "no Seat was chosen for it". That is the verdict
  working, not the swap working.
- **The negative control's 401.** The far end answered **520** to every attempt, which
  is Cloudflare's own "the web server returned an unknown error" and not something a
  request's shape controls. So the credential was never actually rejected by
  Anthropic in this run. The relay chained correctly and reported faithfully; the
  answer simply was not the one that would have proved the control.

### Two failures found by running it rather than by testing it

Both were in code that a green suite had already passed, and both were found within
minutes of pointing the thing at a real machine.

1. **The service's own log was never empty, so it could not be a diagnosis.** Both of
   the relay's streams went to `service.log`, so it held the two ordinary startup
   lines, and the `relay doctor` finding added with ticket 24 reads any bytes there
   as "the relay could not start at all". A healthy service was reported as broken.
   Standard output now goes to `/dev/null`, only standard error reaches the file, and
   the file is emptied before the job is installed rather than after.

2. **Reinstalling over a running job left the machine with no relay at all.**
   `launchctl bootout` returns before launchd has finished unloading, so
   bootstrapping straight afterwards fails with `Bootstrap failed: 5: Input/output
   error`. `relay prove --set-up` run twice threw, and left the job booted out and
   nothing listening: the worst of the three possible outcomes. The unload is now
   waited for, with a ceiling, and the job is proved running afterwards rather than
   assumed, because a zero from `bootstrap` says launchd accepted the job
   description and not that anything is up.

Neither could have been caught by the suite as it stood, and the second could not
even have been written as a test: the fake launchctl answered zero to every question
including `print`, so it could not model a job that is still loaded. It has that one
piece of state now.

## 2026-08-24: what 3P actually needs, and what I got wrong finding it

Someone asked for a window in 3P mode carrying settings they had set up once
before. It took far longer than it should have, and every wrong turn was a wrong
belief rather than a missing capability. Both halves are written down here: the
mechanism first, then the errors, because the errors are the reusable part.

### The mechanism, in the order it has to be true

1. **The data directory name decides which config the app reads.** The app derives
   two bases from its own user-data directory: the 3P base is that path with `-3p`
   appended unless it already ends in `-3p`, and the 1P base is the same path with
   `-3p` stripped. So `--user-data-dir=<X>` makes the app read its 3P config from
   `<X>-3p`, never from `<X>`. Launch with a directory that already ends in `-3p`
   and the pairing is right: the 3P base is that directory and the 1P base is its
   sibling, instead of the real `~/Library/Application Support/Claude`.
2. **`deploymentMode` alone never resolves to 3P.** The app answers "3P" only when
   it has resolved an `inference` config, and falls back to "1P" otherwise. Without
   that config the app reports 1P no matter what `deploymentMode` says, in any
   file.
3. **`inference` arrives through two tiers, and only one needs no password.** The
   `managed` tier reads `/Library/Managed Preferences/com.anthropic.claudefordesktop.plist`,
   which needs sudo and is machine-wide. The `local` tier reads
   `<3P base>/configLibrary/_meta.json` for `{"appliedId": "<uuid>"}` and then
   `<uuid>.json` for flat keys. That is the one to use.
4. **A working `_meta.json` carries `entries`, not just `appliedId`.** The shape that
   was already working on this machine is
   `{"appliedId": "<uuid>", "entries": [{"id": "<uuid>", "name": "<label>"}]}`.
   Hand-write only `appliedId` and the app reads the config but its own settings
   screen refuses to save, with "Couldn't update saved configurations".
5. **Proof it is up, from the app's own log:** `[custom-3p] 3P mode active`,
   `helper ok (elapsed=…ms stdoutBytes=…)`, `inference apiHost=https://api.anthropic.com`,
   and `Model discovery: 10 found`. Model discovery is the useful one: it is a real
   call to `api.anthropic.com` with the helper's token, so it proves credential,
   egress and provider in one line.
6. **What 3P stubs is the web surface, not inference.** The protocol handler installs
   an explicit allow-list of what may leave, on which `api.anthropic.com` appears
   only for `/api/desktop/` update checks, and answers any un-stubbed API path with
   `503` (`[custom-3p] 503 for un-stubbed API path`). So Code sessions work while the
   claude.ai chat surface does not, and opening that "entirely" means rewriting the
   stub table inside `app.asar`, which ADR 0001 already refused for good reasons.
7. **MCP servers do not come from `claude_desktop_config.json` in 3P.** The log says
   `Credentials loaded from managed config { provider: 'anthropic', mcpServerCount: 0 }`
   while that file listed ten. The managed-config key is `managedMcpServers`.

### The errors, so nobody spends the same hour

1. **I said 3P needed a root CA installed in the Keychain. It does not.** The CA is
   delivered per-process through `NODE_EXTRA_CA_CERTS` in the profile's env store.
   Refusing the task on a security ground that was not real cost the first exchange.
2. **I wrote `deploymentMode` into four wrong places before checking where the app
   reads it from.** `config.json`, then `managedConfig` inside it, then a
   `configLibrary` under the un-suffixed directory, then a nested `inference` block
   in `claude_desktop_config.json`. All four were guesses. The `-3p` rule was sitting
   in the app's own base-directory function the whole time, and reading that one
   function first would have replaced all four.
3. **I declared the machine-wide plist the only route.** The `local` tier was right
   there in the same function I had already read, and it needs no password.
4. **I trusted `atime` as evidence that a file had not been read.** On APFS atime
   updates are commonly suppressed, so that proved nothing. Corrupting the file on
   purpose and watching for the parse error is the honest version of that test.
5. **I reported a window as running when it was not.** Five processes at launch, zero
   by the time I wrote the sentence, and I did not re-check before claiming it.
6. **I printed "signature OK" from a shell line that could not fail.** `codesign`
   piped into `head` meant `&& echo` ran regardless of the verdict. The real verdict
   was the opposite: the `ion-dist` edit breaks the resource seal. A check whose
   success path is unreachable is worse than no check.
7. **I concluded the API was misconfigured because the user could not send a
   message.** The app's own log already held `helper ok` and
   `Model discovery: 10 found`. I should have read the log before theorising.
8. **I overwrote `ccd-environment-config.json` without looking at it first.** It
   already existed in that profile. The content was equivalent, so nothing broke,
   but the original is gone and that was luck rather than care.
9. **I believed the earlier setup would be in my memory, and looked for it in the
   repository.** It was on disk the whole time, and the app's own log named it:
   `helperPath: '/Users/me/claude-3p-test-3p/token.sh'`. Grepping the logs for
   `custom-3p` finds a previous working profile in one command, including its token
   switcher (`active-name` plus `tokens/<name>`).
10. **When the SSL error finally appeared I assumed the certificate.** The chain was
    valid until 2028 and verified cleanly. What had actually happened is that the
    swap proxy on `8977` had died mid-session and its upstream on `2080` was not
    listening either. Check that the listeners exist before doubting the crypto.

### The shape of the mistake, said once

Nine of those ten are the same error: acting on a belief about the app instead of
reading the app, or writing a claim before measuring it. The two measurements that
would have collapsed the whole session into a few minutes were the base-directory
function in the app's own bundle and `grep custom-3p ~/Library/Logs/Claude/`. Both
were available from the start.

## 2026-08-25: the same mechanism on Windows, measured rather than assumed

Claude Desktop 1.34493.1 (Store build, MSIX, Electron 42.9.2), CLI 2.1.237, on
Windows 11. The five facts at the top of this file hold unchanged: the app is the
same bundle, `ccd-environment-config.json` is the same store under the same key,
and the store is still applied after the app's own computed values. What differs
is everything underneath the store, and each of these was measured.

**The store is locked with Chromium's Windows scheme, and it is not the macOS
one.** `v10`, then a twelve byte nonce, then AES-256-GCM, then a sixteen byte tag.
The key is not stretched from anything: Chromium makes it once, wraps it with
`CryptProtectData` for the logged-in account, and keeps it in `Local State` beside
the store under `os_crypt.encrypted_key`, with the five bytes `DPAPI` in front of
the wrapped bytes. It is per profile, because each profile has its own
`Local State`.

Proved rather than read off a page, by the same negative control the Linux side
uses for its key: the key was used to decrypt a value Claude Desktop itself had
written, a cookie in its own profile, which Chromium locks with the same key.
Nothing of that value was read or kept; the only answer taken was yes.

**A profile that is running cannot have its cookie store read.** The app holds
`Network/Cookies` with no sharing: `readFileSync` and `copyFileSync` both answer
`EBUSY` while the Window is open. That is why the Stats logins are read once and
kept on Windows and never kept on the Mac.

**`lockfile` in a profile's own folder answers whether that profile is open.**
Every Claude Desktop holds it for as long as it runs, which is how the app refuses
to open one folder twice. Opening it for writing answers the ADR 0012 question
about exactly one folder in no measurable time. The alternative was
`Get-CimInstance Win32_Process`, measured at about 550 ms filtered to `Claude.exe`
and 700 ms unfiltered, which the page asks for on every refresh.

**The Task Scheduler is not available to an ordinary account here.**
`schtasks /Create /TN x /TR "cmd.exe /c echo hi" /SC ONLOGON` answers "Access is
denied", at the root and in a folder of its own, and so does
`Register-ScheduledTask`. The user's own Startup folder is writable. So the
service is a `.vbs` there that starts the relay with no console window, waits for
it, and starts it again. Measured: killing the relay, it came back four seconds
later.

**`claude setup-token` writes to a terminal or it writes nothing, here too.**
Piped stdio produced zero bytes in ten seconds, the same reading as macOS on
2026-08-23. There is no `expect` and no pseudo-terminal Node can allocate without
a native build. What works is a real console window running PowerShell, the child
handed that same console with `Start-Process -NoNewWindow`, and the console's own
buffer read back with `GetBufferContents` while it runs. The buffer is widened to
a thousand columns first, and a four-hundred-character line then arrives whole,
which is the property the authorization link needs.

Three things went wrong on the way to that and each looks like nothing:

- `$held[$y, $x]` on the rectangular array `GetBufferContents` returns does not
  parse: PowerShell reads that index form as a slice of a flat array. The symptom
  is a console window that opens and does nothing. `GetValue($y, $x)` is the form
  that works.
- A backtick line continuation followed by CRLF does not continue the line. Same
  symptom. The script is written without continuations now.
- `Start-Process -ArgumentList` joins its list with spaces and quotes nothing, so
  an argument holding a space arrives at the child as two.

**Renaming a file can fail where copying it succeeds.** Under `%APPDATA%` and
`%LOCALAPPDATA%`, renaming onto a name that does not exist yet, in the same
directory, fails `EXDEV` every time; `copyFile` and `writeFile` in that same
directory succeed; the same rename under the user's home, the repository, and the
temporary folder all succeed. A filter driver is the likeliest reason and it does
not matter which: the app's own store lives under `%APPDATA%`.

**`-Command -` holds a block until a blank line.** PowerShell reading a script
from standard input treats a `foreach` block the way the prompt does. Without a
trailing empty line the script never runs at all: exit 0, nothing on either
stream, and an answer about no secrets.

**And one thing that was not a Windows fact at all.** Forty requests through the
relay cost fourteen connections on macOS and twenty-four here, from
`maxFreeSockets` alone. Node destroys a free socket the instant there is one too
many of them, and during a burst a socket becomes free a moment before the next
queued request asks for one; whether those land in the same tick is a scheduling
accident. Any value below the gate's limit makes the pool fight itself under
exactly the load it exists for, so the count no longer bounds anything and the
five second idle clock does. See `src/relay/internal/pool.ts`.

**Proved end to end on 2026-08-25**, by the same negative control `relay check`
uses on the Mac: a real Code session was handed a Send token that cannot work, it
answered anyway, and the server named the chosen Seat's own Organization as the
one that paid.
