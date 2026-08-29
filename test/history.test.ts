/**
 * The record of what every Seat spent.
 *
 * Two properties are load-bearing and both are asserted against a written file
 * rather than against what a function returned. No word of anyone's work reaches a
 * row, and folding a month of rows into daily totals does not change any total that
 * spans the boundary. The second one is the whole difference between a rollup and
 * losing data tidily.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { costOf, openHistory, PUBLISHED, rateFor, totalsBy, type Row } from "../src/history/index.ts";

const NOON = 1_776_000_000;
const DAY = 24 * 60 * 60;

async function aFile() {
  const folder = await mkdtemp(join(tmpdir(), "relay-history-"));
  return { file: join(folder, "history.jsonl"), forget: () => rm(folder, { recursive: true, force: true }) };
}

function aRow(over: Partial<Row> = {}): Row {
  return {
    at: NOON,
    seat: "work",
    organizationId: "org-acme",
    model: "claude-opus-5",
    status: 200,
    refused: false,
    tokens: { input: 1000, output: 500, cacheWritten: 0, cacheRead: 0 },
    utilization: { fiveHour: 0.1, sevenDay: 0.2 },
    project: null,
    session: "session-one",
    ...over,
  };
}

test("one row per exchange, with the counts, both Utilizations and the model", async () => {
  const bench = await aFile();
  try {
    const history = openHistory({ file: bench.file });
    await history.keep(aRow());

    const [row] = await history.since(NOON - DAY);
    assert.equal(row?.seat, "work");
    assert.equal(row?.model, "claude-opus-5");
    assert.deepEqual(row?.tokens, { input: 1000, output: 500, cacheWritten: 0, cacheRead: 0 });
    assert.deepEqual(row?.utilization, { fiveHour: 0.1, sevenDay: 0.2 });
  } finally {
    await bench.forget();
  }
});

test("no message content in a row, ever, read back off the file itself", async () => {
  const bench = await aFile();
  try {
    const history = openHistory({ file: bench.file });
    await history.keep(aRow());
    await history.keep(aRow({ refused: true, status: 429 }));

    /**
     * Structural rather than a search for one phrase. Every value written is a
     * number, a boolean, null, or one of a short list of names, so there is nowhere
     * a sentence could sit even if something upstream started handing one over.
     */
    const written = await readFile(bench.file, "utf8");
    for (const line of written.trim().split("\n")) {
      const row = JSON.parse(line) as Record<string, unknown>;
      const strings = JSON.stringify(row).match(/"[^"]*"/g) ?? [];
      for (const held of strings) {
        // A word count, not a blocklist: nothing here is prose, and prose is the
        // only thing that has spaces in it.
        assert.equal(held.includes(" "), false, `a row carried prose: ${held}`);
      }
    }
  } finally {
    await bench.forget();
  }
});

test("a Refusal is a row too, so a Seat that kept turning us away is answerable", async () => {
  const bench = await aFile();
  try {
    const history = openHistory({ file: bench.file });
    for (let one = 0; one < 4; one += 1) await history.keep(aRow({ at: NOON + one, refused: true, status: 429 }));
    await history.keep(aRow({ at: NOON + 9 }));

    const [total] = await history.perSeat("day", NOON + 10);
    assert.equal(total?.exchanges, 5);
    assert.equal(total?.refusals, 4);
  } finally {
    await bench.forget();
  }
});

test("the history survives a restart and is readable with nothing running", async () => {
  const bench = await aFile();
  try {
    await openHistory({ file: bench.file }).keep(aRow());
    // A second reader over the same file, which is what a command a person types is.
    const [row] = await openHistory({ file: bench.file }).since(0);
    assert.equal(row?.seat, "work");
  } finally {
    await bench.forget();
  }
});

test("twelve exchanges finishing together all leave a row, none of them lost", async () => {
  const bench = await aFile();
  try {
    const history = openHistory({ file: bench.file });
    // Appending is one write with no read before it, which is why this holds. A
    // read-modify-write would keep whichever finished last.
    await Promise.all(
      Array.from({ length: 12 }, (_, one) => history.keep(aRow({ at: NOON + one, seat: `seat-${one}` }))),
    );

    const rows = await history.since(0);
    assert.equal(rows.length, 12);
    assert.equal(new Set(rows.map((row) => row.seat)).size, 12);
  } finally {
    await bench.forget();
  }
});

test("a half-written line costs one row, not the record and not the next row either", async () => {
  const bench = await aFile();
  try {
    await openHistory({ file: bench.file }).keep(aRow());

    // What a machine losing power mid-append leaves behind: a line with no newline
    // on the end of it.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(bench.file, `{"at":${NOON},"seat":"work","tok`);

    // A restart, which is the only moment that truncated line can be there.
    // Without mending it, the next row is glued onto the broken one and the crash
    // costs two rows instead of one.
    const afterRestart = openHistory({ file: bench.file });
    await afterRestart.keep(aRow({ at: NOON + 5, seat: "other" }));

    assert.deepEqual(
      (await afterRestart.since(0)).map((row) => row.seat),
      ["work", "other"],
      "one bad line took the row after it",
    );
  } finally {
    await bench.forget();
  }
});

// ---- totals ------------------------------------------------------------------

test("totals per Seat over a day, a week and a month each match the sum of their rows", async () => {
  const bench = await aFile();
  try {
    const history = openHistory({ file: bench.file });

    // One row a day for forty days, so each period includes a known number.
    for (let day = 0; day < 40; day += 1) {
      await history.keep(aRow({ at: NOON - day * DAY, tokens: { input: 100, output: 10, cacheWritten: 0, cacheRead: 0 } }));
    }

    const day = (await history.perSeat("day", NOON))[0];
    const week = (await history.perSeat("week", NOON))[0];
    const month = (await history.perSeat("month", NOON))[0];

    assert.equal(day?.exchanges, 2, "today and the one a day ago, which is the boundary");
    assert.equal(week?.exchanges, 8);
    assert.equal(month?.exchanges, 31);

    // The counts are the sum of the rows and not an average of anything.
    assert.equal(month?.input, 31 * 100);
    assert.equal(month?.output, 31 * 10);
  } finally {
    await bench.forget();
  }
});

test("a row whose model the price table does not know is counted and left unpriced", () => {
  const totals = totalsBy(
    [
      aRow({ model: "claude-opus-5" }),
      aRow({ model: "claude-something-nobody-published" }),
    ],
    (row) => row.seat,
  );

  const total = totals[0]!;
  assert.equal(total.exchanges, 2);
  assert.equal(total.unpriced, 1, "a model priced at a rate nobody published is an invented total");
  assert.equal(total.wouldHaveCost !== null, true, "the row that could be priced still is");
});

test("nothing is priced at all when no row had a known model, rather than being priced at zero", () => {
  const totals = totalsBy([aRow({ model: null })], (row) => row.seat);
  assert.equal(totals[0]?.wouldHaveCost, null);
});

test("cost is derived from the counts and the rates, and correcting a rate corrects the past", () => {
  const row = { model: "claude-opus-5", input: 1_000_000, output: 1_000_000, cacheWritten: 0, cacheRead: 0 };

  // Opus 5 at 5 in and 25 out per million.
  assert.equal(costOf(row), 30);

  // The same row, read against a corrected table, comes out different. No money is
  // stored in a row, which is what makes that true.
  const corrected = { ...PUBLISHED, rates: { ...PUBLISHED.rates, "claude-opus-5": { input: 6, output: 30 } } };
  assert.equal(costOf(row, corrected), 36);
});

test("the cache rates are multiples of that model's input rate, which is how they are published", () => {
  // Writing a five-minute entry costs 1.25 times input; reading costs a tenth.
  assert.equal(costOf({ model: "claude-opus-5", input: 0, output: 0, cacheWritten: 1_000_000, cacheRead: 0 }), 6.25);
  assert.equal(costOf({ model: "claude-opus-5", input: 0, output: 0, cacheWritten: 0, cacheRead: 1_000_000 }), 0.5);
});

test("a dated build of a model is priced by its family, not left unknown", () => {
  // The server names a dated build, and pinning every one would price a model as
  // unknown the day a new build ships.
  assert.deepEqual(rateFor("claude-haiku-4-5-20251001"), { input: 1, output: 5 });
  assert.equal(rateFor("claude-nothing-like-this"), null);
});

// ---- the rollup --------------------------------------------------------------

/**
 * The one test the rollup lives or dies by.
 *
 * Four rows a day for sixty days, so the fold really does collapse many rows into
 * one rather than renaming them one for one. The first version of this had one row
 * a day, which folds to exactly one row a day, so every total came out right
 * whether or not `rolledUp` was carried at all: three separate mutations of the
 * fold survived it. Totals over everything, before and against after, is what
 * actually pins it.
 */
test("folding many rows into one changes no total at all", async () => {
  const bench = await aFile();
  try {
    const history = openHistory({ file: bench.file });

    for (let day = 0; day < 60; day += 1) {
      for (let one = 0; one < 4; one += 1) {
        await history.keep(
          aRow({
            at: NOON - day * DAY + one * 60,
            refused: one % 2 === 1,
            status: one % 2 === 1 ? 429 : 200,
            tokens: { input: 100, output: 20, cacheWritten: 5, cacheRead: 1000 },
          }),
        );
      }
    }

    const everything = (rows: readonly Row[]) => totalsBy(rows, (row) => row.seat)[0];
    const before = everything(await history.since(0));
    assert.equal((await history.since(0)).length, 240);

    // Fourteen whole days are past the boundary. The day the boundary falls on
    // keeps its rows, since only the one exactly on it is not after it.
    const folded = await history.fold(NOON, 45);
    assert.equal(folded.replaced, 56, "fourteen days of four rows should have been folded");

    const rowsAfter = (await history.since(0)).length;
    assert.equal(rowsAfter, 212, "fifty-six rows should have become twenty-eight");

    /**
     * Every count identical, on a record that is now twenty-eight rows smaller.
     * That is the difference between a rollup and losing data tidily.
     *
     * The cost is compared to within a hair rather than exactly, and that is not a
     * softening. Every count is an integer and comes out identical; the cost is a
     * sum of fractions, and summing the same fractions in a different order moves
     * the last bit of a double. Demanding exactness there would be demanding
     * something about floating point rather than about the fold.
     */
    const after = everything(await history.since(0));
    assert.deepEqual(
      { ...after, wouldHaveCost: null },
      { ...before, wouldHaveCost: null },
    );
    assert.equal(Math.abs((after?.wouldHaveCost ?? 0) - (before?.wouldHaveCost ?? 0)) < 1e-9, true);
    assert.equal(before?.exchanges, 240);
    assert.equal(before?.refusals, 120);
    assert.equal(before?.input, 24_000);
  } finally {
    await bench.forget();
  }
});

test("a total inside the kept window is untouched by a fold outside it", async () => {
  const bench = await aFile();
  try {
    const history = openHistory({ file: bench.file });
    for (let day = 0; day < 60; day += 1) {
      for (let one = 0; one < 4; one += 1) await history.keep(aRow({ at: NOON - day * DAY + one * 60 }));
    }

    const before = (await history.perSeat("month", NOON))[0];
    await history.fold(NOON, 45);
    // Nothing inside the month was folded at all, so this one is exact.
    assert.deepEqual((await history.perSeat("month", NOON))[0], before);
  } finally {
    await bench.forget();
  }
});

test("folding twice changes nothing the second time", async () => {
  const bench = await aFile();
  try {
    const history = openHistory({ file: bench.file });
    for (let day = 0; day < 60; day += 1) await history.keep(aRow({ at: NOON - day * DAY }));

    await history.fold(NOON, 45);
    const once = await history.since(0);
    await history.fold(NOON, 45);
    const twice = await history.since(0);

    // A fold that kept shrinking the same rows would lose the count it stands for.
    assert.deepEqual(twice, once);
  } finally {
    await bench.forget();
  }
});

test("nothing old enough to fold is a no-op that says so, rather than a rewrite", async () => {
  const bench = await aFile();
  try {
    const history = openHistory({ file: bench.file });
    await history.keep(aRow());
    assert.deepEqual(await history.fold(NOON, 45), { replaced: 0, with: 0 });
  } finally {
    await bench.forget();
  }
});
