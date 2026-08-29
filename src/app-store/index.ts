/**
 * The app's own encrypted environment store, and the one variable that has to go
 * through it.
 *
 * The Window builds each Code session's environment from its own environment
 * first, then its computed values, then this store last. So a variable the app
 * computes for itself, which the certificate is, survives only if it arrives this
 * way. Everything else is handed over at launch instead. ADR 0006.
 *
 * The store belongs to the app, not to us: anything else in it is carried through
 * untouched, and the undo command removes only the names below.
 */
import { openEnvironmentStore, environmentStoreFile, type EnvironmentStore } from "./internal/environment-store.ts";
import { appLockFor } from "./internal/safe-storage.ts";

export type { EnvironmentStore } from "./internal/environment-store.ts";
export { openEnvironmentStore, environmentStoreFile } from "./internal/environment-store.ts";
export type { Lock } from "./internal/safe-storage.ts";
export {
  safeStoragePassword,
  SAFE_STORAGE,
  macLock,
  windowsLock,
  appLockFor,
  theAppsKey,
  localStateFile,
  provingTheKey,
  encryptForApp,
  encryptForAppOnWindows,
  decryptFromAppOnWindows,
  openV10OnWindows,
} from "./internal/safe-storage.ts";

/**
 * The app's own decryption, for the other things it keeps under the same lock.
 *
 * The environment store is not the only thing in a profile's folder written this
 * way: the OAuth token cache in `config.json` is too, and reading which account a
 * profile is signed in as means opening it. Exported here rather than reached for
 * past this door, so there is still one place that knows how the app locks a file.
 */
export { decryptFromApp } from "./internal/safe-storage.ts";

/**
 * The store belonging to one Claude Desktop profile, opened the way this machine
 * locks it.
 *
 * One call, because the file and the lock are both derived from the same folder
 * and on Windows they have to be: the key lives beside the store and is that
 * profile's own. Reaching for the file and the lock separately is how a store
 * gets written under one profile's key and read under another's, which the app
 * reports as an empty store rather than as a mistake.
 */
export function openAppStore(profileFolder: string): EnvironmentStore {
  return openEnvironmentStore({ file: environmentStoreFile(profileFolder), lock: appLockFor(profileFolder) });
}

/**
 * What the store must hold for a Code session to trust the relay.
 *
 * The companion tells Node to keep trusting the machine's own roots as well, so
 * adding ours does not narrow what a Code session will talk to.
 */
export function certificateVariables(caCertificatePath: string): Readonly<Record<string, string>> {
  return { NODE_EXTRA_CA_CERTS: caCertificatePath, NODE_USE_SYSTEM_CA: "1" };
}

/**
 * Exactly the names the certificate writer above puts in the store, derived from it
 * so the two cannot drift apart.
 *
 * The undo command does not read this: it derives the whole set from the same
 * writers `install` uses, so a name added to one and not the other cannot be left
 * behind in somebody's store. This stays because it is the honest answer to "what
 * does the certificate need", and the tests hold it to that.
 */
export const CERTIFICATE_VARIABLES: readonly string[] = Object.keys(certificateVariables(""));

/**
 * What the store must hold for a Window's Code sessions to read their own Claude
 * Code configuration rather than the one every Window shares.
 *
 * Claude Code reads `~/.claude` unless this says otherwise, and that directory
 * holds the user's plugins, skills, settings and MCP servers. A relayed Window
 * that read it would start those MCP servers as children of a relayed session,
 * and every one of them would inherit the relay's address: exactly the blast
 * radius ADR 0014 removes by keeping the relayed Window empty.
 *
 * The app does not compute this name for itself and does not refuse it in the
 * store, which is why it can be set this way at all. Measured 2026-08-24: it is
 * absent from both the fixed object the app applies after the store and the ten
 * names the app's own settings writer refuses.
 */
export function codeConfigVariables(codeConfigFolder: string): Readonly<Record<string, string>> {
  return { CLAUDE_CONFIG_DIR: codeConfigFolder };
}

/** Derived from the writer above, for the same reason. */
export const CODE_CONFIG_VARIABLES: readonly string[] = Object.keys(codeConfigVariables(""));
