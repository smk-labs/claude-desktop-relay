/**
 * The whole chain, at seam one: a real request through the real relay, decided by
 * the real Payer, answered by a fake upstream, remembered by the real memory.
 *
 * It exists because the memory's own tests hand it exchanges built by hand, and
 * three of the four wrong theories of 2026-08-22 came from a fake that was wrong
 * rather than from the relay. Nothing here asserts against a fixture: the model
 * name and the Claude Code system prompt travel from a body written in this file,
 * through the relay, into what is known about a Seat.
 */
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRelay } from "../src/relay/index.ts";
import { openPayer, writeChoice } from "../src/payer/index.ts";
import { openSeatStore } from "../src/seats/index.ts";
import { openUsageMemory } from "../src/usage/index.ts";
import { openHistory } from "../src/history/index.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { requestThrough } from "./helpers/through-the-relay.ts";
import type { Vault } from "../src/seats/index.ts";
import type { SeatUsage } from "../src/usage/index.ts";

const OPEN_HOST = "api.anthropic.com";
const MODEL = "claude-opus-5";
const NOW = 1_776_000_000;

after(forgetAuthorities);

/** The Keychain is never reached in a test, so the vault is a map. */
function aVault(): Vault {
  const held = new Map<string, string>();
  return {
    put: async (name, token) => void held.set(name, token),
    get: async (name) => held.get(name) ?? null,
    forget: async (name) => void held.delete(name),
  };
}

/**
 * A body shaped exactly as a Code session's, or deliberately not.
 *
 * The system prompt is the whole difference between a Refusal that is evidence
 * about a Seat and one that is evidence about our own request (ADR 0005), and it
 * is a property of these bytes rather than of a flag anyone sets.
 */
const A_PASSPHRASE = "correct-horse-battery-staple";

const aBody = (options: { likeCode: boolean }) =>
  JSON.stringify({
    model: MODEL,
    ...(options.likeCode ? { system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI." }] } : {}),
    metadata: { user_id: JSON.stringify({ session_id: "session-one" }) },
    messages: [{ role: "user", content: `a sentence nothing here is allowed to keep: ${A_PASSPHRASE}` }],
  });

async function aBench() {
  const folder = await mkdtemp(join(tmpdir(), "relay-usage-chain-"));
  const seats = openSeatStore({ file: join(folder, "seats.json"), vault: aVault() });
  await seats.add(
    { name: "work", account: "one@example.com", organization: { id: "org-acme", label: "Acme" }, multiplier: 20 },
    "sk-ant-oat01-work",
  );
  const choiceFile = join(folder, "choice.json");
  await writeChoice(choiceFile, { mode: "manual", payer: "work" });

  const payer = openPayer({ file: choiceFile, seats });
  const memory = openUsageMemory({ file: join(folder, "usage.json") });
  const upstream = await startFakeUpstream(OPEN_HOST);
  const authority = await authorityFor(OPEN_HOST);

  // Declared before the relay can call it, rather than hoisted into a closure.
  let settled: Promise<void> = Promise.resolve();

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    chargeFor: (request) => payer.decide(request),
    // Awaited through a promise the test can wait on, because in the relay this
    // is deliberately not awaited and a test must not race it.
    onExchange: (exchange) => void (settled = memory.rememberExchange(exchange, NOW)),
  });

  return {
    memory,
    upstream,
    usageFile: join(folder, "usage.json"),
    async ask(body: string) {
      await requestThrough({
        relay: relay.address,
        host: OPEN_HOST,
        port: 443,
        trust: upstream.authority,
        path: "/v1/messages",
        headers: [["Authorization", "Bearer sk-ant-oat01-the-window-account"]],
        body,
      });
      await settled;
    },
    known: async (at = NOW): Promise<SeatUsage | undefined> => (await memory.known(at))[0],
    async forget() {
      await relay.close();
      await upstream.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test("what the reply said about the Seat is known, having travelled the whole chain", async () => {
  const bench = await aBench();
  try {
    bench.upstream.reply = {
      status: 200,
      headers: {
        "anthropic-organization-id": "org-acme",
        "anthropic-ratelimit-unified-5h-utilization": "0.42",
        "anthropic-ratelimit-unified-7d-utilization": "0.09",
        "anthropic-ratelimit-unified-5h-reset": String(NOW + 3600),
      },
      parts: [`{"ok":true}`],
    };

    await bench.ask(aBody({ likeCode: true }));

    const seat = await bench.known();
    assert.equal(seat?.seat, "work");
    assert.equal(seat?.fiveHour?.utilization, 0.42);
    assert.equal(seat?.fiveHour?.resetsAt, NOW + 3600);
    assert.equal(seat?.sevenDay?.utilization, 0.09);

    // Story 34: a record of spending must not become a record of the work. The
    // guarantee is structural, since the only two things carried off a body are a
    // model name and a yes-or-no, but the file is the artifact that outlives the
    // process and it is cheap to read it back.
    const written = await readFile(bench.usageFile, "utf8");
    assert.equal(written.includes(A_PASSPHRASE), false, "a prompt reached the record of what was spent");
    assert.equal(written.includes("session-one"), false, "and neither should a session id");
  } finally {
    await bench.forget();
  }
});

test("a Refusal on a real Code request puts the Seat on cooldown for the model it asked for", async () => {
  const bench = await aBench();
  try {
    bench.upstream.reply = {
      status: 429,
      headers: { "anthropic-organization-id": "org-acme" },
      parts: [`{"type":"error"}`],
    };

    await bench.ask(aBody({ likeCode: true }));

    const seat = await bench.known();
    // The model came out of the body written above, through the Payer, onto the
    // exchange. Nothing in this test names it twice.
    assert.deepEqual(Object.keys(seat?.cooldowns ?? {}), [MODEL]);
  } finally {
    await bench.forget();
  }
});

/**
 * The negative control, and the reason this file exists.
 *
 * The same Seat, the same model, the same 429. The only difference is that the
 * body does not carry the Claude Code system prompt, which is measured to draw a
 * Refusal that reads like an exhausted allowance from a Seat that is untouched.
 * Take the `looksLikeCode` guard out of `refusalIsAboutTheSeat` and this is the
 * test that goes red.
 */
test("the same Refusal, on a request missing the Claude Code system prompt, leaves the Seat alone", async () => {
  const bench = await aBench();
  try {
    bench.upstream.reply = {
      status: 429,
      headers: { "anthropic-organization-id": "org-acme" },
      parts: [`{"type":"error"}`],
    };

    await bench.ask(aBody({ likeCode: false }));

    const seat = await bench.known();
    assert.deepEqual(seat?.cooldowns ?? {}, {}, "a Refusal we caused ourselves must not retire a healthy Seat");
  } finally {
    await bench.forget();
  }
});

/**
 * A history row, all the way through the real relay.
 *
 * The counts come off the reply body, which is the one thing the relay pipes rather
 * than inspects, so this is where a scanner that stole a chunk or a hook that fired
 * at the wrong moment would show up. Nothing here asserts against a fixture: the
 * numbers are written into a fake reply and read out of a file on disk.
 */
test("what an exchange cost reaches a history row, and the reply arrives untouched", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-history-chain-"));
  const upstream = await startFakeUpstream(OPEN_HOST);
  const authority = await authorityFor(OPEN_HOST);
  const history = openHistory({ file: join(folder, "history.jsonl") });

  const reply = [
    `event: message_start\n`,
    `data: {"type":"message_start","message":{"usage":{"input_tokens":1234,"cache_read_input_tokens":9000,"output_tokens":1}}}\n\n`,
    `event: content_block_delta\n`,
    `data: {"type":"content_block_delta","delta":{"text":"${A_PASSPHRASE}"}}\n\n`,
    `event: message_delta\n`,
    `data: {"type":"message_delta","usage":{"output_tokens":567}}\n\n`,
  ];
  upstream.reply = {
    status: 200,
    headers: { "anthropic-organization-id": "org-acme", "anthropic-ratelimit-unified-5h-utilization": "0.3" },
    parts: reply,
  };

  let kept: Promise<void> = Promise.resolve();
  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    chargeFor: () => ({
      charge: { token: "sk-ant-oat01-work", seat: "work", organizationId: "org-acme" },
      about: { model: "claude-opus-5", looksLikeCode: true, session: "session-one" },
    }),
    onExchangeFinished: (exchange, tokens) => {
      kept = history.keep({
        at: NOW,
        seat: exchange.chargedTo?.seat ?? "",
        organizationId: exchange.paidBy,
        model: exchange.about.model,
        status: exchange.status,
        refused: exchange.refused,
        tokens,
        utilization: exchange.utilization,
        project: null,
        session: exchange.about.session,
      });
    },
  });

  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body: aBody({ likeCode: true }),
    });

    // The reply reaches the caller byte for byte. The scanner watches; it does not
    // sit in the pipe, and this is what says so.
    assert.equal(answer.body, reply.join(""));
    await kept;

    const [row] = await history.since(0);
    assert.deepEqual(row?.tokens, { input: 1234, output: 567, cacheWritten: 0, cacheRead: 9000 });
    assert.equal(row?.model, "claude-opus-5");
    assert.equal(row?.session, "session-one");
    assert.equal(row?.utilization.fiveHour, 0.3);

    // And the record of what was spent is not a record of the work.
    const written = await readFile(join(folder, "history.jsonl"), "utf8");
    assert.equal(written.includes(A_PASSPHRASE), false, "a word of the reply reached the record of spending");
  } finally {
    await relay.close();
    await upstream.close();
    await rm(folder, { recursive: true, force: true });
  }
});
