# Never leave except the way the machine would

The relay chains to whatever proxy the machine already uses, so that egress is
unchanged. Until now there was one exception: a proxy that was named but not
listening made the relay say so and then go straight out. That exception is
removed. When the machine names a way out, the relay uses it or refuses.

## Why the exception was wrong

It was written for a laptop whose VPN had gone down, where carrying on beats
stopping. On this machine it is the opposite, and the reasoning is not about
convenience:

- The route is the point. Here the machine's proxy is an app acting as a VPN, and
  `api.anthropic.com` is not reachable without it. A "fallback" to direct is not a
  fallback, it is a request that fails a second later with a less useful error.
- A direct dial is a leak. It sends the request, its credential and the fact that
  this machine is talking to Anthropic out over the ordinary connection, which is
  exactly what the tunnel exists to prevent. Doing that on a transient
  `ECONNREFUSED`, silently, is a decision no program should make on the user's
  behalf.
- It contradicts the spec's own rule. "Failure is closed, never quiet." A request
  that cannot take the route the machine is set up to take has not failed safe by
  going round it.

## The decision

Three answers to "how does traffic leave", and no fourth:

- **The machine names a proxy we can speak to.** Chain through it. If it will not
  take the tunnel, that is a real answer and the request fails.
- **The machine names nothing.** Go straight out, because that is what the machine
  itself would do. A transparent VPN on a TUN device is this case: nothing is
  named because nothing needs to be, and the traffic is already inside the tunnel
  at the IP layer.
- **The machine names something we cannot speak.** Refuse, and say what it is.
  A SOCKS proxy with no HTTPS proxy beside it is this case today. Going direct
  here would be a bypass dressed up as a default.

`whenTheProxyIsGone` can be set to `go-direct` for a machine where the old
behaviour is genuinely wanted. It is not the default and nothing in `src/` sets
it. One test does, to prove the setting is still reachable
(`test/relay.test.ts`), which is the only place it should ever appear.

## Consequences

- A machine whose proxy dies stops reaching Anthropic, loudly, until it is back.
  That is the intended outcome, not a regression.
- Anything that dials the upstream has to go through one function, and a test
  proves it: with a proxy configured, the direct route is pointed at a dead port,
  so a request that succeeds can only have gone through the proxy. Same negative
  control the rest of this repo uses.
- This is the second time Node has been caught dialling round us. Setting
  `agent: false` on an upstream request made it ignore `createConnection` and
  reach the real Cloudflare (docs/mechanism.md, 2026-08-22). The chokepoint test
  is what makes that class of mistake fail loudly rather than quietly work.


## Narrowed, 2026-08-23, after it took a Window down

As first written this said "nothing leaves except the way the machine would", and
applied it to every socket the relay opens. That was too broad by exactly the
amount that matters.

The relay's address goes into the app's own environment store, and **every child
the app starts inherits it**, not only Code sessions. On the user's working Window
that is ten MCP servers. So when the VPN blinked, the rule refused their traffic
too: traffic carrying nobody's credential, which would have gone straight out had
this program never been installed. Refusing it protected nothing and stopped
everything. The Proving Window never showed this because it runs zero MCP servers.

What the rule actually protects is a Seat's credential. So it now says that:

> A Seat's credential never leaves except the way the machine would. Everything
> else falls back and says so, exactly as it did before this program existed.

In practice: `dialUpstream` is told whether a Seat is paying for this socket.
Blind tunnels always say no. The pool says it per Seat, so Off mode says no too,
which is what makes `relay off` work when the route is broken rather than being
one more thing that cannot help.

## And a clock, which there was none of

The same failure found a second hole: nothing in the dial had a timeout. A proxy
that accepted the connection and then went silent left every tunnel waiting for
ever. That is not an error anyone sees; it is an app that appears to have frozen,
and neither `relay off` nor `relay uninstall` can rescue it, because the app read
the relay's address once at startup and only a restart changes it.

The whole handshake now has eight seconds. A proxy on loopback answers in
milliseconds, so this is not a performance limit; it is the line between "busy"
and "not coming back". A test drives a proxy that accepts and never answers, and
without the clock that test does not finish.
