/**
 * Which project the spending was for, resolved from a fixture tree.
 *
 * Nothing here touches the real `~/.claude/projects`. The whole point of the
 * lookup is that it reads only the names of things: a directory named after a
 * working directory, holding one file per session id. No transcript is ever opened,
 * which is what makes attributing spending to a repository possible without going
 * anywhere near what was said in it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openHistory, openProjects, pathFromDirectory, shortNameFor, type Row } from "../src/history/index.ts";

const NOON = 1_776_000_000;

/** A tree in the shape Claude Code writes, and no bigger. */
async function aTranscriptTree(tree: Readonly<Record<string, readonly string[]>>) {
  const folder = await mkdtemp(join(tmpdir(), "relay-projects-"));
  for (const [directory, sessions] of Object.entries(tree)) {
    await mkdir(join(folder, directory), { recursive: true });
    for (const session of sessions) {
      // The contents are never read. Written as something, so the file is real.
      await writeFile(join(folder, directory, `${session}.jsonl`), `{"nothing":"here is ever read"}\n`);
    }
  }
  return { folder, forget: () => rm(folder, { recursive: true, force: true }) };
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
    utilization: { fiveHour: null, sevenDay: null },
    project: null,
    session: "session-one",
    ...over,
  };
}

test("a directory name decodes back to the path it was made from", () => {
  assert.equal(pathFromDirectory("-Users-me-Projects-thing"), "/Users/me/Projects/thing");
  // A name that does not look encoded is reported as it is, rather than being
  // turned into a plausible path that never existed.
  assert.equal(pathFromDirectory("something-else"), "something-else");
});

test("a session is resolved to the project whose directory holds it", async () => {
  const tree = await aTranscriptTree({
    "-Users-me-Projects-alpha": ["session-one", "session-two"],
    "-Users-me-Projects-beta": ["session-three"],
  });
  try {
    const projects = openProjects({ folder: tree.folder });
    assert.equal(await projects.of("session-one"), "/Users/me/Projects/alpha");
    assert.equal(await projects.of("session-three"), "/Users/me/Projects/beta");
  } finally {
    await tree.forget();
  }
});

test("a session nothing can name is null rather than a guess", async () => {
  const tree = await aTranscriptTree({ "-Users-me-Projects-alpha": ["session-one"] });
  try {
    // Null so the row is left alone and tried again. A transcript the CLI has not
    // flushed yet is exactly this case, and writing "unknown" would lose it.
    assert.equal(await openProjects({ folder: tree.folder }).of("session-nobody-knows"), null);
  } finally {
    await tree.forget();
  }
});

test("a missing transcript folder is nothing to name, and not an error", async () => {
  assert.equal(await openProjects({ folder: "/nowhere/at/all" }).of("session-one"), null);
});

test("a project's short name is the last two segments, because two repos can share one", () => {
  assert.equal(shortNameFor("/Users/me/Projects/tools/ai/relay"), "ai/relay");
  assert.equal(shortNameFor("/relay"), "relay");
});

// ---- filling rows in ---------------------------------------------------------

async function aHistoryFile() {
  const folder = await mkdtemp(join(tmpdir(), "relay-history-projects-"));
  return { file: join(folder, "history.jsonl"), forget: () => rm(folder, { recursive: true, force: true }) };
}

test("rows are filled in from their session id, and totals per project follow", async () => {
  const tree = await aTranscriptTree({
    "-Users-me-Projects-alpha": ["session-one"],
    "-Users-me-Projects-beta": ["session-two"],
  });
  const bench = await aHistoryFile();
  try {
    const history = openHistory({ file: bench.file });
    await history.keep(aRow({ session: "session-one" }));
    await history.keep(aRow({ at: NOON + 1, session: "session-one" }));
    await history.keep(aRow({ at: NOON + 2, session: "session-two", seat: "other" }));

    const projects = openProjects({ folder: tree.folder });
    assert.equal(await history.nameProjects((session) => projects.of(session)), 3);

    const perProject = await history.perProject("day", NOON + 10);
    assert.deepEqual(
      perProject.map((one) => [one.of, one.exchanges]),
      [
        ["/Users/me/Projects/alpha", 2],
        ["/Users/me/Projects/beta", 1],
      ],
    );

    // The question ticket 19 actually asks: which repository is eating which Seat.
    const crossed = await history.perProjectAndSeat("day", NOON + 10);
    assert.deepEqual(crossed.map((one) => one.of).sort(), [
      "/Users/me/Projects/alpha on work",
      "/Users/me/Projects/beta on other",
    ]);
  } finally {
    await bench.forget();
    await tree.forget();
  }
});

test("a row whose project cannot be found yet is filled in on a later pass, not lost", async () => {
  const bench = await aHistoryFile();
  const empty = await aTranscriptTree({});
  try {
    const history = openHistory({ file: bench.file });
    await history.keep(aRow({ session: "session-one" }));

    // First pass: the CLI has not written the transcript yet.
    assert.equal(await history.nameProjects((session) => openProjects({ folder: empty.folder }).of(session)), 0);
    assert.equal((await history.since(0))[0]?.project, null, "it was written as unknown and can never be filled");

    // Second pass, once the transcript is there.
    const later = await aTranscriptTree({ "-Users-me-Projects-alpha": ["session-one"] });
    try {
      assert.equal(await history.nameProjects((session) => openProjects({ folder: later.folder }).of(session)), 1);
      assert.equal((await history.since(0))[0]?.project, "/Users/me/Projects/alpha");
    } finally {
      await later.forget();
    }
  } finally {
    await empty.forget();
    await bench.forget();
  }
});

test("a row already named is not looked up again, and a row with no session is skipped", async () => {
  const bench = await aHistoryFile();
  try {
    const history = openHistory({ file: bench.file });
    await history.keep(aRow({ project: "/already/named" }));
    await history.keep(aRow({ at: NOON + 1, session: null }));

    const asked: string[] = [];
    const filled = await history.nameProjects((session) => {
      asked.push(session);
      return "/should/not/be/asked";
    });

    assert.equal(filled, 0);
    assert.deepEqual(asked, [], "it re-resolved rows that already had an answer");
    assert.equal((await history.since(0))[0]?.project, "/already/named");
  } finally {
    await bench.forget();
  }
});

test("one lookup per session, however many rows share it", async () => {
  const tree = await aTranscriptTree({ "-Users-me-Projects-alpha": ["session-one"] });
  const bench = await aHistoryFile();
  try {
    const history = openHistory({ file: bench.file });
    for (let one = 0; one < 50 ; one += 1) await history.keep(aRow({ at: NOON + one, session: "session-one" }));

    const asked: string[] = [];
    await history.nameProjects((session) => {
      asked.push(session);
      return openProjects({ folder: tree.folder }).of(session);
    });

    // Fifty rows, one question. Without this a month of rows would list the
    // transcript directories once per row.
    assert.deepEqual(asked, ["session-one"]);
  } finally {
    await bench.forget();
    await tree.forget();
  }
});

test("nothing about a project comes from inside a transcript", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-projects-privacy-"));
  try {
    await mkdir(join(folder, "-Users-me-Projects-alpha"), { recursive: true });
    // A transcript whose contents would be extremely tempting to read.
    await writeFile(
      join(folder, "-Users-me-Projects-alpha", "session-one.jsonl"),
      `{"cwd":"/somewhere/else/entirely","message":"correct-horse-battery-staple"}\n`,
    );

    // The directory name is the answer, and the file is never opened. If it were,
    // this would say `/somewhere/else/entirely`.
    assert.equal(await openProjects({ folder }).of("session-one"), "/Users/me/Projects/alpha");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
