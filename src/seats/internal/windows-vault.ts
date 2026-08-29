import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { protectAll, unprotectAll, type Protected } from "../../dpapi/index.ts";
import { readJsonFile, writeJsonFile } from "../../json-file/index.ts";

import type { Vault } from "./vault.ts";

/**
 * Where the Send tokens live on Windows.
 *
 * One file, outside any relay's own home, because the thing it stands in for is
 * the machine's Keychain and that is shared by every relay on this machine
 * (ADR 0012). Putting it inside a home would mean a Proving Window could not see
 * the Seats the Window the user works in already holds, and would mean undoing
 * one relay took the other's credentials with it.
 *
 * Each token in it is locked by `CryptProtectData` to this Windows account, so
 * the file on its own is worth nothing to anybody else and nothing to this file
 * carried to another machine. That is the part that makes it a fair stand-in for
 * the Keychain rather than the plain file Linux was left with.
 *
 * Its own folder, and deliberately not any relay's home. `relay uninstall`
 * removes a relay's home, so a shared store kept inside one would be taken away
 * by undoing whichever relay happened to be installed first. That is the exact
 * shape that cost every Send token on this machine on 2026-08-22, and the
 * Keychain is outside
 * every home for the same reason.
 */
export const WHERE_TOKENS_LIVE = join(homedir(), ".claude-desktop-relay-secrets", "send-tokens.json");

/** Name to locked token. Nothing else is kept here: the Seats are their own file. */
type OnDisk = { readonly tokens: Readonly<Record<string, Protected>> };

/**
 * Only this Windows account may open the folder, said to Windows as well as
 * relied on.
 *
 * The tokens inside are already locked to this account, so this is the second
 * lock rather than the only one. It is worth having anyway: a folder anyone can
 * read is a folder whose *names* anyone can read, and the names say which
 * accounts and which Organizations this person pays for.
 *
 * A failure is not fatal. The tokens are still locked, and refusing to hold a
 * credential because an ACL could not be tightened would be trading the whole
 * thing for the smaller half of it.
 */
async function onlyThisAccount(folder: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("icacls.exe", [folder, "/inheritance:r", "/grant:r", `${process.env["USERNAME"] ?? ""}:(OI)(CI)F`], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

/**
 * The machine's own secret store on Windows, under one file so removing it is
 * one line.
 *
 * The whole file is opened in one go and held until the file changes underneath,
 * because opening a secret means starting PowerShell and the Seats are read on
 * every page refresh. A separate start per Seat runs into seconds; one start for
 * the whole file is a quarter of one. The `Vault` interface is still one name at a
 * time, so nothing outside
 * this file knows that.
 */
export function windowsVault(file: string = WHERE_TOKENS_LIVE): Vault {
  let held: { at: number; size: number; tokens: Map<string, string | null> } | null = null;

  async function openAll(): Promise<Map<string, string | null>> {
    const found = await stat(file).catch(() => null);
    if (found === null) {
      held = null;
      return new Map();
    }
    if (held !== null && held.at === found.mtimeMs && held.size === found.size) return held.tokens;

    const onDisk = (await readJsonFile<OnDisk>(file)) ?? { tokens: {} };
    const names = Object.keys(onDisk.tokens ?? {});
    const opened = await unprotectAll(names.map((name) => onDisk.tokens[name] ?? ""));

    const tokens = new Map<string, string | null>();
    names.forEach((name, index) => tokens.set(name, opened[index] ?? null));
    held = { at: found.mtimeMs, size: found.size, tokens };
    return tokens;
  }

  async function locked(): Promise<Record<string, Protected>> {
    const onDisk = await readJsonFile<OnDisk>(file);
    return { ...(onDisk?.tokens ?? {}) };
  }

  return {
    async put(name, secret) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await onlyThisAccount(dirname(file));

      const [protectedToken] = await protectAll([secret]);
      if (protectedToken === undefined || protectedToken === null) {
        throw new Error(`Windows would not lock the Send token for "${name}", so it was not written anywhere.`);
      }

      // Read straight from disk rather than from what is held, because another
      // process may have filled a Seat since this one last looked, and writing
      // back a remembered map would forget it.
      await writeJsonFile(file, { tokens: { ...(await locked()), [name]: protectedToken } } satisfies OnDisk);
      held = null;
    },

    async get(name) {
      return (await openAll()).get(name) ?? null;
    },

    async forget(name) {
      const tokens = await locked();
      if (!(name in tokens)) return;
      delete tokens[name];
      await writeJsonFile(file, { tokens } satisfies OnDisk);
      held = null;
    },
  };
}

/** Every Seat name this machine holds a Send token for, whatever any list says. */
export async function everySeatHeldOnWindows(file: string = WHERE_TOKENS_LIVE): Promise<string[]> {
  const onDisk = await readJsonFile<OnDisk>(file).catch(() => null);
  return Object.keys(onDisk?.tokens ?? {});
}
