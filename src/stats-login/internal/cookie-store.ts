import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { access } from "node:fs/promises";

import { theAppsKey, openV10OnWindows } from "../../app-store/index.ts";
import { ON_WINDOWS } from "../../home/index.ts";

/**
 * Where a Stats login is kept, and how it is locked.
 *
 * A Claude Desktop profile keeps its claude.ai session in a Chromium cookie
 * store, encrypted with a key that belongs to the app: derived from one Keychain
 * entry on macOS, kept beside the store and wrapped for this account on Windows.
 * None of that is anybody else's business, which is why it is all in here.
 *
 * `sessionKey` below is the cookie's own name on the wire, not ours.
 */
/**
 * Where the cookie store sits inside a profile, in the two places it can be.
 *
 * Chromium moved it under `Network/` and the older place still exists, so both
 * are looked for rather than one being assumed. The newer one wins where both
 * are there, because that is the one the app is writing.
 */
const COOKIE_FILES = [join("Network", "Cookies"), "Cookies"];
const HOST = ".claude.ai";
const COOKIE = "sessionKey";

/** The Keychain entry Claude Desktop locks its own cookie store with. */
const SAFE_STORAGE = "Claude Safe Storage";

/**
 * Chromium's own constants for the macOS `v10` scheme, which are fixed by the
 * format rather than chosen: PBKDF2-SHA1 over the Keychain password with a
 * literal salt and 1003 rounds, then AES-128-CBC under an IV of sixteen spaces.
 */
const SALT = "saltysalt";
const ROUNDS = 1003;
const KEY_BYTES = 16;
const IV = Buffer.alloc(16, " ");
const V10 = "v10";

/** Absolute, never a PATH lookup: this asks `security` for a decryption key. */
const SECURITY = "/usr/bin/security";

/**
 * The key one profile's cookie store is locked with, whichever machine this is.
 *
 * The profile is an argument rather than ignored, because on Windows the key
 * belongs to the profile: each one keeps its own in its own `Local State`, and
 * reading the wrong one gives back a key that decrypts nothing and says nothing
 * about why. On macOS one Keychain entry covers every profile, so the argument is
 * unused there and that is the honest shape rather than an accident.
 */
export function keyForProfile(profileFolder: string): Promise<Buffer> {
  return ON_WINDOWS ? theAppsKey(profileFolder) : keyFromKeychain();
}

/**
 * The key the machine's own Keychain holds, derived once.
 *
 * Asked for by absolute path. Something earlier on PATH called `security` would
 * otherwise be handed the question, and the answer unlocks every login here.
 */
export async function keyFromKeychain(): Promise<Buffer> {
  const password = await new Promise<string>((resolve, reject) => {
    const child = spawn(SECURITY, ["find-generic-password", "-s", SAFE_STORAGE, "-w"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve(out.replace(/\n$/, ""));
      else
        reject(
          new Error(
            `the Keychain would not give up "${SAFE_STORAGE}": ${err.trim() || `security exited ${code}`}. ` +
              `Without it none of the old Stats logins can be read.`,
          ),
        );
    });
  });

  return pbkdf2Sync(password, SALT, ROUNDS, KEY_BYTES, "sha1");
}

/** Undo the `v10` scheme, or null when this is not one of ours. */
function decryptV10(key: Buffer, blob: Buffer): Buffer | null {
  if (blob.subarray(0, 3).toString("latin1") !== V10) return null;

  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    // The padding is checked here rather than by the cipher, because a wrong key
    // usually produces a plausible-looking block and a thrown error says less
    // than "this did not come out as padded text".
    decipher.setAutoPadding(false);
    const out = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
    const padding = out[out.length - 1] ?? 0;
    if (padding < 1 || padding > 16 || padding > out.length) return null;
    return out.subarray(0, out.length - padding);
  } catch {
    return null;
  }
}

/**
 * `node:sqlite` is still marked experimental, and its warning would land in the
 * middle of the user's Worklist looking like something had gone wrong. Loaded
 * here, quietly, and only when a store is actually opened.
 */
async function sqlite(): Promise<typeof import("node:sqlite")> {
  const said = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = said;
  }
}

/**
 * The Stats login a profile holds, or a reason there is none.
 *
 * Read only, and by a query that names its three columns and passes its two
 * values as parameters, so nothing here depends on the rest of a real store's
 * schema and no value ever becomes part of the query text.
 */
export async function statsLoginIn(
  profileFolder: string,
  key: Buffer,
): Promise<{ statsLogin: string } | { because: string }> {
  // Asked before opening, because sqlite creates an empty database for a path
  // that is not there, and reading a login has no business writing anything.
  let file: string | null = null;
  for (const where of COOKIE_FILES) {
    const candidate = join(profileFolder, where);
    const there = await access(candidate).then(
      () => true,
      () => false,
    );
    if (there) {
      file = candidate;
      break;
    }
  }
  if (file === null) {
    return { because: `there is no cookie store in ${profileFolder}, so this profile was never used here` };
  }

  const { DatabaseSync } = await sqlite();
  let held: Buffer | null = null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT encrypted_value AS value FROM cookies WHERE host_key = ? AND name = ?")
        .get(HOST, COOKIE) as { value?: Uint8Array } | undefined;
      held = row?.value === undefined ? null : Buffer.from(row.value);
    } finally {
      db.close();
    }
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    /**
     * Held open by the app itself, which is ordinary on Windows and impossible on
     * macOS. Named rather than reported as a broken store, because the answer is
     * "close that Window, or use a login this program has kept" and not "something
     * is wrong". See `internal/kept.ts`.
     */
    if (/EBUSY|being used by another process|database is locked/i.test(said)) {
      return {
        because:
          `that profile is open, and Claude Desktop holds its cookie store while it runs, ` +
          `so its login cannot be read from here. Close that Window, or read a login this ` +
          `machine has already kept.`,
      };
    }
    return { because: `the cookie store would not open: ${said}` };
  }

  if (held === null) return { because: "this profile is signed out: its cookie store holds no claude.ai session" };

  const plain = ON_WINDOWS ? openV10OnWindows(held, key) : decryptV10(key, held);
  if (plain === null) return { because: "this cookie store could not be decrypted, so it was written on another machine" };

  // Chromium puts a hash of the host in front of the value. The marker is
  // preferred over cutting a fixed number of bytes, so a change to that prefix
  // fails to find one rather than silently returning a corrupted one.
  const at = plain.indexOf("sk-ant-", 0, "utf8");
  if (at === -1) return { because: "this cookie store holds something that is not a claude.ai session" };

  return { statsLogin: plain.subarray(at).toString("utf8").trim() };
}
