/**
 * Nothing may forget Send tokens by wildcard, from anywhere, ever again.
 *
 * A Send token is the one thing in this program that cannot be rebuilt: each is an
 * interactive sign-in as its own account, and the Keychain is shared by every relay
 * on this machine (ADR 0012). On 2026-08-22 one call to `forgetEverything`, from a
 * command that was tearing down a Proving Window, removed every one the user had.
 * There was no backup and nothing to recover.
 *
 * The undo now forgets Seats by name. This is what stops the wildcard coming back
 * as a convenience: it is a rule enforced by the build rather than by memory.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A path inside the repository, in the one spelling this file compares against.
 *
 * Windows joins with backslashes, so every one of these comparisons quietly
 * stopped matching there and the rule stopped being enforced on that machine
 * while still passing on the other. A rule that only holds on one of two
 * machines is worse than no rule, because nobody is watching the one it does not
 * hold on.
 */
function asRepoRelative(path: string): string {
  return path.slice(repoRoot.length + 1).split(sep).join("/");
}

/** The one file allowed to define it, and to say why nothing uses it. */
const WHERE_IT_IS_DEFINED = "src/seats/internal/keychain.ts";

test("nothing calls forgetEverything, and the only file naming it is the one that refuses to", async () => {
  const callers: string[] = [];

  for (const folder of ["src", "scripts", "test"]) {
    const entries = await readdir(join(repoRoot, folder), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const path = join(entry.parentPath, entry.name);
      const shown = asRepoRelative(path);
      if (shown === WHERE_IT_IS_DEFINED || shown === "test/no-wildcard-forget.test.ts") continue;

      const source = await readFile(path, "utf8");
      source.split("\n").forEach((line, index) => {
        // A comment explaining why not to is allowed; a call is not.
        if (/forgetEverything\s*\(/.test(line)) callers.push(`${shown}:${index + 1}  ${line.trim()}`);
      });
    }
  }

  assert.deepEqual(
    callers,
    [],
    `these forget Send tokens by wildcard, which cost every account once:\n${callers.join("\n")}`,
  );
});

test("the wildcard is not on the module's interface, so it cannot be reached from outside", async () => {
  const surface = await readFile(join(repoRoot, "src", "seats", "index.ts"), "utf8");
  assert.equal(surface.includes("forgetEverything"), false, "exporting it is offering it");
});

test("nothing behind the Machine seam can reach the Keychain, so no undo can go round the refusal", async () => {
  const machine = await readFile(join(repoRoot, "src", "control", "internal", "machine.ts"), "utf8");

  // The absence is the design. `relay prove --tear-down` calls the undo directly
  // and must be incapable of costing anything, and the way to make that true is
  // for the undo itself not to have the capability rather than for every caller to
  // remember to pass the right argument.
  for (const reach of ["keychainVault", "everySeatHeld", "forgetEverything"]) {
    assert.equal(machine.includes(`${reach}(`), false, `the Machine reaches the Keychain through ${reach}`);
  }
});
