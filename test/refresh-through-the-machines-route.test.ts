/**
 * The background refresher leaves this machine the way the machine says, or not
 * at all.
 *
 * It did neither, until 2026-08-30. `ask` in `src/usage/internal/refresh.ts`
 * built its request with `node:https`, no agent and no proxy, and put a Seat's
 * Send token in the header, four at a time. Every other socket in this program
 * goes through `dialUpstream`, and this one had never heard of it. On a laptop
 * running a VPN in tunnel mode nothing shows, because the packets are inside the
 * tunnel at the IP layer whatever a program does; on a machine whose only way out
 * is the configured proxy, the credential went straight past it.
 *
 * The proof here is the negative control the rest of this repository uses, and it
 * is the only kind that survives Node deciding to dial a host itself: the direct
 * route is pointed at a port with nothing on it. A refresh that succeeds can only
 * have gone through the proxy. Take the dialler back out of `ask` and this file
 * goes red rather than quietly passing.
 */
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refreshStaleSeats } from "../src/usage/index.ts";
import { openUsageMemory } from "../src/usage/index.ts";
import { openSeatStore } from "../src/seats/index.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";
import { aClosedPort, startFakeMachineProxy } from "./helpers/fake-machine-proxy.ts";
import { aVaultInMemory } from "./helpers/a-vault-in-memory.ts";
import { forgetAuthorities } from "./helpers/authorities.ts";
import type { RelayNotice } from "../src/relay/index.ts";

const OPEN_HOST = "api.anthropic.com";
const NOW = 1_776_000_000;
const SEND_TOKEN = "sk-ant-oat01-work";

after(forgetAuthorities);

/** One Seat with a Send token, a usage memory, and an upstream to answer it. */
async function aBench() {
  const folder = await mkdtemp(join(tmpdir(), "relay-refresh-route-"));
  const seats = openSeatStore({ file: join(folder, "seats.json"), vault: aVaultInMemory() });
  await seats.add(
    { name: "work", account: "one@example.com", organization: { id: "org-acme", label: "Acme" }, multiplier: 20 },
    SEND_TOKEN,
  );

  const usage = openUsageMemory({ file: join(folder, "usage.json") });
  const upstream = await startFakeUpstream(OPEN_HOST);
  upstream.reply = {
    status: 200,
    headers: {
      "anthropic-organization-id": "org-acme",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-7d-utilization": "0.09",
    },
    parts: [`{"ok":true}`],
  };

  return {
    seats,
    usage,
    upstream,
    /** The authority the fake holds, so a probe can believe it is Anthropic. */
    trust: [upstream.authority],
    async forget() {
      await upstream.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test("a refresh reaches the server only through the proxy the machine names", async () => {
  const bench = await aBench();
  const proxy = await startFakeMachineProxy({
    [`${OPEN_HOST}:443`]: { host: "127.0.0.1", port: bench.upstream.port },
  });
  // The negative control. Every direct dial lands here, and nothing is listening,
  // so a probe that answers cannot have taken that way.
  const nowhere = await aClosedPort();

  try {
    const summary = await refreshStaleSeats({
      seats: bench.seats,
      usage: bench.usage,
      at: NOW,
      olderThan: 0,
      route: {
        egress: async () => ({ kind: "proxy", at: { host: proxy.host, port: proxy.port } }),
        dial: () => ({ host: "127.0.0.1", port: nowhere }),
        trust: bench.trust,
      },
    });

    assert.deepEqual(
      { asked: summary.asked, answered: summary.answered, failed: summary.failed },
      { asked: 1, answered: 1, failed: 0 },
      "it got through, so it went through the proxy",
    );
    assert.deepEqual(proxy.asked, [`${OPEN_HOST}:443`], "and the proxy is the one that was asked");

    // The Seat's own credential arrived, so the tunnel carried the exchange rather
    // than merely being opened.
    const raw = bench.upstream.seen[0]?.rawHeaders ?? [];
    const sent = raw.find((_, at) => raw[at - 1]?.toLowerCase() === "authorization");
    assert.equal(sent, `Bearer ${SEND_TOKEN}`);

    // And the round is worth making: the reply's own figures are what is known now.
    const [seat] = await bench.usage.known(NOW);
    assert.equal(seat?.seat, "work");
    assert.equal(seat?.fiveHour?.utilization, 0.42);
    assert.equal(seat?.sevenDay?.utilization, 0.09);
  } finally {
    await proxy.close();
    await bench.forget();
  }
});

/**
 * The rule itself, in the state that used to be a leak.
 *
 * The machine names a proxy and it is not listening, which is what a VPN going
 * down looks like from here. A Send token is a Seat's credential, so the answer is
 * to not send it, in the same words `dial.ts` uses for the relay. Before this, the
 * refresher did not know there was a proxy to miss.
 */
test("a dead machine proxy stops the refresh instead of sending the Send token round it", async () => {
  const bench = await aBench();
  const deadPort = await aClosedPort();
  const notices: RelayNotice[] = [];

  try {
    const summary = await refreshStaleSeats({
      seats: bench.seats,
      usage: bench.usage,
      at: NOW,
      olderThan: 0,
      route: {
        egress: async () => ({ kind: "proxy", at: { host: "127.0.0.1", port: deadPort } }),
        // Direct would work, and that is the whole danger: the fake upstream is
        // right there. Going round the machine's route must still not happen.
        dial: () => ({ host: "127.0.0.1", port: bench.upstream.port }),
        report: (notice) => notices.push(notice),
        trust: bench.trust,
      },
    });

    assert.deepEqual(
      { asked: summary.asked, answered: summary.answered, failed: summary.failed },
      { asked: 1, answered: 0, failed: 1 },
    );
    assert.equal(bench.upstream.seen.length, 0, "a Send token must not reach the server by another way");

    const reported = notices.find((one) => one.kind === "machine-proxy-unreachable");
    assert.ok(reported, `expected a notice, got ${JSON.stringify(notices)}`);
    assert.match(reported.summary, /was NOT sent/);
    assert.match(reported.summary, /Seat's credential/i, "and it says what it was protecting");

    // Nothing was learned, and nothing was invented either. A round that could not
    // ask must leave what is known exactly as old as it was.
    assert.deepEqual(await bench.usage.known(NOW), []);
  } finally {
    await bench.forget();
  }
});

/**
 * The other refusal: the machine names a way out we cannot speak at all.
 *
 * Refused for the same reason and reported through the same channel, so the two
 * cases cannot drift into disagreeing about which one is safe.
 */
test("a way out the relay cannot speak stops the refresh too", async () => {
  const bench = await aBench();
  const said: string[] = [];

  try {
    const summary = await refreshStaleSeats({
      seats: bench.seats,
      usage: bench.usage,
      at: NOW,
      olderThan: 0,
      route: {
        egress: async () => ({ kind: "refuse", why: "this machine would not say what proxy it uses" }),
        dial: () => ({ host: "127.0.0.1", port: bench.upstream.port }),
        trust: bench.trust,
      },
      say: (line) => said.push(line),
    });

    assert.equal(summary.failed, 1);
    assert.equal(bench.upstream.seen.length, 0);
    assert.ok(
      said.some((line) => /was not asked/.test(line) && /would not say what proxy/.test(line)),
      `a round that did not send must say why: ${JSON.stringify(said)}`,
    );
  } finally {
    await bench.forget();
  }
});

/**
 * A machine that names nothing still works, which is the half a rule this strict
 * is most likely to break.
 *
 * "Straight out" is the right answer when the machine itself would go straight
 * out, and a refresher that refused here would be a program that only works
 * behind a proxy.
 */
test("a machine that names no proxy is refreshed straight out, as it would have been", async () => {
  const bench = await aBench();

  try {
    const summary = await refreshStaleSeats({
      seats: bench.seats,
      usage: bench.usage,
      at: NOW,
      olderThan: 0,
      route: {
        egress: async () => ({ kind: "direct" }),
        dial: () => ({ host: "127.0.0.1", port: bench.upstream.port }),
        trust: bench.trust,
      },
    });

    assert.equal(summary.answered, 1);
    assert.equal(bench.upstream.seen.length, 1);
  } finally {
    await bench.forget();
  }
});
