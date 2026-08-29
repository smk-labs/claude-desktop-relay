import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { once } from "node:events";
import { connect as connectTcp } from "node:net";

import { NOTHING_READ, startRelay, type RelayNotice } from "../src/relay/index.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { startEchoServer, startFakeUpstream, startRudeUpstream } from "./helpers/fake-upstream.ts";
import {
  manyDownOneConnection,
  pipelineThrough,
  readBack,
  requestThrough,
  secureTunnelThrough,
  tunnelThrough,
} from "./helpers/through-the-relay.ts";
import { aClosedPort, startFakeMachineProxy } from "./helpers/fake-machine-proxy.ts";
import { until } from "./helpers/until.ts";

const OPEN_HOST = "api.anthropic.com";

after(forgetAuthorities);

/**
 * A relay wired to the given fake upstream, with the certificate it needs to
 * open `api.anthropic.com` and the authority it needs to trust that upstream.
 *
 * `dial` is how a test puts a loopback port where the real internet would be:
 * the relay still believes it is reaching api.anthropic.com on 443.
 */
async function relayFor(options: {
  redirect: Readonly<Record<string, { host: string; port: number }>>;
  trust?: readonly string[];
  machineProxy?: { host: string; port: number } | null;
  notices?: RelayNotice[];
  whenTheProxyIsGone?: "refuse" | "go-direct";
  /** Set to have a Seat's credential travelling, which is what ADR 0011 protects. */
  payingSeat?: string;
}) {
  const authority = await authorityFor(OPEN_HOST);

  return startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    ...(options.trust === undefined ? {} : { trust: options.trust }),
    ...(options.machineProxy === undefined ? {} : { machineProxy: options.machineProxy }),
    ...(options.whenTheProxyIsGone === undefined ? {} : { whenTheProxyIsGone: options.whenTheProxyIsGone }),
    ...(options.payingSeat === undefined
      ? {}
      : {
          chargeFor: () => ({
            charge: {
              token: "sk-ant-oat01-a-seat-token",
              seat: options.payingSeat as string,
              organizationId: "org-a-seat",
            },
            about: NOTHING_READ,
          }),
        }),
    dial: (host, port) => options.redirect[`${host}:${port}`] ?? { host, port },
    onNotice: (notice) => options.notices?.push(notice),
  });
}

test("a request arrives at the upstream with its headers as they were written", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages?beta=true",
      headers: [
        ["Content-Type", "application/json"],
        ["X-Weird-Casing", "kept"],
        ["anthropic-beta", "oauth-2025-04-20"],
        ["Authorization", "Bearer sk-ant-oat01-caller"],
        ["X-Twice", ["once", "twice"]],
        ["Proxy-Connection", "keep-alive"],
      ],
      body: `{"model":"claude-opus-5"}`,
    });

    assert.equal(answer.status, 200);
    assert.equal(upstream.seen.length, 1);

    const seen = upstream.seen[0];
    assert.equal(seen?.method, "POST");
    assert.equal(seen?.url, "/v1/messages?beta=true");
    assert.equal(seen?.body, `{"model":"claude-opus-5"}`);

    const raw = seen?.rawHeaders ?? [];
    assert.ok(raw.includes("X-Weird-Casing"), `casing was not kept: ${raw.join(", ")}`);
    assert.equal(raw[raw.indexOf("X-Weird-Casing") + 1], "kept");
    assert.equal(raw[raw.indexOf("Authorization") + 1], "Bearer sk-ant-oat01-caller");
    assert.ok(!raw.some((h) => h.toLowerCase() === "proxy-connection"), "proxy-connection must not travel on");

    // Order is part of "as they were written", so pin the sequence, not just
    // the presence of each name.
    const mine = ["Content-Type", "X-Weird-Casing", "anthropic-beta", "Authorization", "X-Twice"];
    const arrived = raw.filter((h, i) => i % 2 === 0 && mine.includes(h));
    assert.deepEqual(
      arrived,
      [...mine, "X-Twice"],
      "the header order the client wrote must survive, and a repeat stays a repeat",
    );

    // A header sent twice must arrive twice, not be collapsed into one.
    const twice = raw.filter((h, i) => i % 2 === 1 && raw[i - 1] === "X-Twice");
    assert.deepEqual(twice, ["once", "twice"]);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("any other host is tunnelled blind, proved by a certificate the relay cannot forge", async () => {
  const elsewhere = await startFakeUpstream("somewhere.else.test");
  const relay = await relayFor({
    redirect: { "somewhere.else.test:443": { host: "127.0.0.1", port: elsewhere.port } },
  });

  try {
    // The relay holds no certificate for somewhere.else.test and is not trusted
    // by this client for it. If it opened the connection the handshake would fail.
    const answer = await requestThrough({
      relay: relay.address,
      host: "somewhere.else.test",
      port: 443,
      trust: elsewhere.authority,
      path: "/anything",
      method: "GET",
    });

    assert.equal(answer.status, 200);
    assert.equal(elsewhere.seen.length, 1);
    assert.equal(elsewhere.seen[0]?.url, "/anything");
  } finally {
    await relay.close();
    await elsewhere.close();
  }
});

test("a reply streams through rather than being collected and re-sent", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  let releaseSecondPart = () => {};
  const secondPartReleased = new Promise<void>((resolve) => {
    releaseSecondPart = resolve;
  });

  upstream.reply = {
    parts: ["first\n", () => secondPartReleased, "second\n"],
  };

  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      // The upstream will not write "second" until the client has "first". If the
      // relay collected the whole reply first, this would deadlock, not pass.
      onFirstChunk: releaseSecondPart,
    });

    assert.equal(answer.body, "first\nsecond\n");
    assert.ok(answer.chunks.length >= 2, `expected more than one chunk, got ${answer.chunks.length}`);
    assert.equal(answer.chunks[0]?.text, "first\n");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("bytes written the instant the tunnel opens are not dropped", async () => {
  const echo = await startEchoServer();
  const relay = await relayFor({
    redirect: { "echo.test:443": { host: "127.0.0.1", port: echo.port } },
  });

  // Half a megabyte, written without waiting. If the relay answered CONNECT
  // before wiring the pipe, the leading chunks would be read and thrown away.
  const payload = "x".repeat(512 * 1024);

  try {
    const socket = await tunnelThrough(relay.address, "echo.test:443");
    socket.resume();
    socket.write(payload);

    let back = "";
    for await (const chunk of socket) {
      back += (chunk as Buffer).toString("utf8");
      if (back.length >= payload.length) break;
    }
    socket.destroy();

    assert.equal(back.length, payload.length);
    assert.equal(back, payload);
  } finally {
    await relay.close();
    await echo.close();
  }
});

test("a TLS handshake survives the blind tunnel, which is what a dropped chunk kills", async () => {
  const elsewhere = await startFakeUpstream("handshake.test");
  const relay = await relayFor({
    redirect: { "handshake.test:443": { host: "127.0.0.1", port: elsewhere.port } },
  });

  try {
    const secure = await secureTunnelThrough(relay.address, "handshake.test", 443, elsewhere.authority);
    assert.equal(secure.authorized, true);
    secure.destroy();
  } finally {
    await relay.close();
    await elsewhere.close();
  }
});

test("with no proxy configured on the machine, the relay still reaches the upstream", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
    machineProxy: null,
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
    });
    assert.equal(answer.status, 200);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("a machine proxy is chained to, so egress is unchanged", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const machineProxy = await startFakeMachineProxy({
    [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port },
  });
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
    machineProxy,
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
    });

    assert.equal(answer.status, 200);
    assert.deepEqual(machineProxy.asked, [`${OPEN_HOST}:443`]);
  } finally {
    await relay.close();
    await machineProxy.close();
    await upstream.close();
  }
});

/**
 * This used to assert the opposite: that a dead proxy was mentioned and the work
 * carried on straight out. That was a bypass of the route the machine is set up
 * to take, and on a machine where the proxy is a VPN it is both a leak and a
 * request that would have failed a second later anyway. ADR 0011.
 */
/**
 * The rule, as it should have been written the first time.
 *
 * What ADR 0011 protects is a Seat's credential leaving by a route the machine
 * did not choose. Written as "nothing leaves any other way" it also strangled
 * every blind tunnel, and on 2026-08-23 a VPN blink took ten MCP servers down
 * with it: traffic carrying nobody's credential, which would have gone straight
 * out if this program had never been installed. Both halves are asserted here so
 * neither can drift back.
 */
test("a dead machine proxy refuses the request when a Seat's credential would travel", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const notices: RelayNotice[] = [];
  const deadPort = await aClosedPort();
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
    machineProxy: { host: "127.0.0.1", port: deadPort },
    payingSeat: "seat-a",
    notices,
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body: `{"model":"claude-opus-5","messages":[]}`,
    });

    assert.equal(answer.status, 502, "a Seat's credential must not take a route the machine did not choose");
    assert.equal(upstream.seen.length, 0, "and nothing may reach the upstream by another way");

    const reported = notices.find((n) => n.kind === "machine-proxy-unreachable");
    assert.ok(reported, `expected a notice, got ${JSON.stringify(notices)}`);
    assert.match(reported.summary, /was NOT sent/);
    assert.match(reported.summary, /Seat's credential/i, "and it says what it was protecting");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The other half, and the one whose absence cost a whole Window.
 *
 * With no Seat paying there is nothing of ours on the wire, so a dead proxy is
 * not a reason to stop the app working. This is the case `relay off` is, and it
 * is every MCP server all the time.
 */
test("with no Seat paying, a dead machine proxy does not stop the request", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const notices: RelayNotice[] = [];
  const deadPort = await aClosedPort();
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
    machineProxy: { host: "127.0.0.1", port: deadPort },
    notices,
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
    });

    assert.equal(answer.status, 200, "nobody's credential is travelling, so this must still work");
    assert.equal(upstream.seen.length, 1);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/** A blind tunnel carries nobody's credential either, and must never be refused. */
test("a blind tunnel still opens when the machine's proxy is gone", async () => {
  const echo = await startEchoServer();
  const notices: RelayNotice[] = [];
  const deadPort = await aClosedPort();
  const relay = await relayFor({
    redirect: { "somewhere.else:443": { host: "127.0.0.1", port: echo.port } },
    machineProxy: { host: "127.0.0.1", port: deadPort },
    notices,
  });

  try {
    const socket = await tunnelThrough(relay.address, "somewhere.else:443");
    socket.write("hello");
    assert.equal(await readBack(socket, 5), "hello", "an MCP server's traffic may not be strangled by a VPN blink");
    socket.destroy();
  } finally {
    await relay.close();
    await echo.close();
  }
});

/** The old behaviour is still reachable, for a machine that genuinely wants it. */
test("a machine that asks to go direct when its proxy is gone still can", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const deadPort = await aClosedPort();
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
    machineProxy: { host: "127.0.0.1", port: deadPort },
    whenTheProxyIsGone: "go-direct",
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
    });
    assert.equal(answer.status, 200);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The chokepoint, as a negative control rather than as an argument.
 *
 * The direct route is pointed at a port with nothing on it, so the only way to
 * reach the upstream at all is through the proxy. A request that succeeds is
 * proof it went through; anything that dials round the proxy fails. This is what
 * makes the whole class of "Node quietly dialled the host itself" fail loudly:
 * it has happened once already, with `agent: false`, and it reached the real
 * Cloudflare.
 */
test("with a proxy configured, the only way out is through it", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const proxy = await startFakeMachineProxy({ [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } });
  const nowhere = await aClosedPort();
  const authority = await authorityFor(OPEN_HOST);

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    machineProxy: { host: proxy.host, port: proxy.port },
    // Every direct dial lands on a dead port. Nothing can reach the upstream
    // except by the proxy, so success is proof of the route.
    dial: () => ({ host: "127.0.0.1", port: nowhere }),
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
    });

    assert.equal(answer.status, 200, "it got through, so it went through the proxy");
    assert.deepEqual(proxy.asked, [`${OPEN_HOST}:443`], "and the proxy is the one that was asked");
    assert.equal(upstream.seen.length, 1);
  } finally {
    await relay.close();
    await proxy.close();
    await upstream.close();
  }
});

/**
 * Something named that we cannot speak is refused, but only for what it protects.
 *
 * Same narrowing as the dead-proxy case: a Seat's credential does not go round
 * the machine's route, and everything else carries on as it would have without
 * this program.
 */
test("a way out the relay cannot speak is refused when a Seat's credential would travel", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const notices: RelayNotice[] = [];
  const authority = await authorityFor(OPEN_HOST);

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    egress: async () => ({ kind: "refuse", why: "the machine names a SOCKS proxy and no HTTPS one" }),
    chargeFor: () => ({
      charge: { token: "sk-ant-oat01-a-seat-token", seat: "seat-a", organizationId: "org-a-seat" },
      about: NOTHING_READ,
    }),
    onNotice: (notice) => notices.push(notice),
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body: `{"model":"claude-opus-5","messages":[]}`,
    });

    assert.equal(answer.status, 502);
    assert.equal(upstream.seen.length, 0, "the upstream was reachable, and still nothing went to it");
    assert.ok(
      notices.some((n) => /SOCKS/.test(n.summary)),
      `the reason has to reach the user: ${JSON.stringify(notices)}`,
    );
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("a plain request to the relay is refused, because it only speaks CONNECT", async () => {
  const relay = await relayFor({ redirect: {} });

  try {
    const socket = connectTcp(relay.address.port, relay.address.host);
    await once(socket, "connect");
    socket.write("GET /health HTTP/1.1\r\nHost: relay\r\n\r\n");

    let head = "";
    for await (const chunk of socket) {
      head += (chunk as Buffer).toString("latin1");
      if (head.includes("\r\n\r\n")) break;
    }
    socket.destroy();

    assert.match(head, /^HTTP\/1\.1 405/);
    assert.match(head, /CONNECT/);
  } finally {
    await relay.close();
  }
});

test("closing the relay hangs up on open tunnels instead of waiting for them", async () => {
  const echo = await startEchoServer();
  const relay = await relayFor({
    redirect: { "echo.test:443": { host: "127.0.0.1", port: echo.port } },
  });

  const socket = await tunnelThrough(relay.address, "echo.test:443");
  socket.resume();
  socket.write("still here");

  // A tunnel is open and idle. `close` must not wait for it, which for a proxy
  // would mean waiting forever.
  await relay.close();
  socket.destroy();
  await echo.close();
});

test("a client that vanishes mid-dial does not take the relay down with it", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
  });

  try {
    // A reset while the relay is still dialling used to emit an 'error' nobody
    // was listening for, which is an uncaught exception and a dead process.
    for (let attempt = 0; attempt < 20; attempt++) {
      const socket = connectTcp(relay.address.port, relay.address.host);
      await once(socket, "connect");
      socket.write(`CONNECT ${OPEN_HOST}:443 HTTP/1.1\r\nHost: ${OPEN_HOST}:443\r\n\r\n`);
      socket.resetAndDestroy();
    }

    // Still serving, which it would not be if the process had died.
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
    });
    assert.equal(answer.status, 200);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("a CONNECT target with a nonsense port falls back rather than dialling NaN", async () => {
  const echo = await startEchoServer();
  const relay = await relayFor({
    redirect: { "echo.test:443": { host: "127.0.0.1", port: echo.port } },
  });

  try {
    const socket = await tunnelThrough(relay.address, "echo.test:not-a-port");
    socket.resume();
    socket.write("hello");

    let back = "";
    for await (const chunk of socket) {
      back += (chunk as Buffer).toString("utf8");
      if (back.length >= 5) break;
    }
    socket.destroy();
    assert.equal(back, "hello");
  } finally {
    await relay.close();
    await echo.close();
  }
});

test("bytes sent in the same write as CONNECT are not lost", async () => {
  const echo = await startEchoServer();
  const relay = await relayFor({
    redirect: { "echo.test:443": { host: "127.0.0.1", port: echo.port } },
  });

  // A real client puts its opening TLS record straight after the CONNECT request
  // rather than waiting to be told the tunnel is open. Those bytes reach the
  // relay attached to the request itself, and a relay that ignores them drops
  // the handshake.
  const payload = "y".repeat(64 * 1024);

  try {
    const socket = await pipelineThrough(relay.address, "echo.test:443", payload, { together: true });
    const back = await readBack(socket, payload.length);
    socket.destroy();

    assert.equal(back.length, payload.length);
    assert.equal(back, payload);
  } finally {
    await relay.close();
    await echo.close();
  }
});

test("bytes sent while the relay is still dialling are not lost", async () => {
  const echo = await startEchoServer();
  // The machine's proxy dawdles, which widens the window between the client
  // writing and the relay having anywhere to put what it wrote.
  const machineProxy = await startFakeMachineProxy({ "echo.test:443": { host: "127.0.0.1", port: echo.port } }, 120);
  const relay = await relayFor({ redirect: {}, machineProxy });

  const payload = "z".repeat(64 * 1024);

  try {
    const socket = await pipelineThrough(relay.address, "echo.test:443", payload, {
      together: false,
      afterMs: 20,
    });
    const back = await readBack(socket, payload.length);
    socket.destroy();

    assert.equal(back.length, payload.length);
    assert.equal(back, payload);
  } finally {
    await relay.close();
    await machineProxy.close();
    await echo.close();
  }
});

test("a relay whose machine proxy is itself says so and goes straight out instead", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const notices: RelayNotice[] = [];
  const authority = await authorityFor(OPEN_HOST);

  // Two steps, because the relay's own address is not knowable until it has one.
  // A first relay is started only to learn a port that is genuinely in use.
  const first = await startRelay({ openHost: OPEN_HOST, certificate: authority.leaf });
  const itsOwnAddress = { ...first.address };
  await first.close();

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    listen: { host: itsOwnAddress.host, port: itsOwnAddress.port },
    machineProxy: itsOwnAddress,
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    onNotice: (notice) => notices.push(notice),
  });

  try {
    // Chaining to itself would be the relay opening a tunnel to the relay, which
    // looks like a hang with nothing in any log to explain it.
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
    });

    assert.equal(answer.status, 200, "the request must still land");
    const said = notices.find((notice) => /this relay/.test(notice.summary));
    assert.ok(said, `expected to be told, got ${JSON.stringify(notices)}`);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("the relay does not leave a connection open behind every request", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
  });

  const HOW_MANY = 25;

  try {
    // Down one connection that stays open, which is what a real Code session
    // does. A fresh tunnel per request hides this entirely: the client hanging up
    // takes the relay's upstream socket with it, so the leak never shows.
    const answered = await manyDownOneConnection({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      howMany: HOW_MANY,
    });

    assert.equal(answered, HOW_MANY, "every request must have been answered");
    assert.equal(upstream.seen.length, HOW_MANY, "and must have arrived");

    await new Promise((resolve) => setTimeout(resolve, 200));

    // One connection per request is how this is built today, which is slow but
    // correct. Never closing them is not: a busy session left hundreds open until
    // the machine's own proxy ran out of room and began refusing new ones as
    // "socket hang up". Measured at 364 before this was fixed.
    assert.ok(
      upstream.openConnections() <= 2,
      `${upstream.openConnections()} connections still open after ${HOW_MANY} requests down one tunnel`,
    );
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("a caller that hangs up is not reported as a failure", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const notices: RelayNotice[] = [];
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
    notices,
  });

  // The upstream will not answer until it is let go, which leaves a window for
  // the caller to change its mind. A Code session does this often: it cancels
  // work it no longer needs, and the user pressing escape does the same thing.
  let letTheUpstreamAnswer = () => {};
  upstream.reply = {
    parts: [() => new Promise<void>((resolve) => (letTheUpstreamAnswer = resolve)), "too late"],
  };

  try {
    const secure = await secureTunnelThrough(relay.address, OPEN_HOST, 443, upstream.authority);
    const outgoing = (await import("node:http")).request({
      createConnection: () => secure,
      host: OPEN_HOST,
      port: 443,
      path: "/v1/messages",
      method: "POST",
    });
    // Heard because we are about to abandon it on purpose, and an unheard error
    // on an abandoned request would fail this test for the wrong reason.
    outgoing.once("error", () => {});
    outgoing.end("{}");

    // Wait until the upstream has the request in hand, then vanish.
    await until(() => upstream.seen.length > 0);
    assert.equal(upstream.seen.length, 1, "the request must have reached the upstream first");
    secure.destroy();

    /**
     * The relay is given time to notice before the upstream is let go, and the
     * order is the whole test.
     *
     * Letting the upstream answer first is a race, and it is the race this test
     * kept losing: the reply arrives, the relay writes it onto a socket that is
     * already gone, Node marks the response finished because the write did not
     * fail, and `writableFinished` being true is exactly what tells the relay the
     * caller did not go away. Zero notices, two runs in ten, and no timeout was
     * ever going to fix it.
     *
     * What this test is about is a caller vanishing while the upstream is still
     * thinking, which is what a Code session cancelling work actually looks like.
     * So that is the order it drives.
     */
    const said = await until(() => notices.find((notice) => notice.kind === "caller-went-away"));
    assert.ok(said, `expected to be told the caller went away, got ${JSON.stringify(notices)}`);

    // Only now, so nothing above depended on how fast the far end was.
    letTheUpstreamAnswer();

    const blamed = notices.filter((notice) => notice.kind === "open-failed");
    assert.deepEqual(blamed, [], `a caller hanging up must not be reported as a failure: ${JSON.stringify(blamed)}`);
    assert.match(said.summary, /hung up before the reply/);
    assert.match(said.summary, /exchanges in the air/, "and it must say how busy things were");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("an upstream that hangs up after taking the request is a real failure", async () => {
  const rude = await startRudeUpstream(OPEN_HOST);
  const notices: RelayNotice[] = [];
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: rude.port } },
    trust: [(await authorityFor(OPEN_HOST)).caCertificate],
    notices,
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: (await authorityFor(OPEN_HOST)).caCertificate,
      path: "/v1/messages",
      body: "{}",
    });

    assert.equal(answer.status, 502, "the caller must be told plainly, not left hanging");

    const blamed = notices.find((notice) => notice.kind === "open-failed");
    assert.ok(blamed, `expected a failure, got ${JSON.stringify(notices)}`);
    assert.match(blamed.summary, /answered nothing/);
    assert.ok(
      !notices.some((notice) => notice.kind === "caller-went-away"),
      "and it must not be blamed on the caller",
    );
  } finally {
    await relay.close();
    await rude.close();
  }
});

test("an upstream that disappears entirely is reported as unreachable", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const notices: RelayNotice[] = [];
  const relay = await relayFor({
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
    trust: [upstream.authority],
    notices,
  });

  // As if the network went away between one request and the next.
  await upstream.close();

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body: "{}",
    });

    assert.equal(answer.status, 502);
    const blamed = notices.find((notice) => notice.kind === "open-failed");
    assert.ok(blamed, `expected a failure, got ${JSON.stringify(notices)}`);
    assert.match(blamed.summary, /Could not reach/);
  } finally {
    await relay.close();
  }
});

test("a port somebody else holds is explained, not left as a bare error code", async () => {
  const { createServer } = await import("node:net");
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const taken = (blocker.address() as { port: number }).port;

  const authority = await authorityFor(OPEN_HOST);

  try {
    // Under a service that restarts whatever happens, this is the difference
    // between a log full of EADDRINUSE and knowing what to do about it.
    await assert.rejects(
      () =>
        startRelay({
          listen: { host: "127.0.0.1", port: taken },
          openHost: OPEN_HOST,
          certificate: authority.leaf,
        }),
      (error: Error) => {
        assert.match(error.message, new RegExp(`port ${taken} is already taken`));
        assert.match(error.message, /lsof/, "and it must say how to find what holds it");
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("a machine proxy that appears after the relay started is picked up", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const machineProxy = await startFakeMachineProxy({
    [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port },
  });
  const authority = await authorityFor(OPEN_HOST);

  // A VPN that comes up after login must be honoured. Reading the setting once
  // means every request after that goes round it, silently.
  let inUse: { host: string; port: number } | null = null;

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    machineProxy: async () => inUse,
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
  });

  const ask = () =>
    requestThrough({ relay: relay.address, host: OPEN_HOST, port: 443, trust: upstream.authority });

  try {
    await ask();
    assert.deepEqual(machineProxy.asked, [], "no proxy set, so nothing was chained to");

    inUse = { host: machineProxy.host, port: machineProxy.port };
    await ask();
    assert.deepEqual(machineProxy.asked, [`${OPEN_HOST}:443`], "the proxy that appeared must be used");

    inUse = null;
    await ask();
    assert.equal(machineProxy.asked.length, 1, "and a proxy that went away must not be waited on");
  } finally {
    await relay.close();
    await machineProxy.close();
    await upstream.close();
  }
});
