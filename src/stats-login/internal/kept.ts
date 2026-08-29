import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { protectAll, unprotectAll } from "../../dpapi/index.ts";
import { readJsonFile, writeJsonFile } from "../../json-file/index.ts";

/**
 * Stats logins kept by this program, for the machine where they cannot be read
 * where they live.
 *
 * On macOS every Stats login is read out of a Claude Desktop profile's own cookie
 * store and nothing is ever kept, which is the better arrangement and stays the
 * one used wherever it works. It does not work on Windows for a plain reason:
 * Chromium holds its cookie store open exclusively, so a profile that is running
 * cannot be read at all, and on this machine the profiles are running almost
 * always. Measured 2026-08-25: the file answers `EBUSY` to a read and to a copy.
 *
 * So the login is read once, from a profile that is closed or from a folder of
 * logins the user already has, and kept here. Each one is locked by
 * `CryptProtectData` to this Windows account, exactly like the Send tokens, so
 * the file is worth nothing to anybody else and nothing on another machine.
 *
 * A Stats login can read and never sends (ADR 0002). Keeping one is still keeping
 * a credential, which is why it is locked and why it lives beside the Send tokens
 * rather than in a relay's home: `relay uninstall` removes a home.
 */
export const WHERE_STATS_LOGINS_ARE_KEPT = join(homedir(), ".claude-desktop-relay-secrets", "stats-logins.json");

/** One kept login: the name it was read under, and the login itself. */
export type KeptLogin = { readonly profile: string; readonly statsLogin: string };

type OnDisk = { readonly logins: Readonly<Record<string, string>> };

/**
 * Every Stats login this machine has kept.
 *
 * One that will not open comes back missing rather than as an error: it belongs
 * to another Windows account, and the others are still readable.
 */
export async function keptStatsLogins(file: string = WHERE_STATS_LOGINS_ARE_KEPT): Promise<KeptLogin[]> {
  const held = await readJsonFile<OnDisk>(file).catch(() => null);
  const names = Object.keys(held?.logins ?? {});
  if (names.length === 0) return [];

  const opened = await unprotectAll(names.map((name) => held?.logins[name] ?? ""));
  const kept: KeptLogin[] = [];
  names.forEach((profile, index) => {
    const statsLogin = opened[index];
    if (statsLogin !== undefined && statsLogin !== null && statsLogin !== "") kept.push({ profile, statsLogin });
  });
  return kept;
}

/**
 * Keep these, leaving any already kept under another name alone.
 *
 * Replacing by name rather than merging by value, because a login that has been
 * signed in again is a new login for the same account and the old one is dead.
 */
export async function keepStatsLogins(
  logins: readonly KeptLogin[],
  file: string = WHERE_STATS_LOGINS_ARE_KEPT,
): Promise<number> {
  if (logins.length === 0) return 0;

  const locked = await protectAll(logins.map((one) => one.statsLogin));
  const held = (await readJsonFile<OnDisk>(file).catch(() => null))?.logins ?? {};
  const logins_: Record<string, string> = { ...held };

  let kept = 0;
  logins.forEach((one, index) => {
    const blob = locked[index];
    if (blob === undefined || blob === null) return;
    logins_[one.profile] = blob;
    kept += 1;
  });

  await writeJsonFile(file, { logins: logins_ } satisfies OnDisk);
  return kept;
}

/**
 * Read a folder of login files and keep what is in it.
 *
 * The shape is the one the user's own earlier tool wrote, one JSON file per
 * account holding `sessionKey`, because that is the folder these logins are
 * actually in and inventing a different shape would mean asking somebody to
 * convert every one of those files by hand. Anything else in them is ignored: this
 * takes the login and the name, and nothing else.
 *
 * Read only. Nothing is written back to that folder and nothing is removed from
 * it.
 */
export async function importStatsLogins(folder: string, file: string = WHERE_STATS_LOGINS_ARE_KEPT): Promise<KeptLogin[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch((error: unknown) => {
    throw new Error(`there is nothing to read at ${folder}: ${error instanceof Error ? error.message : String(error)}`);
  });

  const found: KeptLogin[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    const held = await readFile(join(folder, entry.name), "utf8")
      .then((text) => JSON.parse(text) as { name?: unknown; sessionKey?: unknown })
      .catch(() => null);
    if (held === null) continue;

    const statsLogin = typeof held.sessionKey === "string" ? held.sessionKey.trim() : "";
    // The shape of a claude.ai session, checked rather than assumed, so a file
    // holding something else is skipped instead of kept as a login that cannot work.
    if (!statsLogin.startsWith("sk-ant-")) continue;

    const profile = typeof held.name === "string" && held.name !== "" ? held.name : basename(entry.name, ".json");
    found.push({ profile, statsLogin });
  }

  await keepStatsLogins(found, file);
  return found;
}
