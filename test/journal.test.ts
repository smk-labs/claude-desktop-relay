/**
 * The bound on the relay's own log.
 *
 * Every moment is an argument and the bound is one, so nothing here writes eight
 * megabytes to prove anything. What is actually being pinned: that a line is never
 * lost or cut in half by a rotation, and that the count survives a restart, which
 * is where a bound like this usually turns out not to be one.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keptBeside, openJournal } from "../src/journal/index.ts";

const NOON = 1_776_000_000;

/** Nothing here is left behind, because a log test that leaks is a log leak. */
async function aFile() {
  const folder = await mkdtemp(join(tmpdir(), "relay-journal-"));
  const file = join(folder, "relay.log");
  return { folder, file, forget: () => rm(folder, { recursive: true, force: true }) };
}

const sizeOf = (path: string) => stat(path).then((found) => found.size, () => 0);

test("every line said is on disk, dated, and in the order it was said", async () => {
  const bench = await aFile();
  try {
    const journal = openJournal({ file: bench.file });
    journal.say("the relay is listening", NOON);
    journal.say("verified: the Seat work paid", NOON + 1);
    await journal.settled();
    await journal.close();

    const written = await readFile(bench.file, "utf8");
    assert.match(written, /^2026-\d\d-\d\dT[\d:.]+Z {2}the relay is listening$/m);
    assert.equal(written.indexOf("listening") < written.indexOf("verified"), true, "out of order");
  } finally {
    await bench.forget();
  }
});

test("writing past the bound leaves the bound held, and the most recent lines are the ones kept", async () => {
  const bench = await aFile();
  try {
    // A small bound, so this is arithmetic rather than a megabyte of writing. Half
    // of it is the live file, and the other half is the one kept generation.
    const journal = openJournal({ file: bench.file, atMostBytes: 800 });
    for (let index = 0; index < 60; index += 1) journal.say(`line ${index} of sixty, padded out a little`, NOON + index);
    await journal.settled();

    assert.equal(await journal.held() <= 800, true, `it held ${await journal.held()} bytes against a bound of 800`);

    // Neither generation may be over its half, not even for an instant. That is
    // why the rotation happens before a line is written and not after it: rotating
    // after means the file that becomes the kept generation is always one line
    // past the bound, and nothing later ever brings it back under.
    assert.equal(await sizeOf(bench.file) <= 400, true, `the live file held ${await sizeOf(bench.file)} of 400`);
    assert.equal(
      await sizeOf(keptBeside(bench.file)) <= 400,
      true,
      `the kept generation held ${await sizeOf(keptBeside(bench.file))} of 400, so it was rotated a line too late`,
    );

    // The newest line is in the live file. That is the whole reason a generation
    // is kept rather than the file being truncated: rotation may only ever
    // discard the older half of everything there is.
    const live = await readFile(bench.file, "utf8");
    assert.match(live, /line 59 of sixty/);

    const kept = await readFile(keptBeside(bench.file), "utf8");
    assert.equal(kept.includes("line 59"), false, "the kept generation is the older one");
    assert.equal(live.includes("line 0 of sixty"), false, "the oldest line should have aged out");

    // Nothing was cut in half by a rotation: every line that survives is whole.
    for (const line of [...live.split("\n"), ...kept.split("\n")]) {
      if (line === "") continue;
      assert.match(line, /^\S+ {2}line \d+ of sixty, padded out a little$/, `a line was cut: ${JSON.stringify(line)}`);
    }

    await journal.close();
  } finally {
    await bench.forget();
  }
});

test("the bound survives a restart, because the size is read rather than assumed", async () => {
  const bench = await aFile();
  try {
    // A log already almost at its half, as a service that has been up for a week
    // leaves one. The next line said must rotate it.
    const already = `${"x".repeat(389)}\n`;
    await writeFile(bench.file, already);

    // A second journal over the same file, as a restarted service builds. Counting
    // from zero here is the bug this test exists for: the live file would then be
    // allowed to grow by the whole half again after every restart, and a service
    // that restarts is exactly what this one is built to do.
    const afterRestart = openJournal({ file: bench.file, atMostBytes: 800 });
    afterRestart.say("the relay is listening again", NOON);
    await afterRestart.settled();
    await afterRestart.close();

    const kept = await readFile(keptBeside(bench.file), "utf8").catch(() => "");
    assert.equal(kept, already, "what was already there should have become the kept generation");

    const live = await readFile(bench.file, "utf8");
    assert.match(live, /listening again/);
    assert.equal(live.includes("xxx"), false, "it carried on filling a file that was already full");
    assert.equal(await sizeOf(bench.file) <= 400, true);
  } finally {
    await bench.forget();
  }
});

test("rotating while the relay is serving loses no line and interleaves none", async () => {
  const bench = await aFile();
  try {
    // Twelve exchanges can finish together, which is the relay's own bound, so
    // twelve lines arriving at once is ordinary rather than a stress test.
    const journal = openJournal({ file: bench.file, atMostBytes: 600 });
    const said = Array.from({ length: 12 }, (_, index) => `exchange ${index} finished, and here is some padding`);
    for (const line of said) journal.say(line, NOON);
    await journal.settled();

    const everything = [
      await readFile(bench.file, "utf8"),
      await readFile(keptBeside(bench.file), "utf8").catch(() => ""),
    ].join("");

    // Nothing half-written, whichever side of the rotation it landed on.
    for (const line of everything.split("\n")) {
      if (line === "") continue;
      assert.match(line, /^\S+ {2}exchange \d+ finished, and here is some padding$/, `cut: ${JSON.stringify(line)}`);
    }
    // And the last thing said is there, which is what a person reads first.
    assert.match(everything, /exchange 11 finished/);

    await journal.close();
  } finally {
    await bench.forget();
  }
});

test("a log that cannot be written says so and does not stop anything", async () => {
  const bench = await aFile();
  try {
    // A folder where the file should be: opening it for appending fails, every
    // time, which is the shape of a disk that has filled or a path taken over.
    const problems: string[] = [];
    const journal = openJournal({ file: bench.folder, onProblem: (line) => problems.push(line) });

    journal.say("something worth saying", NOON);
    await journal.settled();

    assert.equal(problems.length, 1, "a log that cannot be written must not fail silently either");
    assert.match(problems[0] ?? "", /could not be written/);
    await journal.close();
  } finally {
    await bench.forget();
  }
});

test("a log left over from before is continued, not replaced", async () => {
  const bench = await aFile();
  try {
    await writeFile(bench.file, "something from the last time this ran\n");
    const journal = openJournal({ file: bench.file, atMostBytes: 100_000 });
    journal.say("and something from this time", NOON);
    await journal.settled();
    await journal.close();

    const written = await readFile(bench.file, "utf8");
    assert.match(written, /last time this ran/, "it threw away what was already there");
    assert.match(written, /from this time/);
  } finally {
    await bench.forget();
  }
});
