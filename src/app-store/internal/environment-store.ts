import { rm } from "node:fs/promises";
import { join } from "node:path";

import { readJsonFile, writeJsonFile } from "../../json-file/index.ts";
import { appLockFor, type Lock } from "./safe-storage.ts";
import { THE_USERS_DESKTOP_FOLDER } from "../../home/index.ts";

/**
 * The app's own encrypted environment store.
 *
 * Almost everything the Window needs can be handed to it at launch. One variable
 * cannot: the app computes its own certificate bundle for Code sessions after it
 * has read its environment, and applies this store last, so the certificate has
 * to arrive this way or it is overwritten. See ADR 0006.
 */
export type EnvironmentStore = {
  /** Everything the store holds, ours and the user's alike. */
  read(): Promise<Record<string, string>>;
  /** Add or replace these, leaving anything else in the store alone. */
  put(variables: Readonly<Record<string, string>>): Promise<void>;
  /**
   * Remove exactly these names. The file is deleted only when nothing is left, so
   * a variable the user put there themselves survives our undo.
   */
  forget(names: readonly string[]): Promise<void>;
  readonly file: string;
};

/**
 * The store as it sits on disk. Our variables are inside `envVars`; anything else
 * at the top level belongs to the app and is carried through untouched. Rewriting
 * the file from `envVars` alone would delete whatever else the app keeps there,
 * silently.
 */
type OnDisk = { envVars?: string } & Record<string, unknown>;

/**
 * Where the app keeps it, which is inside the profile's own folder on both
 * machines. `electron-store` names it after the store, and the app names the
 * store `ccd-environment-config`.
 */
export function environmentStoreFile(support: string = THE_USERS_DESKTOP_FOLDER): string {
  return join(support, "ccd-environment-config.json");
}

export function openEnvironmentStore(options: {
  file: string;
  /**
   * How this machine's Claude Desktop locks it, opened only when it is needed.
   *
   * A lock rather than a secret, because the two machines do not agree on what
   * the secret even is: macOS stretches a key from one Keychain entry, and
   * Windows keeps a whole key beside the store wrapped for this account. Passing
   * a password would have meant one of the two lying about what it holds.
   */
  lock: Lock;
}): EnvironmentStore {
  const { file, lock } = options;

  async function read(): Promise<Record<string, string>> {
    const held = await readJsonFile<OnDisk>(file);
    if (held?.envVars === undefined || held.envVars === "") return {};

    const plain = await lock.decrypt(Buffer.from(held.envVars, "base64"));
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
    const envVars = (await lock.encrypt(JSON.stringify(variables))).toString("base64");
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

      // Nothing of ours left. The file goes only if nothing of the app's is in it
      // either; otherwise just the empty set of ours is written back.
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
