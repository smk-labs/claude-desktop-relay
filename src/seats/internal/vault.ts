/**
 * Where secrets live. One name in, one secret out.
 *
 * Four adapters satisfy it: the Keychain on macOS, `CryptProtectData` on Windows,
 * a locked file on Linux, and an in-memory one the tests use so nothing in the
 * suite ever touches a real secret store.
 */
export type Vault = {
  put(name: string, secret: string): Promise<void>;
  /** The secret, or null when there is none under that name. */
  get(name: string): Promise<string | null>;
  forget(name: string): Promise<void>;
};
