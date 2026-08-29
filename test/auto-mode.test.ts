/**
 * Auto mode, driven through the Payer's own interface with a request in hand.
 *
 * The property that matters most here used to be a negative one: nothing switched
 * the Payer mid-conversation. That hold was unshipped on 2026-08-23, so these
 * assert the opposite of what they once did. A Payer change is visible on the very
 * next request of a conversation already in flight, and the cost of it, a history
 * re-sent uncached to the new Organization, is reported after the fact.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openPayer, readStanding, writeChoice, writeStanding } from "../src/payer/index.ts";
import { openSeatStore, type Multiplier, type Vault } from "../src/seats/index.ts";
import { openUsageMemory } from "../src/usage/index.ts";
import { relayHome, aWindowUnder } from "../src/home/index.ts";
import type { RequestShape } from "../src/relay/index.ts";

const NOON = 1_776_000_000;
const OPUS = "claude-opus-5";

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
 * One request, shaped the way a Code session shapes them.
 *
 * `messages` is how deep into a conversation it is and `session` is the id the CLI
 * puts in its own metadata. Both come off the body and nowhere else, which is what
 * makes this a real request rather than a flag.
 */
function aRequest(options: { session?: string | null; messages?: number; model?: string }): RequestShape {
  const body = JSON.stringify({
    model: options.model ?? OPUS,
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI." }],
    ...(options.session === null || options.session === undefined
      ? {}
      : { metadata: { user_id: JSON.stringify({ session_id: options.session }) } }),
    messages: Array.from({ length: options.messages ?? 1 }, () => ({ role: "user", content: "hello" })),
  });
  return { method: "POST", path: "/v1/messages", body: Buffer.from(body) };
}

async function aBench(options: { seats: ReadonlyArray<[string, Multiplier]> }) {
  const folder = await mkdtemp(join(tmpdir(), "relay-auto-"));
  const home = relayHome(aWindowUnder(folder));
  const seats = openSeatStore({ file: home.seatsFile, vault: aVault() });

  for (const [name, multiplier] of options.seats) {
    await seats.add(
      {
        name,
        account: `${name}@example.com`,
        organization: { id: `org-${name}`, label: name },
        multiplier,
      },
      `sk-ant-oat01-${name}`,
    );
  }

  const usage = openUsageMemory({ file: home.usageFile });
  await writeChoice(home.choiceFile, { mode: "auto", payer: null });

  const problems: string[] = [];
  const switches: string[] = [];
  let now = NOON;

  const payer = openPayer({
    file: home.choiceFile,
    seats,
    usage,
    now: () => now,
    onProblem: (line) => problems.push(line),
    onSwitch: (pick, recached) => switches.push(`${pick.seat ?? "the Window account"} (${recached} re-cached)`),
  });

  return {
    home,
    seats,
    usage,
    payer,
    problems,
    switches,
    at: (seconds: number) => {
      now = seconds;
    },
    /** The Seat charged for one request, or null for the Window account. */
    charged: async (request: RequestShape) => (await payer.decide(request)).charge?.seat ?? null,
    forget: () => rm(folder, { recursive: true, force: true }),
  };
}

test("the Payer moves mid-conversation the moment the figures say another Seat is better", async () => {
  const bench = await aBench({ seats: [["big", 20], ["small", 1.25]] });
  try {
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 1 })), "big");

    // "big" is now nearly out of its week while "small" is untouched.
    await bench.usage.rememberReading(
      "big",
      { readVia: "stats-login", fiveHour: { utilization: 0.99, resetsAt: null }, sevenDay: { utilization: 0.99, resetsAt: null } },
      NOON,
    );

    // The very next request of the conversation already in flight is charged to
    // the new Seat. That re-sends its history uncached, and it is what was asked
    // for: one Payer for the machine, in force now.
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 4 })), "small");
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 9 })), "small");

    // Said once, when it moved, with what the move cost.
    assert.deepEqual(bench.switches, ["big (1 re-cached)", "small (1 re-cached)"]);
  } finally {
    await bench.forget();
  }
});

test("two conversations running at once share one Payer, and both move together", async () => {
  const bench = await aBench({ seats: [["one", 20], ["two", 20]] });
  try {
    assert.equal(await bench.charged(aRequest({ session: "a", messages: 1 })), "one");

    // A session and the subagent it started are two conversations in one process.
    // There is one Payer for the machine, so they are charged to the same Seat.
    await bench.usage.rememberReading(
      "one",
      { readVia: "stats-login", fiveHour: { utilization: 0.9, resetsAt: null }, sevenDay: null },
      NOON,
    );
    assert.equal(await bench.charged(aRequest({ session: "b", messages: 1 })), "two");
    assert.equal(await bench.charged(aRequest({ session: "a", messages: 3 })), "two");

    // And the count of what a switch re-caches is the conversations in flight.
    assert.deepEqual(bench.switches, ["one (1 re-cached)", "two (2 re-cached)"]);
  } finally {
    await bench.forget();
  }
});

test("over a long session the Payer follows the figures, and is said once per change", async () => {
  const bench = await aBench({ seats: [["chosen", 6.25], ["tempting", 20]] });
  try {
    // "chosen" wins the first decision because "tempting" is nearly spent.
    await bench.usage.rememberReading(
      "tempting",
      { readVia: "stats-login", fiveHour: { utilization: 0.98, resetsAt: null }, sevenDay: { utilization: 0.98, resetsAt: null } },
      NOON,
    );
    assert.equal(await bench.charged(aRequest({ session: "long", messages: 1 })), "chosen");

    // Now "tempting" resets completely and time passes. The next request of the
    // same conversation is already on it, and stays there.
    await bench.usage.rememberReading(
      "tempting",
      { readVia: "stats-login", fiveHour: { utilization: 0, resetsAt: null }, sevenDay: { utilization: 0, resetsAt: null } },
      NOON + 60,
    );

    for (let request = 2; request <= 31; request += 1) {
      bench.at(NOON + request * 60);
      assert.equal(
        await bench.charged(aRequest({ session: "long", messages: request })),
        "tempting",
        `it did not move at request ${request}`,
      );
    }

    // Weighed thirty-one times, said twice: once per change and never per request.
    assert.deepEqual(bench.switches, ["chosen (1 re-cached)", "tempting (1 re-cached)"]);
  } finally {
    await bench.forget();
  }
});

test("switching to Manual mid-conversation is honoured immediately, because the user asked", async () => {
  const bench = await aBench({ seats: [["big", 20], ["small", 1.25]] });
  try {
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 1 })), "big");

    // Story 6: a deliberate choice is not something the app gets to second-guess,
    // and holding a conversation is a rule about what the app does on its own.
    await writeChoice(bench.home.choiceFile, { mode: "manual", payer: "small" });
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 3 })), "small");

    // And back to Auto, which weighs them again and lands on the bigger Seat.
    await writeChoice(bench.home.choiceFile, { mode: "auto", payer: "small" });
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 5 })), "big");
  } finally {
    await bench.forget();
  }
});

test("Off in Auto's clothing is still Off: the choice file is read every request", async () => {
  const bench = await aBench({ seats: [["big", 20]] });
  try {
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 1 })), "big");
    await writeChoice(bench.home.choiceFile, { mode: "off", payer: "big" });
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 3 })), null);
  } finally {
    await bench.forget();
  }
});

test("a request with no session id is weighed like any other", async () => {
  const bench = await aBench({ seats: [["big", 20], ["small", 1.25]] });
  try {
    // A body with no session id can say "this is a first request" but not whose.
    // That mattered while the Payer was held per conversation. It no longer is.
    assert.equal(await bench.charged(aRequest({ session: null, messages: 1 })), "big");

    await bench.usage.rememberReading(
      "big",
      // Nearly out of its five-hour window with the whole window still ahead: a
      // lockout is coming, and that is the deepest pace penalty the rule has.
      { readVia: "stats-login", fiveHour: { utilization: 0.99, resetsAt: NOON + 5 * 3600 }, sevenDay: null },
      NOON,
    );

    assert.equal(await bench.charged(aRequest({ session: null, messages: 4 })), "small");
  } finally {
    await bench.forget();
  }
});

test("a body nobody could read is charged to the Payer of the moment, like anything else", async () => {
  const bench = await aBench({ seats: [["big", 20], ["small", 1.25]] });
  try {
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 1 })), "big");

    await bench.usage.rememberReading(
      "big",
      // Nearly out of its five-hour window with the whole window still ahead: a
      // lockout is coming, and that is the deepest pace penalty the rule has.
      { readVia: "stats-login", fiveHour: { utilization: 0.99, resetsAt: NOON + 5 * 3600 }, sevenDay: null },
      NOON,
    );

    // A body over the relay's four-megabyte limit arrives as null, which reads as
    // unknown and never as an empty body. It cannot be placed in a conversation,
    // and nothing needs it to be: there is one Payer and it is weighed from the
    // figures, which now say "small".
    const unreadable = await bench.payer.decide({ method: "POST", path: "/v1/messages", body: null });
    assert.equal(unreadable.charge?.seat, "small");

    assert.equal(await bench.charged(aRequest({ session: "one", messages: 6 })), "small");
  } finally {
    await bench.forget();
  }
});

test("with no Seat able to pay, Auto lands on the Window account and says so", async () => {
  const bench = await aBench({ seats: [["free", 0]] });
  try {
    assert.equal(await bench.charged(aRequest({ session: "one", messages: 1 })), null);
    assert.equal(bench.problems.length, 1, "falling back to the Window account may never be silent");
    assert.match(bench.problems[0] ?? "", /no Seat you own can pay/);
  } finally {
    await bench.forget();
  }
});

test("what is paying crosses to another process, and goes stale rather than lying", async () => {
  const bench = await aBench({ seats: [["big", 20], ["small", 1.25]] });
  try {
    bench.at(NOON + 30);
    await bench.charged(aRequest({ session: "a", messages: 1 }));

    // The relay decides and holds it in memory; the command a person types is a
    // different process. So it goes to disk and is read from there.
    await writeStanding(bench.home.standingFile, bench.payer.standing());
    assert.equal((await readStanding(bench.home.standingFile, NOON + 30))?.seat, "big");

    // Half a day later nothing has asked, so naming a Payer would be naming one
    // for work that is not happening.
    assert.equal(await readStanding(bench.home.standingFile, NOON + 13 * 3600), null);
  } finally {
    await bench.forget();
  }
});
