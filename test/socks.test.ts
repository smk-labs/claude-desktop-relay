/**
 * SOCKS, so a machine that names only a SOCKS proxy is carried rather than stopped.
 *
 * The proof is a negative control throughout: the direct route is pointed at a dead
 * port, so a request that succeeds can only have gone through the SOCKS proxy. That
 * is the same shape as every other route claim in this repository, and it is the
 * only one that survives Node deciding to dial a host itself.
 */
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { createServer, type Socket as NetSocket } from "node:net";
import { once } from "node:events";

import { startRelay, type RelayNotice } from "../src/relay/index.ts";
import { socksConnect } from "../src/socks/index.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";
import { startFakeSocksProxy } from "./helpers/fake-socks-proxy.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { requestThrough } from "./helpers/through-the-relay.ts";
import { paying } from "./helpers/a-decision.ts";

const OPEN_HOST = "api.anthropic.com";
const BODY = `{"model":"claude-opus-5","messages":[]}`;

after(forgetAuthorities);

/** A dead port. Nothing is listening, so anything that dials direct fails. */
const NOWHERE = { host: "127.0.0.1", port: 1 };

async function aRelayThrough(options: {
  socks: { host: string; port: number };
  notices?: RelayNotice[];
  upstreamAuthority: string;
}) {
  const authority = await authorityFor(OPEN_HOST);
  return startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [options.upstreamAuthority],
    // The negative control. The relay believes this is where a direct dial lands.
    dial: () => NOWHERE,
    egress: async () => ({ kind: "socks", at: options.socks, credentials: null }),
    chargeFor: () => paying({ token: "sk-ant-oat01-seat-a", seat: "seat-a", organizationId: "org-seat-a" }),
    onNotice: (notice) => options.notices?.push(notice),
  });
}

test("a machine that names only a SOCKS proxy has its traffic carried through it", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const socks = await startFakeSocksProxy({ to: { host: "127.0.0.1", port: upstream.port } });
  const relay = await aRelayThrough({ socks: { host: "127.0.0.1", port: socks.port }, upstreamAuthority: upstream.authority });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      headers: [["Authorization", "Bearer sk-ant-oat01-the-window-account"]],
      body: BODY,
    });

    // Nothing is listening on the direct route, so this cannot have gone that way.
    assert.equal(answer.status, 200);
    assert.deepEqual(socks.asked, [`${OPEN_HOST}:443`]);

    // And the Seat's token still arrived, so the tunnel really carried the exchange
    // rather than merely being opened.
    const raw = upstream.seen[0]?.rawHeaders ?? [];
    const sent = raw.find((_, at) => raw[at - 1]?.toLowerCase() === "authorization");
    assert.equal(sent, "Bearer sk-ant-oat01-seat-a");
  } finally {
    await relay.close();
    await upstream.close();
    await socks.close();
  }
});

test("the host is sent as a name, so the proxy resolves it and no question leaks out", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const socks = await startFakeSocksProxy({ to: { host: "127.0.0.1", port: upstream.port } });
  const relay = await aRelayThrough({ socks: { host: "127.0.0.1", port: socks.port }, upstreamAuthority: upstream.authority });

  try {
    await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body: BODY,
    });

    // Resolving locally would put a DNS question for api.anthropic.com out over the
    // ordinary connection, which is exactly what the tunnel exists to prevent. The
    // fake refuses anything but the name form, so an address here would fail above.
    assert.deepEqual(socks.asked, [`${OPEN_HOST}:443`]);
  } finally {
    await relay.close();
    await upstream.close();
    await socks.close();
  }
});

test("connections through a SOCKS proxy are reused like any other", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const socks = await startFakeSocksProxy({ to: { host: "127.0.0.1", port: upstream.port } });
  const relay = await aRelayThrough({ socks: { host: "127.0.0.1", port: socks.port }, upstreamAuthority: upstream.authority });

  try {
    for (let one = 0; one < 3; one += 1) {
      const answer = await requestThrough({
        relay: relay.address,
        host: OPEN_HOST,
        port: 443,
        trust: upstream.authority,
        path: "/v1/messages",
        body: BODY,
      });
      assert.equal(answer.status, 200);
    }

    // One handshake through the proxy, not three. The pool does not care which
    // route a connection was opened by, which is the point of one dialler.
    assert.equal(socks.connections(), 1);
    assert.deepEqual(socks.asked, [`${OPEN_HOST}:443`]);
  } finally {
    await relay.close();
    await upstream.close();
    await socks.close();
  }
});

// ---- every failure is a real answer, never a way round -----------------------

/**
 * The rule this whole area exists for (ADR 0011): a route that will not carry the
 * request ends the request. Going straight out instead would put the request, its
 * credential and the fact of this machine talking to Anthropic outside the tunnel.
 */
async function failsRatherThanGoesRound(behaviour: Parameters<typeof startFakeSocksProxy>[0], because: RegExp) {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const socks = await startFakeSocksProxy(behaviour);
  const notices: RelayNotice[] = [];
  const relay = await aRelayThrough({
    socks: { host: "127.0.0.1", port: socks.port },
    notices,
    upstreamAuthority: upstream.authority,
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body: BODY,
    });

    assert.equal(answer.status, 502, "the request was carried by some other route");
    assert.equal(upstream.seen.length, 0, "something reached the upstream without going through the proxy");
    const said = notices.map((one) => one.summary).join("\n");
    assert.match(said, because);
  } finally {
    await relay.close();
    await upstream.close();
    await socks.close();
  }
}

test("a SOCKS proxy that refuses the tunnel fails the request, with its own reason", async () => {
  // 0x02: not allowed by ruleset, which is what a real one answers for a blocked
  // destination and the reason a user would need to see.
  await failsRatherThanGoesRound(
    { to: { host: "127.0.0.1", port: 1 }, refuseWith: 0x02 },
    /not allowed to make that connection/,
  );
});

test("a SOCKS proxy saying the host is unreachable fails the request, naming that", async () => {
  await failsRatherThanGoesRound({ to: { host: "127.0.0.1", port: 1 }, refuseWith: 0x04 }, /host is unreachable/);
});

test("something that is not a SOCKS5 proxy fails the request, saying so", async () => {
  await failsRatherThanGoesRound({ to: { host: "127.0.0.1", port: 1 }, pretendVersion: 4 }, /not a SOCKS5 proxy/);
});

test("a proxy that accepts none of our methods fails the request, and says authentication", async () => {
  await failsRatherThanGoesRound(
    { to: { host: "127.0.0.1", port: 1 }, acceptNothing: true },
    /wants authentication, and none is set/,
  );
});

test("a proxy that asks for a password when none is set fails saying exactly that", async () => {
  // Never silently ignored, which is the criterion. macOS keeps the password in a
  // Keychain item belonging to the system, so this is the case a real machine hits.
  await failsRatherThanGoesRound(
    { to: { host: "127.0.0.1", port: 1 }, wants: { user: "someone", password: "secret" } },
    /asked for a username and password/,
  );
});

// ---- the handshake on its own -------------------------------------------------

test("a username and password are sent when they are given, and the tunnel opens", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const socks = await startFakeSocksProxy({
    to: { host: "127.0.0.1", port: upstream.port },
    wants: { user: "someone", password: "secret" },
  });

  try {
    const tunnel = await socksConnect({
      through: { host: "127.0.0.1", port: socks.port },
      to: { host: OPEN_HOST, port: 443 },
      credentials: { user: "someone", password: "secret" },
    });
    assert.deepEqual(socks.asked, [`${OPEN_HOST}:443`]);
    tunnel.destroy();
  } finally {
    await upstream.close();
    await socks.close();
  }
});

test("the wrong password is refused, and says which step failed", async () => {
  const socks = await startFakeSocksProxy({
    to: { host: "127.0.0.1", port: 1 },
    wants: { user: "someone", password: "secret" },
  });

  try {
    await assert.rejects(
      socksConnect({
        through: { host: "127.0.0.1", port: socks.port },
        to: { host: OPEN_HOST, port: 443 },
        credentials: { user: "someone", password: "wrong" },
      }),
      /rejected the username and password/,
    );
  } finally {
    await socks.close();
  }
});

test("a proxy that is not there at all fails rather than hanging", async () => {
  await assert.rejects(
    socksConnect({ through: NOWHERE, to: { host: OPEN_HOST, port: 443 } }),
    /ECONNREFUSED|connect/,
  );
});

test("a name too long for the protocol is refused before anything is sent", async () => {
  const socks = await startFakeSocksProxy({ to: { host: "127.0.0.1", port: 1 } });
  try {
    await assert.rejects(
      socksConnect({
        through: { host: "127.0.0.1", port: socks.port },
        to: { host: "x".repeat(300), port: 443 },
      }),
      /too long for SOCKS5/,
    );
    // Nothing was asked for, because the request was never built.
    assert.deepEqual(socks.asked, []);
  } finally {
    await socks.close();
  }
});

/**
 * The clock the HTTP proxy path has had since 2026-08-23, in the egress that
 * never got it.
 *
 * A proxy that accepts the connection and then says nothing is not a proxy that
 * refuses: nothing errors, nothing closes, and every step of the handshake waits
 * on bytes that are not coming. On the HTTP path that hung every tunnel in the
 * Window until a clock was put on it. This path had no clock at all, on the one
 * kind of machine most likely to produce the fault, so it is asserted here as a
 * property of the handshake itself rather than through the relay.
 */
test("a SOCKS proxy that accepts and then says nothing fails rather than hanging", async () => {
  // Accepts, holds, and answers nothing. Deliberately not the shared helper: the
  // point is a proxy that never speaks the protocol at all.
  const held: NetSocket[] = [];
  const mute = createServer((socket) => held.push(socket));
  mute.listen(0, "127.0.0.1");
  await once(mute, "listening");
  const port = (mute.address() as { port: number }).port;

  const PATIENCE = 300;

  try {
    const began = Date.now();
    await assert.rejects(
      socksConnect({
        through: { host: "127.0.0.1", port },
        to: { host: OPEN_HOST, port: 443 },
        patience: PATIENCE,
      }),
      /did not answer within/,
      "a silent SOCKS proxy has to fail with a reason, not wait for ever",
    );
    const took = Date.now() - began;
    assert.ok(took < PATIENCE * 8, `it must give up on its own clock, took ${took}ms`);
  } finally {
    for (const socket of held) socket.destroy();
    mute.close();
  }
});
