/**
 * Where Send tokens live on Linux: one file only its owner can read.
 *
 * This is the one thing the macOS side has that Linux does not, and the
 * substitute is honest rather than dressed up. There is no encryption here,
 * because there is nowhere on this machine to keep a key that the relay can read
 * and an attacker in the same account cannot: a key beside the file it unlocks is
 * a longer path to the same secret, and pretending otherwise is worse than saying
 * so. What protects these tokens is the file mode and the account boundary.
 *
 * So: the folder is 0700, the file is 0600, and every write goes to a temporary
 * name created with that mode and is renamed into place. Nothing is ever written
 * world-readable even for an instant, which matters because this machine is
 * shared with other people.
 */
import { chmod, mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Vault } from "../../src/seats/internal/vault.ts";

type Held = Record<string, string>;

async function read(file: string): Promise<Held> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return "{}";
    throw error;
  });
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null) return {};

  const held: Held = {};
  for (const [name, secret] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof secret === "string") held[name] = secret;
  }
  return held;
}

/**
 * Write the whole set, owner-only, atomically.
 *
 * The mode is given to `writeFile` *and* set again afterwards: a `umask` cannot
 * loosen what `chmod` states outright, and every credential in this file pays for
 * a year.
 */
async function write(file: string, held: Held): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const nearly = join(dirname(file), `.${"send-tokens"}.part`);
  try {
    await writeFile(nearly, `${JSON.stringify(held, null, 2)}\n`, { mode: 0o600 });
    await chmod(nearly, 0o600);
    await rename(nearly, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(nearly, { force: true });
    throw error;
  }
}

/** The Send tokens, in one owner-only file. Satisfies the same seam the Keychain does. */
export function fileVault(file: string): Vault {
  return {
    async put(name, secret) {
      const held = await read(file);
      held[name] = secret;
      await write(file, held);
    },

    async get(name) {
      const held = await read(file);
      return held[name] ?? null;
    },

    async forget(name) {
      const held = await read(file);
      if (!(name in held)) return;
      delete held[name];
      await write(file, held);
    },
  };
}

/** Every Seat name this file holds a token for, whatever `seats.json` says. */
export async function everySeatHeldInFile(file: string): Promise<string[]> {
  return Object.keys(await read(file));
}
