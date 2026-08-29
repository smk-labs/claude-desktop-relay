import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The relay reads the model and how far into a conversation a request is, and
 * nothing else. The strongest guarantee is structural: no body is ever in scope
 * where anything could print it. This makes that structural, rather than true by
 * accident, by refusing any writing to the console from the relay at all.
 *
 * Scripts are exempt: they are run by hand and exist to say something.
 */
test("nothing under src writes to the console", async () => {
  const src = join(repoRoot, "src");
  const entries = await readdir(src, { recursive: true, withFileTypes: true });

  const offenders: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(entry.parentPath, entry.name);
    const source = await readFile(path, "utf8");

    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (/\b(console\.|process\.stdout|process\.stderr)/.test(line)) {
        offenders.push(`${path.slice(repoRoot.length + 1).split(sep).join("/")}:${index + 1}  ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `these write to the console, where a message body could end up:\n${offenders.join("\n")}`,
  );
});
