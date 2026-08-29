import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { unprotectAllBytes } from "../../dpapi/index.ts";
import { ON_WINDOWS } from "../../home/index.ts";

/**
 * How the app's own store is locked, as one thing.
 *
 * There are two schemes and they share only a name. macOS is AES-128-CBC under a
 * key stretched from one Keychain secret; Windows is AES-256-GCM under a key the
 * app keeps beside the store, wrapped by Windows for this account. Both are
 * Chromium's rather than ours, and one wrong constant in either produces a store
 * the app cannot read and does not complain about, so both are written down here
 * once and proved rather than believed.
 */
export type Lock = {
  encrypt(plain: string): Promise<Buffer>;
  decrypt(blob: Buffer): Promise<string>;
};

/* ---------------------------------------------------------------- macOS ---- */

/**
 * Chromium's scheme on macOS: AES-128-CBC, a key stretched from one Keychain
 * secret, a fixed initialisation vector, and a three byte version prefix.
 */
const MAC_VERSION = "v10";
const SALT = "saltysalt";
const ROUNDS = 1003;
const KEY_BYTES = 16;
const IV = Buffer.alloc(16, 0x20);

function keyFrom(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ROUNDS, KEY_BYTES, "sha1");
}

export function encryptForApp(plain: string, password: string): Buffer {
  const cipher = createCipheriv("aes-128-cbc", keyFrom(password), IV);
  return Buffer.concat([Buffer.from(MAC_VERSION, "utf8"), cipher.update(plain, "utf8"), cipher.final()]);
}

export function decryptFromApp(blob: Buffer, password: string): string {
  const prefix = blob.subarray(0, MAC_VERSION.length).toString("utf8");
  if (prefix !== MAC_VERSION) {
    throw new Error(`the store is not in the ${MAC_VERSION} form this knows how to read, it starts "${prefix}"`);
  }

  const decipher = createDecipheriv("aes-128-cbc", keyFrom(password), IV);
  return Buffer.concat([decipher.update(blob.subarray(MAC_VERSION.length)), decipher.final()]).toString("utf8");
}

/** Service and account of the one Keychain secret the app's store is locked with. */
export const SAFE_STORAGE = { service: "Claude Safe Storage", account: "Claude Key" };

/**
 * The app's own storage secret, read from the machine's Keychain.
 *
 * Ours to read: it is the user's Keychain and the user is running this. Nothing
 * in the test suite calls this, because no test may touch the Keychain.
 */
export function safeStoragePassword(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "security",
      ["find-generic-password", "-s", SAFE_STORAGE.service, "-a", SAFE_STORAGE.account, "-w"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `could not read "${SAFE_STORAGE.service}" from the Keychain: ${err.trim() || `security exited ${code}`}. ` +
              `Claude Desktop has to have been run at least once for that entry to exist.`,
          ),
        );
        return;
      }
      resolve(out.replace(/\n$/, ""));
    });
  });
}

/** The macOS lock, given a way to read that one Keychain secret. */
export function macLock(password: () => Promise<string> = safeStoragePassword): Lock {
  return {
    async encrypt(plain) {
      return encryptForApp(plain, await password());
    },
    async decrypt(blob) {
      return decryptFromApp(blob, await password());
    },
  };
}

/* -------------------------------------------------------------- Windows ---- */

/**
 * Chromium's scheme on Windows, which shares only the words with the macOS one:
 * AES-256-GCM, a twelve byte nonce that is fresh every time, a sixteen byte tag
 * after the ciphertext, and the same three byte prefix.
 *
 * The key is not stretched from anything. Chromium makes it once, wraps it with
 * `CryptProtectData` for the logged-in account, and keeps it in `Local State`
 * beside the store, under `os_crypt.encrypted_key` with `DPAPI` in front of the
 * wrapped bytes.
 *
 * Every one of those numbers was proved rather than read off a page. On
 * 2026-08-25 this key opened a value Claude Desktop itself had written: a cookie
 * in its own profile, which Chromium locks with the same key. Nothing of that
 * value was kept; the only answer taken was yes. See `provingTheKey` below, which
 * is the same check the doctor can run.
 */
const WINDOWS_VERSION = "v10";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_KEY_PREFIX = "DPAPI";

/** Where the app keeps the wrapped key: beside the store, in the same folder. */
export function localStateFile(profileFolder: string): string {
  return join(profileFolder, "Local State");
}

/**
 * The key one Claude Desktop profile locks its own state with.
 *
 * Per profile, because each one has its own `Local State`. Reading the wrong
 * profile's key produces a store that profile cannot read and says nothing about
 * it, which is the failure this whole file exists to make impossible.
 */
export async function theAppsKey(profileFolder: string): Promise<Buffer> {
  const file = localStateFile(profileFolder);
  const text = await readFile(file, "utf8").catch(() => {
    throw new Error(
      `there is no "${file}", so this cannot tell how that profile locks its own state. ` +
        `Claude Desktop has to have been run at least once on that folder.`,
    );
  });

  const held = JSON.parse(text) as { os_crypt?: { encrypted_key?: string } };
  const wrapped = held.os_crypt?.encrypted_key;
  if (typeof wrapped !== "string" || wrapped === "") {
    throw new Error(`"${file}" holds no os_crypt.encrypted_key, so an update has changed how the app locks its state.`);
  }

  const bytes = Buffer.from(wrapped, "base64");
  const prefix = bytes.subarray(0, WRAPPED_KEY_PREFIX.length).toString("utf8");
  if (prefix !== WRAPPED_KEY_PREFIX) {
    throw new Error(`the stored key does not begin "${WRAPPED_KEY_PREFIX}", it begins "${prefix}".`);
  }

  const [key] = await unprotectAllBytes([bytes.subarray(WRAPPED_KEY_PREFIX.length).toString("base64")]);
  if (key === undefined || key === null) {
    throw new Error(
      `Windows would not unwrap that profile's key. It is locked to the account that made it, ` +
        `so this is what a profile copied from another machine or another user looks like.`,
    );
  }

  if (key.length !== 32) {
    throw new Error(`the unwrapped key is ${key.length} bytes where AES-256 needs 32, so the scheme has changed.`);
  }
  return key;
}

export function encryptForAppOnWindows(plain: string, key: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(WINDOWS_VERSION, "utf8"), nonce, body, cipher.getAuthTag()]);
}

export function decryptFromAppOnWindows(blob: Buffer, key: Buffer): string {
  const prefix = blob.subarray(0, WINDOWS_VERSION.length).toString("utf8");
  if (prefix !== WINDOWS_VERSION) {
    throw new Error(`the store is not in the ${WINDOWS_VERSION} form this knows how to read, it starts "${prefix}"`);
  }

  const nonce = blob.subarray(WINDOWS_VERSION.length, WINDOWS_VERSION.length + NONCE_BYTES);
  const body = blob.subarray(WINDOWS_VERSION.length + NONCE_BYTES, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * The same scheme, giving back the bytes, and null rather than throwing when it
 * is not one of ours.
 *
 * The cookie store the Stats logins live in is locked with this same key and this
 * same scheme, and what is in it is not text: Chromium puts a hash of the host in
 * front of the value, so reading it as UTF-8 would mangle the front of every one.
 * One implementation of the scheme rather than two, because two would agree until
 * the day one of them was corrected.
 */
export function openV10OnWindows(blob: Buffer, key: Buffer): Buffer | null {
  if (blob.subarray(0, WINDOWS_VERSION.length).toString("latin1") !== WINDOWS_VERSION) return null;
  if (blob.length < WINDOWS_VERSION.length + NONCE_BYTES + TAG_BYTES) return null;

  try {
    const nonce = blob.subarray(WINDOWS_VERSION.length, WINDOWS_VERSION.length + NONCE_BYTES);
    const body = blob.subarray(WINDOWS_VERSION.length + NONCE_BYTES, blob.length - TAG_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // A tag that does not verify is a wrong key or a changed scheme, and both are
    // "this is not readable" rather than an error worth throwing from here.
    return null;
  }
}

/**
 * The Windows lock for one profile, with its key read once and held.
 *
 * Held because unwrapping it starts PowerShell, and the page asks whether each
 * profile is relayed. Held per lock rather than globally, so two profiles never
 * share an answer.
 */
export function windowsLock(profileFolder: string): Lock {
  let key: Promise<Buffer> | null = null;
  const theKey = () => (key ??= theAppsKey(profileFolder));

  return {
    async encrypt(plain) {
      return encryptForAppOnWindows(plain, await theKey());
    },
    async decrypt(blob) {
      return decryptFromAppOnWindows(blob, await theKey());
    },
  };
}

/**
 * Whether the key read for a profile is really the key that profile locks its own
 * state with.
 *
 * The negative control the Linux side already relies on, and the only honest
 * answer to "will the app be able to read what we are about to write": decrypt
 * something the app itself encrypted. Chromium locks its cookies with the same
 * key, so one cookie value in that profile's own store settles it. Nothing of the
 * value is read or kept; the only thing taken from it is whether it verified.
 *
 * True or null, and never false. Null is "nothing here proved it", and it covers
 * two cases that are not told apart: a profile nobody has ever signed into, which
 * has no cookies at all, and a profile whose cookies are there and none of which
 * verified. Neither is read as "the key is wrong", because only one of them means
 * that and this cannot say which. Not proved is what a caller is given.
 */
export async function provingTheKey(profileFolder: string): Promise<boolean | null> {
  const key = await theAppsKey(profileFolder);
  const cookies = await readFile(join(profileFolder, "Network", "Cookies")).catch(() => null);
  if (cookies === null) return null;

  const marker = Buffer.from(WINDOWS_VERSION, "utf8");
  for (let at = cookies.indexOf(marker); at !== -1; at = cookies.indexOf(marker, at + 1)) {
    // The stored length is not in the file, so the end is looked for: a value
    // whose tag verifies is a value, and a wrong guess cannot verify by accident.
    for (let length = 1; length <= 512 && at + 3 + NONCE_BYTES + TAG_BYTES + length <= cookies.length; length += 1) {
      try {
        decryptFromAppOnWindows(cookies.subarray(at, at + 3 + NONCE_BYTES + length + TAG_BYTES), key);
        return true;
      } catch {
        // A length that is not the length. Nothing is learned and nothing is kept.
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------ whichever ---- */

/**
 * How this machine's Claude Desktop locks the store in this profile's folder.
 *
 * The profile is an argument rather than a setting, because on Windows the key is
 * per profile and the wrong one is silently wrong.
 */
export function appLockFor(profileFolder: string): Lock {
  return ON_WINDOWS ? windowsLock(profileFolder) : macLock();
}
