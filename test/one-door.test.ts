/**
 * Nothing anywhere tells a person to run something that is not there.
 *
 * Ticket 23's real risk is not the building, it is the drift afterwards: the
 * surface gains a command, an old script is removed, and a sentence somewhere
 * still names the old one. That sentence is only ever read by somebody who is
 * already stuck. This makes the whole repository the thing that has to agree.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

import { COMMANDS } from "../src/control/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A path inside the repository, in the one spelling the rules below compare
 * against.
 *
 * Windows joins with backslashes, so every one of these comparisons quietly
 * stopped matching there and these rules stopped being enforced on that machine
 * while still passing on the other. A rule that holds on one of two machines is
 * worse than no rule, because nobody is watching the one it does not hold on.
 */
function asRepoRelative(path: string): string {
  return path.slice(repoRoot.length + 1).split(sep).join("/");
}

/** Folders whose prose and messages a person actually reads. */
const READ_BY_PEOPLE = ["scripts", "src", "docs", "test"];

async function everyFile(folder: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, folder), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".md")))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Files whose whole job is to record what used to be true.
 *
 * A decision and a measurement are history. Rewriting them so a grep passes would
 * be falsifying the record, which is worse than the drift this catches. The
 * handoff notes and the closed tickets that used to be listed here left the repo
 * before its first public release: they were a record of how it was built, which
 * is not the same thing as a record of what was decided.
 */
const HISTORY = [/^docs\/adr\//, /^docs\/mechanism\.md$/];

test("nothing tells a person to run a script that has been removed", async () => {
  const offenders: string[] = [];

  for (const folder of READ_BY_PEOPLE) {
    for (const path of await everyFile(folder)) {
      const shown = asRepoRelative(path);
      if (HISTORY.some((one) => one.test(shown))) continue;

      const source = await readFile(path, "utf8");
      source.split("\n").forEach((line, index) => {
        for (const named of line.matchAll(/node scripts\/([\w.-]+\.ts)/g)) {
          const script = named[1]!;
          if (script === "relay.ts") continue;
          offenders.push(`${shown}:${index + 1}  names scripts/${script} rather than a "relay" subcommand`);
        }
      });
    }
  }

  assert.deepEqual(offenders, [], `these point past the one door:\n${offenders.join("\n")}`);
});

test("every npm script that is offered exists, and there are only the four", async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  /**
   * Four, deliberately, and the fourth is not an exception to the rule.
   *
   * Three are for anyone: run the tests, check the types, and the one door.
   * Every capability that used to be an npm script is a `relay` subcommand now,
   * because two ways to do the same thing is how they drift apart.
   *
   * `package` is the fourth and belongs here rather than behind `relay` because
   * nobody using this program ever runs it. It builds the three release archives
   * out of the one body of code, which is a thing done to the repository and not
   * a thing done with the app, and putting it on the door a person types every
   * day would be one more handle that answers a question they never asked.
   */
  assert.deepEqual(Object.keys(manifest.scripts).sort(), ["package", "relay", "test", "typecheck"]);
});

test("every command the surface offers is spelled the same way wherever it is written", async () => {
  const known = new Set(COMMANDS.map((one) => one.name));
  const offenders: string[] = [];

  for (const folder of READ_BY_PEOPLE) {
    for (const path of await everyFile(folder)) {
      const shown = asRepoRelative(path);
      if (HISTORY.some((one) => one.test(shown))) continue;

      const source = await readFile(path, "utf8");
      source.split("\n").forEach((line, index) => {
        for (const named of line.matchAll(/\brelay ([a-z][a-z-]*)\b/g)) {
          const word = named[1]!;
          // Prose says "relay listening", "relay reads", and so on. Only words
          // that look like a subcommand and are not one are worth reporting.
          if (known.has(word as never) || !/^[a-z][a-z-]*$/.test(word)) continue;
          if (!/-/.test(word)) continue;
          offenders.push(`${shown}:${index + 1}  "relay ${word}" is not a command`);
        }
      });
    }
  }

  assert.deepEqual(offenders, [], `these name a command that does not exist:\n${offenders.join("\n")}`);
});
