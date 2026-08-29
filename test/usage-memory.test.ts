/**
 * What is known about each Seat's allowance, driven through the module's own
 * interface.
 *
 * Every moment here is an argument, so nothing waits and nothing is flaky. The
 * tests that matter most are the three that assert nothing was learned: a figure
 * written against the wrong Seat is invisible until a ranking decision is made on
 * it, where a figure that is missing announces itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COOLDOWN_SECONDS, onCooldown, openUsageMemory } from "../src/usage/index.ts";
import { readJsonFile } from "../src/json-file/index.ts";
import type { Exchange } from "../src/relay/index.ts";
import type { SeatUsage } from "../src/usage/index.ts";

/** A fixed moment, so every assertion below is arithmetic rather than a race. */
const NOON = 1_776_000_000;

async function aFile(): Promise<{ file: string; forget: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), "relay-usage-"));
  return { file: join(folder, "usage.json"), forget: () => rm(folder, { recursive: true, force: true }) };
}

function anExchange(over: Partial<Exchange> = {}): Exchange {
  return {
    method: "POST",
    path: "/v1/messages",
    status: 200,
    refused: false,
    swapped: true,
    chargedTo: { seat: "work", organizationId: "org-acme" },
    paidBy: "org-acme",
    about: { model: "claude-sonnet-5", looksLikeCode: true, session: "session-one" },
    utilization: { fiveHour: 0.4, sevenDay: 0.1 },
    overage: { status: null, disabledReason: null },
    resets: { fiveHour: NOON + 3600, sevenDay: NOON + 86_400 },
    replyHeaders: {},
    ...over,
  };
}

const only = (known: readonly SeatUsage[]): SeatUsage => {
  assert.equal(known.length, 1, `expected one Seat, got ${known.map((one) => one.seat).join(", ") || "none"}`);
  return known[0]!;
};

test("both Utilizations and both reset times are kept per Seat, from the reply alone", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberExchange(anExchange(), NOON);

    const seat = only(await memory.known(NOON));
    assert.equal(seat.seat, "work");
    assert.equal(seat.fiveHour?.utilization, 0.4);
    assert.equal(seat.fiveHour?.resetsAt, NOON + 3600);
    assert.equal(seat.sevenDay?.utilization, 0.1);
    assert.equal(seat.sevenDay?.resetsAt, NOON + 86_400);
    // Where it came from, because a reply and a reading on the side are not the
    // same quantity even when they are the same number.
    assert.equal(seat.fiveHour?.readVia, "exchange");
  } finally {
    await forget();
  }
});

test("a reply that names no figure leaves the last one alone rather than blanking it", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberExchange(anExchange(), NOON);
    await memory.rememberExchange(
      anExchange({ utilization: { fiveHour: null, sevenDay: null }, resets: { fiveHour: null, sevenDay: null } }),
      NOON + 60,
    );

    const seat = only(await memory.known(NOON + 60));
    assert.equal(seat.fiveHour?.utilization, 0.4, "a silent reply is not a reading of zero");
    assert.equal(seat.fiveHour?.readAt, NOON, "and it must not pretend to be fresh either");
  } finally {
    await forget();
  }
});

test("a Refusal puts that Seat and that model on cooldown, and the cooldown expires", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    // No reset time named, so the flat period is what applies. A 429 that does
    // name one is the test below, and it is believed instead.
    await memory.rememberExchange(
      anExchange({ status: 429, refused: true, resets: { fiveHour: null, sevenDay: null } }),
      NOON,
    );

    const cooling = only(await memory.known(NOON + 60));
    assert.deepEqual(Object.keys(cooling.cooldowns), ["claude-sonnet-5"]);
    assert.equal(onCooldown(cooling, "claude-sonnet-5", NOON + 60), true);
    assert.equal(onCooldown(cooling, "claude-opus-5", NOON + 60), false, "one model refusing is not every model");

    // The whole point of a cooldown rather than a Seat being retired: ADR 0005.
    const later = only(await memory.known(NOON + COOLDOWN_SECONDS + 1));
    assert.deepEqual(later.cooldowns, {});
    assert.equal(onCooldown(later, "claude-sonnet-5", NOON + COOLDOWN_SECONDS + 1), false);
  } finally {
    await forget();
  }
});

test("a 429 that names when the window turns over is believed over the flat period", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    // Well past the flat ten minutes, so believing the header is visible.
    await memory.rememberExchange(
      anExchange({ status: 429, refused: true, resets: { fiveHour: NOON + 7200, sevenDay: null } }),
      NOON,
    );

    const seat = only(await memory.known(NOON));
    assert.equal(seat.cooldowns["claude-sonnet-5"], NOON + 7200);
  } finally {
    await forget();
  }
});

test("a Refusal on a request that was not shaped like Code leaves the Seat untouched", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    // Measured behaviour, ADR 0005: a request without the Claude Code system
    // prompt is refused for every premium model with what reads like an
    // exhausted allowance, while the Seat is untouched. Treating that as
    // evidence retires a healthy Seat on a request we malformed ourselves.
    await memory.rememberExchange(
      anExchange({ status: 429, refused: true, about: { model: "claude-sonnet-5", looksLikeCode: false, session: "session-one" } }),
      NOON,
    );

    const seat = only(await memory.known(NOON));
    assert.deepEqual(seat.cooldowns, {}, "our own malformed request must not retire a Seat");
    assert.equal(seat.fiveHour?.utilization, 0.4, "what the reply did say is still worth keeping");
  } finally {
    await forget();
  }
});

test("a Refusal the reply's own figures explain is about the Seat, whatever our request looked like", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    // The other half of ADR 0005. That Refusal comes back with the Seat
    // untouched, so a five-hour window the server itself puts past its whole
    // cannot be it. Measured on 2026-08-26: eight 429s carrying 1.02 set no
    // cooldown and moved no work, because each failed the shape test alone.
    await memory.rememberExchange(
      anExchange({
        status: 429,
        refused: true,
        about: { model: "claude-opus-5", looksLikeCode: false, session: "session-one" },
        utilization: { fiveHour: 1.02, sevenDay: 0.32 },
        resets: { fiveHour: NOON + 5400, sevenDay: NOON + 86_400 },
      }),
      NOON,
    );

    const seat = only(await memory.known(NOON));
    assert.equal(seat.cooldowns["claude-opus-5"], NOON + 5400, "back when the window the server named turns over");
    assert.equal(onCooldown(seat, "claude-opus-5", NOON), true);
  } finally {
    await forget();
  }
});

test("a Refusal that names no model puts nothing on cooldown, because there is nothing to avoid", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberExchange(
      anExchange({ status: 429, refused: true, about: { model: null, looksLikeCode: true, session: "session-one" } }),
      NOON,
    );

    assert.deepEqual(only(await memory.known(NOON)).cooldowns, {});
  } finally {
    await forget();
  }
});

test("a window whose reset time has passed reads as reset, not as still spent", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberExchange(anExchange({ utilization: { fiveHour: 0.98, sevenDay: 0.3 } }), NOON);

    const before = only(await memory.known(NOON + 3599));
    assert.equal(before.fiveHour?.utilization, 0.98);
    assert.equal(before.fiveHour?.hasReset, false);

    // One second past the moment the server named. This is story 8: capacity
    // about to reset unused is the capacity worth spending, and a Chooser told
    // this Seat is 98% spent would skip the one Seat that is now empty.
    const after = only(await memory.known(NOON + 3601));
    assert.equal(after.fiveHour?.hasReset, true);
    assert.equal(after.fiveHour?.utilization, 0, "it describes a window that no longer exists");
    assert.equal(after.sevenDay?.hasReset, false, "the two windows run independently");
    assert.equal(after.sevenDay?.utilization, 0.3);
  } finally {
    await forget();
  }
});

test("what is known survives a restart, and says how old it is rather than passing as current", async () => {
  const { file, forget } = await aFile();
  try {
    await openUsageMemory({ file }).rememberExchange(anExchange(), NOON);

    // A second memory over the same file, as a restarted relay would build.
    const afterRestart = openUsageMemory({ file });
    const seat = only(await afterRestart.known(NOON + 4000));
    assert.equal(seat.fiveHour?.readAt, NOON);
    assert.equal(seat.fiveHour?.ageSeconds, 4000, "a figure without its age is the one thing a ranking must not get");
    assert.equal(seat.sevenDay?.ageSeconds, 4000);
  } finally {
    await forget();
  }
});

test("an exchange the relay did not swap teaches nothing, because the figures are the caller's own", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberExchange(anExchange({ swapped: false }), NOON);
    assert.deepEqual(await memory.known(NOON), []);
  } finally {
    await forget();
  }
});

test("an exchange nobody was charged for teaches nothing", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberExchange(anExchange({ chargedTo: null, swapped: false }), NOON);
    assert.deepEqual(await memory.known(NOON), []);
  } finally {
    await forget();
  }
});

test("a reply naming a different Organization as the payer is not written against our Seat", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    // This is the mismatch case, and it is being shouted about elsewhere. What
    // must not happen quietly here is another Organization's spending being
    // recorded as ours, which no later reader could ever notice.
    await memory.rememberExchange(anExchange({ paidBy: "org-somebody-else" }), NOON);
    assert.deepEqual(await memory.known(NOON), []);
  } finally {
    await forget();
  }
});

test("a reply that names no payer at all is still believed, since we swapped and it answered", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberExchange(anExchange({ paidBy: null }), NOON);
    assert.equal(only(await memory.known(NOON)).fiveHour?.utilization, 0.4);
  } finally {
    await forget();
  }
});

test("a reading taken through a Stats login is the only news an idle Seat has", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberReading(
      "idle",
      {
        readVia: "stats-login",
        fiveHour: { utilization: 0.05, resetsAt: NOON + 1000 },
        sevenDay: { utilization: 0.6, resetsAt: NOON + 200_000 },
      },
      NOON,
    );

    const seat = only(await memory.known(NOON));
    assert.equal(seat.seat, "idle");
    assert.equal(seat.fiveHour?.utilization, 0.05);
    assert.equal(seat.fiveHour?.readVia, "stats-login", "a reading on the side says so");
  } finally {
    await forget();
  }
});

test("a reply wins over a reading taken on the side at the same moment", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberExchange(anExchange(), NOON);
    await memory.rememberReading(
      "work",
      { readVia: "stats-login", fiveHour: { utilization: 0.01, resetsAt: null }, sevenDay: null },
      NOON,
    );

    // Otherwise a refresh running on a timer keeps overwriting the figure that
    // arrived from the request the Seat actually paid for.
    const seat = only(await memory.known(NOON));
    assert.equal(seat.fiveHour?.utilization, 0.4);
    assert.equal(seat.fiveHour?.readVia, "exchange");

    // A later reading is still news, whichever way it was read.
    await memory.rememberReading(
      "work",
      { readVia: "stats-login", fiveHour: { utilization: 0.7, resetsAt: null }, sevenDay: null },
      NOON + 1,
    );
    assert.equal(only(await memory.known(NOON + 1)).fiveHour?.utilization, 0.7);
  } finally {
    await forget();
  }
});

test("twelve exchanges landing together all end up on disk, none of them lost", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    // The relay allows twelve in the air at once, so twelve replies arriving
    // together is the ordinary case rather than a stress test. Each writes the
    // same file, and a read-modify-write per exchange would keep whichever
    // finished last.
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        memory.rememberExchange(
          anExchange({
            chargedTo: { seat: `seat-${index}`, organizationId: `org-${index}` },
            paidBy: `org-${index}`,
            utilization: { fiveHour: index / 100, sevenDay: null },
          }),
          NOON,
        ),
      ),
    );

    const onDisk = await readJsonFile<{ seats: Record<string, { fiveHour: { utilization: number } }> }>(file);
    assert.equal(Object.keys(onDisk?.seats ?? {}).length, 12);
    for (let index = 0; index < 12; index += 1) {
      assert.equal(onDisk?.seats[`seat-${index}`]?.fiveHour.utilization, index / 100, `seat-${index} was lost`);
    }
  } finally {
    await forget();
  }
});

test("an expired cooldown is dropped from the file, so it cannot only grow", async () => {
  const { file, forget } = await aFile();
  try {
    const memory = openUsageMemory({ file });
    await memory.rememberExchange(
      anExchange({ status: 429, refused: true, resets: { fiveHour: null, sevenDay: null } }),
      NOON,
    );
    // Any later write is what tidies the old one away.
    await memory.rememberExchange(anExchange(), NOON + COOLDOWN_SECONDS + 1);

    const onDisk = await readJsonFile<{ seats: Record<string, { cooldowns: Record<string, number> }> }>(file);
    assert.deepEqual(onDisk?.seats["work"]?.cooldowns, {});
  } finally {
    await forget();
  }
});
