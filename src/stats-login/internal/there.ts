import { createHash } from "node:crypto";

import { keyFromKeychain, statsLoginIn } from "./cookie-store.ts";

/**
 * Whether a Desktop folder holds a claude.ai session this machine can read.
 *
 * The session never comes out. What comes back is whether there is one and a short
 * fingerprint of it, which is enough to answer "is this the same login as that one"
 * without the value leaving this module. That is the rule the module opens with, and
 * a copy check is not a reason to break it.
 */
export type LoginThere = {
  readonly held: boolean;
  /** Why there is none, or null when there is one. */
  readonly because: string | null;
  /**
   * A short hash of the session, for comparing two folders and nothing else.
   *
   * Truncated on purpose. It is enough to tell one login from another and far too
   * little to be one, so it can be printed and logged where the session cannot.
   */
  readonly fingerprint: string | null;
};

export async function loginIn(desktopFolder: string): Promise<LoginThere> {
  const key = await keyFromKeychain().catch((error: unknown) => {
    return error instanceof Error ? error : new Error(String(error));
  });
  if (key instanceof Error) return { held: false, because: key.message, fingerprint: null };

  const read = await statsLoginIn(desktopFolder, key);
  if (!("statsLogin" in read)) return { held: false, because: read.because, fingerprint: null };

  return {
    held: true,
    because: null,
    fingerprint: createHash("sha256").update(read.statsLogin).digest("hex").slice(0, 12),
  };
}
