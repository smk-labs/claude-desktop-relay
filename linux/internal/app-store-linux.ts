/**
 * Claude Desktop's own encrypted environment store, as it is locked on Linux.
 *
 * One variable has to travel this way and only this way. The app computes its own
 * CA bundle for Code sessions after it has read its environment, and applies this
 * store *last*, so a certificate handed over at launch is replaced and a
 * certificate put in here survives. That is ADR 0006, and it holds on Linux for a
 * reason worth writing down, because measuring it the other way cost an hour:
 * `NODE_EXTRA_CA_CERTS` handed to the app at launch never reaches it at all here.
 * Node reads that variable, but the packaged Electron app does not: on 2026-08-25
 * the app, started with it set, wrote its bundle with 485 certificates and ours
 * was not among them. A plain `node` process on the same box does see it, which is
 * exactly the measurement that misleads.
 *
 * The scheme is Chromium's on Linux, and it is *not* the macOS one. Same cipher,
 * same salt, same fixed initialisation vector, but **one** derivation round rather
 * than 1003, and the `v11` prefix that means the key came from the login keyring
 * rather than `v10`. Getting the round count wrong produces a file the app cannot
 * read and does not complain loudly about, so the constants are proved rather than
 * trusted: `linux/internal/prove-store.ts` decrypts something the app itself
 * encrypted before anything is written.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { readJsonFile, writeJsonFile } from "../../src/json-file/index.ts";
import { DESKTOP_FOLDER } from "./where.ts";

/** Chromium's, on Linux. Not ours, and not the same as the macOS numbers. */
const VERSION = "v11";
const SALT = "saltysalt";
const ROUNDS = 1;
const KEY_BYTES = 16;
const IV = Buffer.alloc(16, 0x20);

/** Where the app keeps the store, inside the Desktop folder it was given. */
export function environmentStoreFileOn(desktopFolder: string = DESKTOP_FOLDER): string {
  return join(desktopFolder, "ccd-environment-config.json");
}

function keyFrom(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ROUNDS, KEY_BYTES, "sha1");
}

export function encryptForApp(plain: string, password: string): Buffer {
  const cipher = createCipheriv("aes-128-cbc", keyFrom(password), IV);
  return Buffer.concat([Buffer.from(VERSION, "utf8"), cipher.update(plain, "utf8"), cipher.final()]);
}

export function decryptFromApp(blob: Buffer, password: string): string {
  const prefix = blob.subarray(0, VERSION.length).toString("utf8");
  if (prefix !== VERSION) {
    throw new Error(`the store is not in the ${VERSION} form this knows how to read, it starts "${prefix}"`);
  }
  const decipher = createDecipheriv("aes-128-cbc", keyFrom(password), IV);
  return Buffer.concat([decipher.update(blob.subarray(VERSION.length)), decipher.final()]).toString("utf8");
}

/** How the login keyring names the one secret the app's store is locked with. */
export const SAFE_STORAGE = { schema: "chrome_libsecret_os_crypt_password_v2", application: "Claude" };

/**
 * The app's storage secret, out of the login keyring.
 *
 * The keyring answers over the session bus, so this needs the address of a
 * desktop session. Started over ssh there is none in the environment, and the
 * failure is worth naming rather than reporting as "no such secret": the secret
 * is there, the door is not open.
 */
export function safeStoragePassword(options: { sessionBus?: string } = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const bus = options.sessionBus ?? process.env["DBUS_SESSION_BUS_ADDRESS"];
    if (bus === undefined || bus === "") {
      reject(
        new Error(
          `there is no DBUS_SESSION_BUS_ADDRESS, so the login keyring cannot be asked for Claude Desktop's ` +
            `storage key. Run this inside the desktop session, or give it the address of one ` +
            `(unix:path=/run/user/$(id -u)/bus).`,
        ),
      );
      return;
    }

    const child = spawn(
      "secret-tool",
      ["lookup", "xdg:schema", SAFE_STORAGE.schema, "application", SAFE_STORAGE.application],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: bus } },
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", (error) => reject(error));
    // Every wait gets a ceiling. A locked keyring can leave the lookup pending
    // for as long as nobody types a password, which here is forever.
    const givingUp = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the login keyring did not answer within 20 seconds. Is it unlocked?`));
    }, 20_000);

    child.on("close", (code) => {
      clearTimeout(givingUp);
      if (code !== 0 || out === "") {
        reject(
          new Error(
            `the login keyring holds no storage key for Claude Desktop ` +
              `(${SAFE_STORAGE.schema}, application=${SAFE_STORAGE.application})` +
              `${err.trim() === "" ? "" : `: ${err.trim()}`}. It is written the first time the app runs.`,
          ),
        );
        return;
      }
      resolve(out.replace(/\n$/, ""));
    });
  });
}

/**
 * The store as it sits on disk. Ours is inside `envVars`; anything else at the top
 * level belongs to the app and is carried through untouched. Rewriting the file
 * from `envVars` alone would silently delete whatever else the app keeps there.
 */
type OnDisk = { envVars?: string } & Record<string, unknown>;

export type EnvironmentStore = {
  read(): Promise<Record<string, string>>;
  put(variables: Readonly<Record<string, string>>): Promise<void>;
  forget(names: readonly string[]): Promise<void>;
  readonly file: string;
};

export function openEnvironmentStore(options: {
  file: string;
  password: () => Promise<string>;
}): EnvironmentStore {
  const { file, password } = options;

  async function read(): Promise<Record<string, string>> {
    const held = await readJsonFile<OnDisk>(file);
    if (held?.envVars === undefined || held.envVars === "") return {};

    const plain = decryptFromApp(Buffer.from(held.envVars, "base64"), await password());
    const parsed = JSON.parse(plain) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    const variables: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") variables[name] = value;
    }
    return variables;
  }

  async function save(variables: Record<string, string>): Promise<void> {
    const held = (await readJsonFile<OnDisk>(file)) ?? {};
    const envVars = encryptForApp(JSON.stringify(variables), await password()).toString("base64");
    await writeJsonFile(file, { ...held, envVars });
  }

  return {
    file,
    read,
    async put(variables) {
      await save({ ...(await read()), ...variables });
    },
    async forget(names) {
      const held = await read();
      for (const name of names) delete held[name];

      if (Object.keys(held).length > 0) {
        await save(held);
        return;
      }
      const onDisk = (await readJsonFile<OnDisk>(file)) ?? {};
      const theirs = Object.keys(onDisk).filter((key) => key !== "envVars");
      if (theirs.length === 0) {
        await rm(file, { force: true });
        return;
      }
      await save({});
    },
  };
}
