/**
 * A Refusal moves the work, driven through the real relay against a fake upstream.
 *
 * Seam one, because this is the one behaviour that cannot be tested any shallower:
 * the same request has to be sent again, on a second connection, with a second
 * credential, before a byte of the first answer reaches whoever asked. Nothing here
 * asserts against a hand-built exchange.
 */
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRelay, type Exchange, type RelayNotice } from "../src/relay/index.ts";
import { openPayer, writeChoice } from "../src/payer/index.ts";
import { openSeatStore, type Multiplier, type Vault } from "../src/seats/index.ts";
import { openUsageMemory } from "../src/usage/index.ts";
import { relayHome, aWindowUnder } from "../src/home/index.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { requestThrough } from "./helpers/through-the-relay.ts";

const OPEN_HOST = "api.anthropic.com";
const MODEL = "claude-opus-5";
const NOW = 1_776_000_000;

after(forgetAuthorities);

function aVault(): Vault {
  const held = new Map<string, string>();
  return {
    put: async (name, token) => void held.set(name, token),
    get: async (name) => held.get(name) ?? null,
    forget: async (name) => void held.delete(name),
  };
}

/** A body shaped like a Code session's, or deliberately not (ADR 0005). */
const aBody = (options: { likeCode: boolean; session?: string }) =>
  JSON.stringify({
    model: MODEL,
    ...(options.likeCode ? { system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI." }] } : {}),
    metadata: { user_id: JSON.stringify({ session_id: options.session ?? "session-one" }) },
    messages: [{ role: "user", content: "do the work" }],
  });

/**
 * A fake upstream that refuses whichever credential it is told to refuse.
 *
 * Refusing by credential is what makes every assertion below about the Seat rather
 * than about the order things happened in. The first version of this decided from
 * the last request it had recorded, which is always the previous one, so it never
 * refused the request it was looking at and every test passed for the wrong
 * reason. Make the double faithful before trusting it.
 */
async function anUpstreamThatRefuses(options: { theseTokens: readonly string[] }) {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const seenTokens: string[] = [];

  const tokenIn = (rawHeaders: readonly string[]): string => {
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
      if (rawHeaders[i]?.toLowerCase() === "authorization") return (rawHeaders[i + 1] ?? "").replace(/^Bearer /, "");
    }
    return "";
  };

  upstream.replyTo = (arrived) => {
    const token = tokenIn(arrived.rawHeaders);
    seenTokens.push(token);
    const refusing = options.theseTokens.includes(token);
    return {
      status: refusing ? 429 : 200,
      headers: {
        "anthropic-organization-id": `org-${token.replace("sk-ant-oat01-", "")}`,
        ...(refusing ? {} : { "anthropic-ratelimit-unified-5h-utilization": "0.1" }),
      },
      parts: [refusing ? `{"type":"error"}` : `{"ok":true}`],
    };
  };

  return { upstream, seenTokens };
}

type Seat = { name: string; multiplier: Multiplier };

async function aBench(options: { seats: readonly Seat[]; refusing: readonly string[]; mode?: "auto" | "manual" }) {
  const folder = await mkdtemp(join(tmpdir(), "relay-rotate-"));
  const home = relayHome(aWindowUnder(folder));
  const seats = openSeatStore({ file: home.seatsFile, vault: aVault() });

  for (const seat of options.seats) {
    await seats.add(
      {
        name: seat.name,
        account: `${seat.name}@example.com`,
        organization: { id: `org-${seat.name}`, label: seat.name },
        multiplier: seat.multiplier,
      },
      `sk-ant-oat01-${seat.name}`,
    );
  }

  await writeChoice(home.choiceFile, {
    mode: options.mode ?? "auto",
    payer: options.mode === "manual" ? (options.seats[0]?.name ?? null) : null,
  });

  const usage = openUsageMemory({ file: home.usageFile });
  const problems: string[] = [];

  const payer = openPayer({
    file: home.choiceFile,
    seats,
    usage,
    now: () => NOW,
    onProblem: (line) => problems.push(line),
  });

  const fake = await anUpstreamThatRefuses({
    theseTokens: options.refusing.map((name) => `sk-ant-oat01-${name}`),
  });

  const authority = await authorityFor(OPEN_HOST);
  const exchanges: Exchange[] = [];
  const notices: RelayNotice[] = [];
  /** How many times the relay asked where to send a refused request instead. */
  let askedToMoveOn = 0;

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [fake.upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: fake.upstream.port }),
    chargeFor: (request) => payer.decide(request),
    whenRefused: (refused, request) => {
      askedToMoveOn += 1;
      return payer.insteadOf(refused, request);
    },
    onExchange: (exchange) => exchanges.push(exchange),
    onNotice: (notice) => notices.push(notice),
  });

  return {
    home,
    usage,
    payer,
    exchanges,
    notices,
    problems,
    seenTokens: fake.seenTokens,
    upstream: fake.upstream,
    askedToMoveOn: () => askedToMoveOn,
    ask: (body: string) =>
      requestThrough({
        relay: relay.address,
        host: OPEN_HOST,
        port: 443,
        trust: fake.upstream.authority,
        path: "/v1/messages",
        headers: [["Authorization", "Bearer sk-ant-oat01-the-window-account"]],
        body,
      }),
    async forget() {
      await relay.close();
      await fake.upstream.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test("a Refusal is sent again on the next best Seat, without the user acting", async () => {
  const bench = await aBench({
    seats: [{ name: "spent", multiplier: 20 }, { name: "fresh", multiplier: 6.25 }],
    refusing: ["spent"],
  });
  try {
    const answer = await bench.ask(aBody({ likeCode: true }));

    // The caller sees a success and never sees the Refusal at all, which is the
    // whole point: a spent allowance costs a moment, not an afternoon.
    assert.equal(answer.status, 200, "the caller was handed the Refusal");
    assert.match(answer.body, /"ok":true/);

    // Two exchanges: the Refusal, then the one that worked. The first is kept
    // because it is the evidence that puts that Seat on cooldown.
    assert.equal(bench.exchanges.length, 2);
    assert.equal(bench.exchanges[0]?.chargedTo?.seat, "spent");
    assert.equal(bench.exchanges[0]?.status, 429);
    assert.equal(bench.exchanges[1]?.chargedTo?.seat, "fresh");
    assert.equal(bench.exchanges[1]?.status, 200);
  } finally {
    await bench.forget();
  }
});

test("the switch is stated, naming the Seat that refused and the one that took over", async () => {
  const bench = await aBench({
    seats: [{ name: "spent", multiplier: 20 }, { name: "fresh", multiplier: 6.25 }],
    refusing: ["spent"],
  });
  try {
    await bench.ask(aBody({ likeCode: true }));

    // A Payer changing without the user asking is exactly the kind of thing they
    // have to be able to read afterwards.
    const moved = bench.notices.filter((notice) => notice.kind === "moved-on");
    assert.equal(moved.length, 1, bench.notices.map((one) => `${one.kind}: ${one.summary}`).join("\n"));
    assert.match(moved[0]?.summary ?? "", /spent answered 429/);
    assert.match(moved[0]?.summary ?? "", /sent again on "fresh"/);
  } finally {
    await bench.forget();
  }
});

test("the refusing Seat is not tried again for that model until its cooldown ends", async () => {
  const bench = await aBench({
    seats: [{ name: "spent", multiplier: 20 }, { name: "fresh", multiplier: 6.25 }],
    refusing: ["spent"],
  });
  try {
    await bench.ask(aBody({ likeCode: true, session: "one" }));

    // Recorded from the Refusal itself, and it has to be in place before the next
    // Seat is chosen or the same Seat could be chosen again.
    const known = await bench.usage.known(NOW);
    assert.deepEqual(Object.keys(known.find((one) => one.seat === "spent")?.cooldowns ?? {}), [MODEL]);

    // A brand new conversation, deciding from scratch, must not pick it either,
    // even though it is worth three times as much.
    bench.seenTokens.length = 0;
    await bench.ask(aBody({ likeCode: true, session: "two" }));
    assert.deepEqual(bench.seenTokens, ["sk-ant-oat01-fresh"], "it walked into the wall it was just refused at");
  } finally {
    await bench.forget();
  }
});

test("with every Seat spent, the request lands on the Window account with a stated reason", async () => {
  const bench = await aBench({
    seats: [{ name: "one", multiplier: 20 }, { name: "two", multiplier: 6.25 }],
    refusing: ["one", "two"],
  });
  try {
    const answer = await bench.ask(aBody({ likeCode: true }));

    // The caller gets the Refusal, because there is nowhere left to send it, and
    // the relay stops rather than walking every Seat it owns.
    assert.equal(answer.status, 429);
    assert.equal(bench.exchanges.length <= 3, true, `it sent the request ${bench.exchanges.length} times`);

    // Never silently. The spec calls this closed but never quiet.
    assert.equal(
      bench.problems.some((line) => /every Seat you own is spent or resting/.test(line)),
      true,
      bench.problems.join("\n"),
    );
  } finally {
    await bench.forget();
  }
});

/**
 * The negative control of this ticket.
 *
 * A request without the Claude Code system prompt is refused for every premium
 * model with a message that reads like an exhausted allowance, while the Seat is
 * untouched (ADR 0005). Moving that request would collect the same answer from a
 * second Seat and put a healthy one on cooldown on the way. Take the
 * `looksLikeCode` guard out of `insteadOf` and this fails on the token count.
 */
test("a Refusal we caused ourselves is passed through as-is, and blames no Seat", async () => {
  const bench = await aBench({
    seats: [{ name: "one", multiplier: 20 }, { name: "two", multiplier: 6.25 }],
    // Every token refuses, which is what a malformed request actually looks like.
    refusing: ["one", "two"],
  });
  try {
    const answer = await bench.ask(aBody({ likeCode: false }));

    assert.equal(answer.status, 429);
    assert.equal(bench.seenTokens.length, 1, "it sent our own malformed request to a second Seat");
    assert.deepEqual(await bench.usage.known(NOW), [], "it put a healthy Seat on cooldown for our own mistake");
  } finally {
    await bench.forget();
  }
});

test("in Manual the user's choice is not quietly replaced, and the Refusal stands", async () => {
  const bench = await aBench({
    seats: [{ name: "picked", multiplier: 20 }, { name: "other", multiplier: 20 }],
    refusing: ["picked"],
    mode: "manual",
  });
  try {
    const answer = await bench.ask(aBody({ likeCode: true }));

    // Story 6: a deliberate choice is not something the app gets to second-guess.
    // Moving the work is Auto's job, and in Manual the honest answer is the
    // Refusal plus a cooldown so the user can see why.
    assert.equal(answer.status, 429);
    assert.deepEqual(bench.seenTokens, ["sk-ant-oat01-picked"]);
  } finally {
    await bench.forget();
  }
});

test("a request the relay never swapped is never sent twice, whatever the server said", async () => {
  const bench = await aBench({ seats: [{ name: "one", multiplier: 20 }], refusing: ["the-window-account"] });
  try {
    await writeChoice(bench.home.choiceFile, { mode: "off", payer: null });
    const answer = await bench.ask(aBody({ likeCode: true }));

    // Off is indistinguishable from not having installed this, and that includes
    // not retrying the caller's own requests on their behalf.
    assert.equal(answer.status, 429);
    assert.deepEqual(bench.seenTokens, ["sk-ant-oat01-the-window-account"]);
    // Never even asked. Deciding where to send a request nobody was charged for
    // would be the relay retrying the caller's own request on their behalf.
    assert.equal(bench.askedToMoveOn(), 0);
  } finally {
    await bench.forget();
  }
});

test("sending again does not spend a second turn, so a rotation cannot crowd the route", async () => {
  const bench = await aBench({
    seats: [{ name: "spent", multiplier: 20 }, { name: "fresh", multiplier: 6.25 }],
    refusing: ["spent"],
  });
  try {
    // Twelve at once, every one of them refused once and moved on. The bound that
    // stands between a burst and the collapse of 2026-08-22 is per exchange, not
    // per attempt, so a rotation must not double what is in the air.
    const answers = await Promise.all(Array.from({ length: 12 }, () => bench.ask(aBody({ likeCode: true }))));

    for (const answer of answers) assert.equal(answer.status, 200);
    // Twenty-four attempts, and connections are pooled per Seat since ticket 26,
    // so this is well under one each. The number to watch is that it is nowhere
    // near twenty-four, which is what a rotation opening a connection every time
    // would look like.
    const opened = bench.upstream.totalConnections();
    assert.equal(opened <= 24, true, `twenty-four attempts over ${opened} connections`);
    assert.equal(bench.seenTokens.length, 24, "one attempt per request, and one move each");
  } finally {
    await bench.forget();
  }
});

test("one request is sent at most three times, however many Seats there are to try", async () => {
  const bench = await aBench({
    // Five Seats, every one of them refusing. Without a bound this walks the whole
    // list for every request: five upstream connections where the route collapsed
    // at eighty-six, and a caller waiting through all of them.
    seats: [
      { name: "a", multiplier: 20 },
      { name: "b", multiplier: 20 },
      { name: "c", multiplier: 20 },
      { name: "d", multiplier: 20 },
      { name: "e", multiplier: 20 },
    ],
    refusing: ["a", "b", "c", "d", "e"],
  });
  try {
    const answer = await bench.ask(aBody({ likeCode: true }));

    assert.equal(answer.status, 429);
    assert.equal(bench.seenTokens.length, 3, `it sent the request ${bench.seenTokens.length} times`);
    assert.equal(bench.exchanges.length, 3);
  } finally {
    await bench.forget();
  }
});

/**
 * A body the relay could not hold whole cannot be sent again, and must not be.
 *
 * Over the four-megabyte limit the rest of the request is still arriving from the
 * caller as a stream, and a stream cannot be replayed. Sending again anyway would
 * put a truncated request on a second Seat: a second charge, a second Refusal, and
 * an error about malformed JSON standing in for "your allowance is spent".
 *
 * This one goes round the Payer deliberately and answers "yes, move it" every
 * time. Through the Payer the guard is unreachable, because a body too long to
 * hold reads as unknown and an unknown body is never treated as Code-shaped, so
 * the Payer refuses first. That makes the relay's own guard look untested when it
 * is the one that has to hold if anything else ever answers that question.
 */
test("a request too large for the relay to hold is never sent a second time", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const authority = await authorityFor(OPEN_HOST);
  const seenTokens: string[] = [];

  upstream.replyTo = (arrived) => {
    for (let i = 0; i + 1 < arrived.rawHeaders.length; i += 2) {
      if (arrived.rawHeaders[i]?.toLowerCase() === "authorization") {
        seenTokens.push((arrived.rawHeaders[i + 1] ?? "").replace(/^Bearer /, ""));
      }
    }
    return { status: 429, headers: { "anthropic-organization-id": "org-spent" }, parts: [`{"type":"error"}`] };
  };

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    chargeFor: () => ({
      charge: { token: "sk-ant-oat01-spent", seat: "spent", organizationId: "org-spent" },
      about: { model: MODEL, looksLikeCode: true, session: "session-one" },
    }),
    // Always yes, which is what makes this a test of the relay and not of a Payer.
    whenRefused: () => ({ token: "sk-ant-oat01-fresh", seat: "fresh", organizationId: "org-fresh" }),
  });

  try {
    // Comfortably past what the relay is willing to hold.
    const filler = "x".repeat(5 * 1024 * 1024);
    const body = JSON.stringify({
      model: MODEL,
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI." }],
      messages: [{ role: "user", content: filler }],
    });

    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body,
    });

    assert.equal(answer.status, 429, "the Refusal has to reach the caller, since nothing else can be done with it");
    assert.deepEqual(seenTokens, ["sk-ant-oat01-spent"], "it replayed a body it does not have");
    assert.equal(upstream.seen[0]?.body.length, body.length, "and not one byte of it was lost on the way");
  } finally {
    await relay.close();
    await upstream.close();
  }
});
