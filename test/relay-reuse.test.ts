/**
 * Connections to the upstream, kept warm and reused.
 *
 * One exchange used to cost one handshake, so a session with parallel agents was
 * hundreds of them through the machine's proxy. Reuse is worth having and it brings
 * exactly one new way to fail: a connection the far end killed while it sat idle,
 * handed to a request that then fails for no reason anybody did anything about.
 * Most of this file is about that, and about the two things that must never happen
 * whatever else does — two Seats on one connection, and one request charged twice.
 */
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { connect } from "node:net";
import { once } from "node:events";

import { startRelay, type Exchange, type RelayNotice } from "../src/relay/index.ts";
import { IDLE_FOR_AT_MOST_MS } from "../src/relay/index.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";
import { startFakeMachineProxy } from "./helpers/fake-machine-proxy.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { requestThrough } from "./helpers/through-the-relay.ts";
import { paying } from "./helpers/a-decision.ts";
import type { Charge } from "../src/relay/index.ts";

const OPEN_HOST = "api.anthropic.com";
const BODY = `{"model":"claude-opus-5","messages":[]}`;

after(forgetAuthorities);

const aCharge = (seat: string): Charge => ({
  token: `sk-ant-oat01-${seat}`,
  seat,
  organizationId: `org-${seat}`,
});

async function aRelay(options: {
  upstream: FakeUpstream;
  charge?: () => Charge | null;
  idleForAtMostMs?: number;
  exchanges?: Exchange[];
  notices?: RelayNotice[];
}) {
  const authority = await authorityFor(OPEN_HOST);
  return startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [options.upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: options.upstream.port }),
    ...(options.idleForAtMostMs === undefined ? {} : { idleForAtMostMs: options.idleForAtMostMs }),
    chargeFor: () => paying(options.charge === undefined ? aCharge("seat-a") : options.charge()),
    onExchange: (exchange) => options.exchanges?.push(exchange),
    onNotice: (notice) => options.notices?.push(notice),
  });
}

const ask = (relay: { address: { host: string; port: number } }, upstream: FakeUpstream, path = "/v1/messages") =>
  requestThrough({
    relay: relay.address,
    host: OPEN_HOST,
    port: 443,
    trust: upstream.authority,
    path,
    headers: [["Authorization", "Bearer sk-ant-oat01-the-window-account"]],
    body: BODY,
  });

test("a burst is served over far fewer connections than requests", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await aRelay({ upstream });
  try {
    const HOW_MANY = 40;
    const answers = await Promise.all(Array.from({ length: HOW_MANY }, () => ask(relay, upstream)));

    for (const answer of answers) assert.equal(answer.status, 200);
    assert.equal(upstream.seen.length, HOW_MANY);

    // The gate allows twelve in the air, so twelve handshakes is the floor for a
    // burst of forty arriving at once. Forty was the old number.
    const opened = upstream.totalConnections();
    assert.equal(opened <= 14, true, `${HOW_MANY} requests over ${opened} connections`);
    assert.equal(opened >= 1, true);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("requests one after another share one connection, so a quiet session opens one", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await aRelay({ upstream });
  try {
    for (let one = 0; one < 6; one += 1) assert.equal((await ask(relay, upstream)).status, 200);

    assert.equal(upstream.totalConnections(), 1, "six requests, one handshake");
    assert.deepEqual(
      upstream.seen.map((one) => one.connection),
      [1, 1, 1, 1, 1, 1],
    );
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The rule that is safety by construction rather than by argument.
 *
 * HTTP/1.1 authenticates a request and not a connection, so two Seats sharing one
 * would very probably be billed correctly. "Very probably" about who is billed is
 * not something this program says, so the pool is keyed by Seat and the question
 * does not arise.
 */
test("no two Seats ever share a connection", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const seats = ["seat-a", "seat-b", "seat-a", "seat-b", "seat-a"];
  let next = 0;
  const relay = await aRelay({ upstream, charge: () => aCharge(seats[next++] ?? "seat-a") });

  try {
    for (let one = 0; one < seats.length; one += 1) assert.equal((await ask(relay, upstream)).status, 200);

    const tokenOn = new Map<number, Set<string>>();
    for (const arrived of upstream.seen) {
      const raw = arrived.rawHeaders;
      let token = "";
      for (let i = 0; i + 1 < raw.length; i += 2) {
        if (raw[i]?.toLowerCase() === "authorization") token = raw[i + 1] ?? "";
      }
      const held = tokenOn.get(arrived.connection) ?? new Set<string>();
      held.add(token);
      tokenOn.set(arrived.connection, held);
    }

    for (const [connection, tokens] of tokenOn) {
      assert.equal(tokens.size, 1, `connection ${connection} carried ${tokens.size} different credentials`);
    }
    // Two Seats, two connections, and five requests over them.
    assert.equal(upstream.totalConnections(), 2);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("an unswapped request never shares a connection with a Seat's", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await aRelay({ upstream, charge: () => null });
  try {
    // Off: nothing is swapped and the caller's own credential travels. It must not
    // be handed a connection a Seat has been paying on.
    await ask(relay, upstream);
    assert.equal(upstream.totalConnections(), 1);

    const withASeat = await aRelay({ upstream });
    try {
      await ask(withASeat, upstream);
      assert.equal(upstream.totalConnections(), 2);
    } finally {
      await withASeat.close();
    }
  } finally {
    await relay.close();
    await upstream.close();
  }
});

// ---- the new way to fail, and why it does not -------------------------------

test("an idle connection is dropped well before a machine proxy would lose patience", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  // The real bound is five seconds against a proxy measured at about fifteen.
  // A hundred milliseconds here so the test is a test and not a wait.
  const relay = await aRelay({ upstream, idleForAtMostMs: 100 });
  try {
    await ask(relay, upstream);
    assert.equal(upstream.openConnections(), 1, "it is warm right after a request");

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(upstream.openConnections(), 0, "a connection nobody wants was still being held open");

    // And the margin is stated where it is set rather than in a comment somewhere.
    assert.equal(IDLE_FOR_AT_MOST_MS <= 5000, true);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The failure reuse would otherwise introduce, and the criterion's first branch.
 *
 * A connection the far end closed while it sat idle must never be offered to a new
 * request. Not retried, prevented: the only way to tell "the server never read it"
 * from "the server read it and then the connection died" is to guess, and guessing
 * wrong charges a Seat twice for one request.
 */
test("a connection the far end killed while idle is never offered to a new request", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const exchanges: Exchange[] = [];
  // Longer than the far end's patience, deliberately, which is the situation the
  // bound is meant to avoid. Here it is forced, so the prevention is what is tested.
  const relay = await aRelay({ upstream, idleForAtMostMs: 60_000, exchanges });
  try {
    await ask(relay, upstream);
    assert.equal(upstream.openConnections(), 1);

    // The far end hangs up on the idle connection, as a proxy does at fifteen
    // seconds. Nothing tells the relay; it finds out from the socket.
    await upstream.hangUpOnEverything();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const answer = await ask(relay, upstream);
    assert.equal(answer.status, 200, "a dead connection was handed to a live request");
    assert.equal(upstream.totalConnections(), 2, "it should have opened a fresh one");

    // And exactly one exchange per request. A retry here would be two.
    assert.equal(exchanges.length, 2);
    assert.equal(exchanges.filter((one) => one.status === 200).length, 2);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The clock is for a connection nobody is using, and a reply being thought about is
 * not that.
 *
 * The reused connection is the case that matters and it is the one this test was
 * missing at first. A fresh connection never had the idle clock on it, so putting a
 * slow reply on one proved nothing: taking the clock off on reuse could be deleted
 * outright and every test stayed green. A connection warmed first, and then asked
 * for a reply slower than the idle window, is what pins it.
 */
test("a slow reply on a reused connection is not cut short by the idle clock", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await aRelay({ upstream, idleForAtMostMs: 100 });
  try {
    // Warmed, so the next request is served on a connection that has been idle and
    // therefore had the clock on it.
    assert.equal((await ask(relay, upstream)).status, 200);
    assert.equal(upstream.openConnections(), 1);

    upstream.reply = {
      status: 200,
      parts: [
        "first",
        // Well past the idle window, and in the middle of a reply.
        () => new Promise<void>((resolve) => setTimeout(resolve, 400)),
        "second",
      ],
    };

    const answer = await ask(relay, upstream);
    assert.equal(answer.status, 200, "the idle clock fired during a reply on a reused connection");
    assert.equal(answer.body, "firstsecond");
    assert.equal(upstream.totalConnections(), 1, "and it really was the same connection");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * A connection out of the wrong door would work, which is worse than failing.
 *
 * ADR 0011: the relay leaves this machine the way the machine says it does. A
 * connection opened before a VPN came up still carries bytes perfectly well, and
 * carries them round the route the machine is now set up to take.
 */
test("a route that changed lets go of every warm connection", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const proxy = await startFakeMachineProxy({ [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } });
  const authority = await authorityFor(OPEN_HOST);

  let through: { host: string; port: number } | null = null;
  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    machineProxy: () => Promise.resolve(through),
    chargeFor: () => paying(aCharge("seat-a")),
  });

  try {
    // Straight out to begin with, and warm afterwards.
    await ask(relay, upstream);
    await ask(relay, upstream);
    assert.equal(upstream.totalConnections(), 1, "the second should have reused the first");

    // A proxy appears, as a VPN coming up does.
    through = { host: proxy.host, port: proxy.port };
    await ask(relay, upstream);

    assert.equal(upstream.totalConnections(), 2, "it kept using a connection opened out the old door");
    assert.deepEqual(proxy.asked, [`${OPEN_HOST}:443`], "and the new one went through the proxy");
  } finally {
    await relay.close();
    await proxy.close();
    await upstream.close();
  }
});

test("a caller that sends Connection: close does not close the pool's connection", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await aRelay({ upstream });
  try {
    // A proxy must not forward a header that describes the connection it arrived
    // on. Forwarding this one was why nothing could ever be reused.
    for (let one = 0; one < 3; one += 1) {
      const answer = await requestThrough({
        relay: relay.address,
        host: OPEN_HOST,
        port: 443,
        trust: upstream.authority,
        path: "/v1/messages",
        headers: [["Connection", "close"]],
        body: BODY,
      });
      assert.equal(answer.status, 200);
    }

    assert.equal(upstream.totalConnections(), 1);
    for (const arrived of upstream.seen) {
      const names = arrived.rawHeaders.filter((_, at) => at % 2 === 0).map((one) => one.toLowerCase());
      assert.equal(names.includes("proxy-connection"), false);
    }
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("closing the relay closes every warm connection, so nothing keeps the process alive", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await aRelay({ upstream, idleForAtMostMs: 60_000 });
  await ask(relay, upstream);
  assert.equal(upstream.openConnections(), 1);

  await relay.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(upstream.openConnections(), 0, "an agent holding an idle socket outlived the relay");
  await upstream.close();
});

test("a blind tunnel to another host never becomes a pooled connection", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await aRelay({ upstream });
  try {
    /**
     * Only the opened host goes through the pool. Every other host is tunnelled
     * blind, and a tunnel is not a request: nothing in it is read, so nothing about
     * it could ever be handed to somebody else as a warm connection.
     */
    const socket = connect(relay.address.port, relay.address.host);
    await once(socket, "connect");
    socket.write(`CONNECT elsewhere.example:443 HTTP/1.1\r\nHost: elsewhere.example:443\r\n\r\n`);
    const answered = await new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
      socket.once("error", () => resolve(""));
      setTimeout(() => resolve(""), 1000);
    });

    assert.match(answered, /^HTTP\/1\.1 200/);
    assert.deepEqual(upstream.seen, [], "the relay read a request out of a blind tunnel");
    socket.destroy();

    // And an opened-host request afterwards gets a connection of its own rather
    // than the tunnel's.
    assert.equal((await ask(relay, upstream)).status, 200);
    assert.equal(upstream.seen.length, 1);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * A Refusal that is thrown away must leave the connection fit to keep.
 *
 * When the rotation of ticket 15 gives up on an answer, it reads the rest of that
 * answer rather than destroying the connection: a Refusal's body is a few dozen
 * bytes, so draining it costs nothing and saves a handshake. Nothing proved that
 * until this test, and the claim was sitting in a comment. Put `giveUp()` back into
 * the drain and this fails on the connection count.
 */
test("an answer that was thrown away leaves its connection warm for the next request", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  // Refused, and nowhere to move it to, so the Refusal is thrown away by the
  // rotation asking and getting no second Seat.
  let asked = 0;
  const authority = await authorityFor(OPEN_HOST);
  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    chargeFor: () => paying(aCharge("seat-a")),
    // Once, so the first attempt is thrown away and the second is the real one.
    whenRefused: () => (asked++ === 0 ? aCharge("seat-a-again") : null),
  });

  try {
    upstream.replyTo = () => ({
      status: asked === 0 ? 429 : 200,
      headers: { "anthropic-organization-id": "org-seat-a" },
      parts: [asked === 0 ? `{"type":"error"}` : "ok"],
    });

    const answer = await ask(relay, upstream);
    assert.equal(answer.status, 200);

    // Two attempts. The second is on a Seat of its own, so it needs a connection of
    // its own; what this pins is that the first one was not destroyed, which shows
    // up as it still being warm afterwards.
    assert.equal(upstream.openConnections(), 2, "a drained answer's connection was closed instead of kept");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The trap ticket 26 names, and the one that has already been walked into.
 *
 * Node honours a bare `createConnection` only when there is no agent at all.
 * `agent: false` beside one makes it dial the host itself and go straight round the
 * machine's proxy: measured on 2026-08-22 by a relay that reached the real
 * Cloudflare in a test. Now that connections come from a pool, this is the test
 * that says the pool is still the only door.
 *
 * The negative control is the whole proof: the direct route is pointed at a dead
 * port, so a request that succeeds can only have gone through the proxy.
 */
test("every pooled connection goes out through the machine's proxy, never round it", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  // Redirects the CONNECT target to the fake upstream, so the tunnel really lands
  // somewhere and only the direct route is dead.
  const proxy = await startFakeMachineProxy({ [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } });
  const authority = await authorityFor(OPEN_HOST);

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    machineProxy: { host: "127.0.0.1", port: proxy.port },
    // Nothing is listening here. Anything that dials direct fails.
    dial: () => ({ host: "127.0.0.1", port: 1 }),
    chargeFor: () => paying(aCharge("seat-a")),
  });

  try {
    // Several, so this covers the reused connections and not only the first.
    for (let one = 0; one < 3; one += 1) {
      const answer = await ask(relay, upstream);
      assert.equal(answer.status, 200, `request ${one + 1} went round the proxy`);
    }
    assert.equal(proxy.asked.length >= 1, true, "nothing went through the machine's proxy at all");
    assert.deepEqual(proxy.asked, [`${OPEN_HOST}:443`], "and it asked for exactly one tunnel, not one per request");
    assert.equal(upstream.totalConnections(), 1, "and the connection through it was reused");
  } finally {
    await relay.close();
    await upstream.close();
    await proxy.close();
  }
});
