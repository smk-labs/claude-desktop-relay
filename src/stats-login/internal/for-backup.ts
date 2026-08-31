/**
 * Every Stats login this machine can read, as the logins themselves.
 *
 * This file breaks the rule the module opens with, and it is the only thing here
 * that does, so it is one named file rather than a flag on something else.
 * `there.ts` gives back a fingerprint precisely so a session key never leaves, and
 * that is right for every caller it has: comparing two Windows does not need the
 * value.
 *
 * A backup does. The whole point of one is that it opens on a machine that cannot
 * read these profiles, because the profiles are not there. `src/backup` already
 * makes the same exception for Send tokens and says so in its own first
 * paragraph, and the reasoning carries over unchanged: what is written is locked
 * with a passphrase the user gives, and the alternative is signing in to every
 * account again by hand on the new machine.
 *
 * So: this exists for `relay back-up-seats` and nothing else. Anything that only
 * needs to know whether a login is there wants `loginIn`.
 */
import { basename } from "node:path";

import { keyForProfile, statsLoginIn } from "./cookie-store.ts";
import type { KeptLogin } from "./kept.ts";

/** A profile that could not be read, and the sentence saying why. */
export type Unread = { readonly profile: string; readonly because: string };

export type WhatCanBeBackedUp = {
  readonly logins: readonly KeptLogin[];
  readonly unread: readonly Unread[];
};

/**
 * Read the logins out of these profile folders.
 *
 * Named by the folder, like every other reading in this module, so a login can be
 * traced back to where it came from rather than guessed at. A folder that cannot
 * be read is reported and never throws: on a machine with ten profiles, one
 * signed-out profile is not a reason to lose the nine that are signed in.
 */
export async function statsLoginsToBackUp(profileFolders: readonly string[]): Promise<WhatCanBeBackedUp> {
  const logins: KeptLogin[] = [];
  const unread: Unread[] = [];
  const seen = new Set<string>();

  for (const folder of profileFolders) {
    const profile = basename(folder);
    if (seen.has(profile)) continue;
    seen.add(profile);

    const key = await keyForProfile(folder).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    if (key instanceof Error) {
      unread.push({ profile, because: key.message });
      continue;
    }

    const read = await statsLoginIn(folder, key).catch((error: unknown) => ({
      because: error instanceof Error ? error.message : String(error),
    }));
    if (!("statsLogin" in read)) {
      unread.push({ profile, because: read.because });
      continue;
    }

    logins.push({ profile, statsLogin: read.statsLogin });
  }

  return { logins, unread };
}
