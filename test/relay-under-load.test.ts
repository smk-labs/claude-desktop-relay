import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { once } from "node:events";

import { AT_MOST_EXCHANGES, openGate, startRelay, type RelayNotice } from "../src/relay/index.ts";
import { startCrowdedUpstream, startEchoServer } from "./helpers/fake-upstream.ts";
import { startImpatientMachineProxy } from "./helpers/fake-machine-proxy.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { readBack, requestThrough, tunnelThrough } from "./helpers/through-the-relay.ts";
import { paying } from "./helpers/a-decision.ts";

const OPEN_HOST = "api.anthropic.com";

after(forgetAuthorities);

/**
 * The shape of the collapse that took the live window down on 2026-08-22.
 *
 * Scaled down from the real numbers so it runs in a second: the live relay held
 * 86 requests at once against a proxy that hangs up after about fifteen seconds
 * of quiet. Here it is 40 requests against a proxy that waits 300ms, and an
 * upstream that can only think about two at a time. The ratios are what matter,
 * and they are the live ones: far more requests in flight than the far end can
 * work on, and a proxy with no patience for the queue that results.
 *
 * The proxy's patience is per test rather than shared, and that is the whole
 * difference between these two tests being reliable and being flaky.
 *
 * One test needs the queue to outlast the proxy and the other needs it not to, so a
 * single number has to sit between "four in flight waits about 60ms" and "forty in
 * flight waits about 1200ms". That is one order of magnitude to split, and splitting
 * it was not enough: under a full parallel suite the scheduling skew ate the margin
 * and this went red about once in three runs. Connection reuse, landing in ticket
 * 26, made it worse by changing the very dynamics being reproduced: warm connections
 * mean fewer tunnels sitting idle, so the collapse went from certain to marginal.
 *
 * Given per call, each test gets an order of magnitude of its own.
 */
const ASKED_AT_ONCE = 40;
const UPSTREAM_WORKS_ON = 2;
const UPSTREAM_THINKS_FOR = 60;

/** Far below the ~1200ms the back of an unbounded queue waits. Must collapse. */
const NO_PATIENCE = 120;
/** Far above the ~60ms a bounded tunnel waits. Must not collapse. */
const PLENTY_OF_PATIENCE = 3_000;

async function drive(options: { inFlight?: number; proxyPatienceMs: number }) {
  const upstream = await startCrowdedUpstream({
    host: OPEN_HOST,
    atOnce: UPSTREAM_WORKS_ON,
    thinkMs: UPSTREAM_THINKS_FOR,
  });
  const proxy = await startImpatientMachineProxy({
    idleMs: options.proxyPatienceMs,
    redirect: { [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: upstream.port } },
  });
  const authority = await authorityFor(OPEN_HOST);
  const notices: RelayNotice[] = [];

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    machineProxy: { host: proxy.host, port: proxy.port },
    ...(options.inFlight === undefined ? {} : { atMostInFlight: options.inFlight }),
    // Pinned to the dial bound, so these tests keep measuring the thing they were
    // written for. Since ADR 0017 the turn comes back at the head of the reply and
    // the looser bound is what caps open sockets, so leaving this at its default
    // would let 48 tunnels stand while the assertions below still said 4.
    ...(options.inFlight === undefined ? {} : { atMostExchanges: options.inFlight }),
    chargeFor: () => paying({ token: "sk-ant-oat01-seat-a", seat: "seat-a", organizationId: "org-seat-a" }),
    onNotice: (notice) => notices.push(notice),
  });

  const answers = await Promise.all(
    Array.from({ length: ASKED_AT_ONCE }, () =>
      requestThrough({
        relay: relay.address,
        host: OPEN_HOST,
        port: 443,
        trust: upstream.authority,
        path: "/v1/messages",
        body: `{"model":"claude-opus-5","messages":[{"role":"user","content":"hi"}]}`,
      }).then(
        (answer) => answer.status,
        () => 0,
      ),
    ),
  );

  await relay.close();
  await proxy.close();
  await upstream.close();

  return {
    ok: answers.filter((status) => status === 200).length,
    failed: answers.filter((status) => status !== 200).length,
    hungUpOn: proxy.hungUpOn(),
    tunnelsAtOnce: proxy.mostAtOnce(),
    upstreamConnections: upstream.totalConnections(),
    notices,
  };
}

/**
 * The bug, reproduced. Unbounded, the relay opens one tunnel per request and the
 * proxy hangs up on the ones that end up waiting, exactly as the live log shows:
 * "answered nothing: socket hang up", "closed by us: false".
 */
test("unbounded, a burst collapses: the proxy hangs up on the queue the relay created", async () => {
  const { ok, failed, hungUpOn, tunnelsAtOnce } = await drive({
    inFlight: ASKED_AT_ONCE,
    proxyPatienceMs: NO_PATIENCE,
  });

  /**
   * The disease, stated as what it actually is.
   *
   * This used to assert the peak was above half the request count, on the reasoning
   * that unbounded means one tunnel per request. Connection reuse landed in ticket
   * 26 and made that false in a way that is entirely correct: a request arriving
   * after an earlier one finished takes a warm connection instead of opening a new
   * one, so the peak is genuinely lower. Measured at 19 against a floor of 20, which
   * is the assertion being wrong rather than the relay.
   *
   * What the test is about survives that untouched: far more tunnels open at once
   * than the far end can work on, and a proxy with no patience for the queue that
   * results. Nine times the upstream's capacity, against a floor of three.
   */
  assert.ok(
    tunnelsAtOnce > UPSTREAM_WORKS_ON * 3,
    `far more tunnels than the far end can work on is the disease; saw ${tunnelsAtOnce} against ${UPSTREAM_WORKS_ON}`,
  );
  assert.ok(hungUpOn > 0, "the proxy hung up on tunnels that went quiet, which is the live failure");
  assert.ok(failed > 0, `every request should not have survived this; ok=${ok} failed=${failed}`);
});

/**
 * The fix, from the user's side: the same burst, the same impatient proxy, the
 * same slow upstream, and nothing fails.
 *
 * Nothing about the far end improved. The relay simply stopped asking for more at
 * once than the route can carry, so no request sits in a silence long enough to
 * be hung up on.
 */
test("bounded, the same burst all succeeds and the proxy never hangs up on anything", async () => {
  const { ok, failed, hungUpOn, tunnelsAtOnce, upstreamConnections } = await drive({
    inFlight: 4,
    proxyPatienceMs: PLENTY_OF_PATIENCE,
  });

  assert.equal(failed, 0, "not one request may be lost to a queue the relay made for itself");
  assert.equal(ok, ASKED_AT_ONCE);
  assert.equal(hungUpOn, 0, "nothing sat quiet long enough for the proxy to lose patience");
  /**
   * The bound being asserted is the one on open tunnels, which since ADR 0017 is
   * `atMostExchanges` rather than the gate. `drive` pins the two together for
   * exactly this reason: with only the gate set, the turn now comes back at the
   * head of the reply, tunnels would stand well past four, and this line would go
   * on passing while measuring nothing.
   */
  assert.ok(tunnelsAtOnce <= 4, `never more tunnels open than allowed, saw ${tunnelsAtOnce}`);
  // Connections are still one per request at this stage; reuse is the next step.
  // What matters here is that never more than the bound are open at any moment.
  assert.ok(upstreamConnections > 0);
});

test("the bound is never exceeded, whatever order the turns come back in", async () => {
  const gate = openGate(3);

  const turns = await Promise.all([gate.enter(), gate.enter(), gate.enter()]);
  assert.equal(gate.inFlight(), 3);

  let fourthGotIn = false;
  const fourth = gate.enter().then((turn) => {
    fourthGotIn = true;
    return turn;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fourthGotIn, false, "a fourth may not start while three are in the air");
  assert.equal(gate.waiting(), 1);

  turns[0]!();
  assert.equal(await fourth.then(() => fourthGotIn), true, "and starts the moment one finishes");
  assert.equal(gate.inFlight(), 3);
  assert.equal(gate.mostAtOnce(), 3);
});

/**
 * A turn given back twice would quietly stop the bound from being a bound, and
 * the exchange path has several ways to end that can race each other.
 */
test("a turn handed back twice does not let an extra exchange through", async () => {
  const gate = openGate(1);

  const turn = await gate.enter();
  turn();
  turn();
  turn();

  assert.equal(gate.inFlight(), 0, "three returns of one turn is still one turn");
  await gate.enter();
  assert.equal(gate.inFlight(), 1);
});

/**
 * The number that used to be one per request, kept as the place it is watched.
 *
 * A burst of twenty was twenty handshakes through the machine's proxy, which was no
 * longer enough to collapse the route but was the next thing worth removing. It is
 * removed: connections are pooled per Seat (ticket 26). This assertion is the one
 * that would notice reuse quietly stopping working, which is a thing that happens
 * the day somebody forwards a `Connection` header again.
 */
test("a burst of twenty costs a handful of connections, not twenty", async () => {
  const upstream = await startCrowdedUpstream({ host: OPEN_HOST, atOnce: 8, thinkMs: 5 });
  const authority = await authorityFor(OPEN_HOST);
  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    chargeFor: () => paying({ token: "sk-ant-oat01-seat-a", seat: "seat-a", organizationId: "org-seat-a" }),
  });
  try {
    const HOW_MANY = 20;
    await Promise.all(
      Array.from({ length: HOW_MANY }, () =>
        requestThrough({
          relay: relay.address,
          host: OPEN_HOST,
          port: 443,
          trust: upstream.authority,
          path: "/v1/messages",
          body: `{"model":"claude-opus-5","messages":[]}`,
        }),
      ),
    );

    assert.equal(upstream.answered(), HOW_MANY);
    const opened = upstream.totalConnections();
    /**
     * The floor is however many may be open at once, which since ADR 0017 is the
     * exchange bound and not the gate: the gate hands its turn back at the head of
     * the reply, so it no longer decides how many sockets stand together.
     *
     * The claim is unchanged and it is about reuse: twenty requests must not cost
     * twenty connections. The number it is measured against is now read from the
     * relay's own bound rather than written out as twelve, so it cannot drift into
     * asserting something nobody meant.
     */
    const mayStandTogether = Math.min(AT_MOST_EXCHANGES, HOW_MANY);
    assert.ok(
      opened <= mayStandTogether + 2,
      `${HOW_MANY} requests over ${opened} connections, when at most ${mayStandTogether} may stand together`,
    );
    assert.ok(opened < HOW_MANY, `${opened} connections for ${HOW_MANY} requests is no reuse at all`);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * A turn is the scarce thing now, so it may not be spent on work nobody wants.
 *
 * A Code session cancels requests it no longer needs constantly. If a cancelled
 * request still takes a turn and opens a tunnel, a burst of cancellations starves
 * the requests that are still wanted.
 */
test("a caller that gives up while queued never has a tunnel opened for it", async () => {
  const upstream = await startCrowdedUpstream({ host: OPEN_HOST, atOnce: 1, thinkMs: 250 });
  const authority = await authorityFor(OPEN_HOST);
  const notices: RelayNotice[] = [];
  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    atMostInFlight: 1,
    chargeFor: () => paying({ token: "sk-ant-oat01-seat-a", seat: "seat-a", organizationId: "org-seat-a" }),
    onNotice: (notice) => notices.push(notice),
  });

  try {
    // One request holds the only turn while three more queue behind it and are
    // then abandoned.
    const held = requestThrough({
      relay: relay.address, host: OPEN_HOST, port: 443, trust: upstream.authority,
      path: "/v1/messages", body: `{"model":"m","messages":[]}`,
    });

    const abandoned = Array.from({ length: 3 }, () =>
      requestThrough({
        relay: relay.address, host: OPEN_HOST, port: 443, trust: upstream.authority,
        path: "/v1/messages?giving-up=yes", body: `{"model":"m","messages":[]}`,
        hangUpAfterMs: 40,
      }).then(() => "answered", () => "gave up"),
    );

    await Promise.all([held, ...abandoned]);
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(upstream.answered(), 1, "only the request somebody was still waiting for was ever sent");
    assert.ok(
      notices.some((notice) => notice.kind === "caller-went-away" && /while it was queued/.test(notice.summary)),
      "and giving up while queued is said out loud rather than swallowed",
    );
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The hang, and the reason a whole Window looked frozen on 2026-08-23.
 *
 * A proxy that accepts and then goes silent is not refused, not unreachable and
 * not slow. Nothing in the dial had a clock, so every tunnel waiting on it waited
 * for ever. Ten MCP servers inherit the relay's address from the app's own
 * environment store, so all of them stopped at once, and neither `relay off` nor
 * `relay uninstall` could help: the app had already cached the address and only
 * a restart could change it.
 *
 * Put the clock back the way it was and this test never finishes, which is the
 * point of it.
 */
test("a proxy that accepts and then says nothing does not hang the tunnel for ever", async () => {
  const { startSilentMachineProxy } = await import("./helpers/fake-machine-proxy.ts");
  const echo = await startEchoServer();
  const silent = await startSilentMachineProxy();
  const authority = await authorityFor(OPEN_HOST);

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    machineProxy: { host: silent.host, port: silent.port },
    // A second is plenty to prove there is a clock at all.
    proxyHasThisLong: 1_000,
    dial: () => ({ host: "127.0.0.1", port: echo.port }),
  });

  try {
    const began = performance.now();
    const socket = await tunnelThrough(relay.address, "somewhere.else:443");

    // Nobody's credential is travelling, so a silent proxy must not stop the
    // work: it falls back and the tunnel opens anyway.
    socket.write("hello");
    const back = await readBack(socket, 5);
    const took = performance.now() - began;
    socket.destroy();

    assert.equal(back, "hello", "the tunnel must open by another way rather than wait for ever");
    assert.ok(took < 8_000, `it must give up on the silent proxy quickly, took ${Math.round(took)}ms`);
    assert.ok(silent.asked() > 0, "and it must really have tried the proxy first");
  } finally {
    await relay.close();
    await silent.close();
    await echo.close();
  }
});

/**
 * What the split is for: a reply that takes its time no longer costs a turn.
 *
 * Holding the turn until the last byte made the relay's throughput the bound
 * divided by how long a reply takes. On this traffic that was twelve over about
 * thirty seconds, or roughly 1,400 requests an hour, and six days of the relay's
 * own log show it sitting on exactly that ceiling: every busy hour inside a band
 * of 31 to 38 seconds a turn, with 14.3% of all requests dying in the queue.
 *
 * The turn now comes back at the head of the reply, because everything the turn
 * protects against has already happened by then. This is that claim as an
 * experiment: with only two turns, eight replies that each dawdle must overlap
 * rather than queue. Under the old shape they could not, and this test would take
 * four holds instead of one.
 */
test("a reply that takes its time holds a socket, not a turn", async () => {
  const { createServer: createTlsServer } = await import("node:tls");
  const authority = await authorityFor(OPEN_HOST);

  const HOLD_MS = 400;
  const ASKED = 8;
  const TURNS = 2;

  // Head at once, body later. The head is the moment the turn should come back.
  const upstream = createTlsServer({ key: authority.leaf.key, cert: authority.leaf.cert }, (socket) => {
    socket.on("data", () => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n");
      setTimeout(() => socket.end("ok"), HOLD_MS);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [authority.caCertificate],
    dial: () => ({ host: "127.0.0.1", port: upstreamPort }),
    atMostInFlight: TURNS,
    atMostExchanges: ASKED * 2,
    chargeFor: () => paying({ token: "sk-ant-oat01-seat-a", seat: "seat-a", organizationId: "org-seat-a" }),
  });

  try {
    const began = Date.now();
    await Promise.all(
      Array.from({ length: ASKED }, () =>
        requestThrough({
          relay: relay.address,
          host: OPEN_HOST,
          port: 443,
          trust: authority.caCertificate,
          path: "/v1/messages",
          body: `{"model":"claude-opus-5","messages":[]}`,
        }),
      ),
    );
    const took = Date.now() - began;

    /**
     * Two holds, which is one for the work and one for headroom.
     *
     * Sized against both outcomes rather than against the good one alone: with
     * the turn released at the head this measures about one hold, and with the
     * turn held to the last byte it measures three or more. A bound at four holds
     * is arithmetically correct and catches nothing, which was the first version
     * of this line.
     */
    const TWO_HOLDS = HOLD_MS * 2;
    assert.ok(
      took < TWO_HOLDS,
      `${ASKED} replies each held ${HOLD_MS}ms took ${took}ms; over ${TWO_HOLDS}ms means turns are being held past the head`,
    );
  } finally {
    await relay.close();
    await new Promise((done) => upstream.close(() => done(null)));
  }
});
