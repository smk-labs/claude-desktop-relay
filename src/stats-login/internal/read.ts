import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import { accountFrom, askClaudeAi, type Ask } from "./bootstrap.ts";
import { keyForProfile, statsLoginIn } from "./cookie-store.ts";
import { keepStatsLogins, keptStatsLogins, type KeptLogin } from "./kept.ts";
import { askClaudeAiForUsage, usageFrom, type AskUsage } from "./usage.ts";
import type { AccountAsRead, AccountUnread, OrganizationAsRead, WhatWasRead } from "./read-shapes.ts";

/**
 * Where the old Stats logins were put when claude-deck was retired, one folder
 * per account. This is the default and not a rule: any folder of Claude Desktop
 * profiles reads the same way, including the live one.
 */
export const WHERE_THE_STATS_LOGINS_ARE = join(homedir(), ".claude-legacy-backup", "2026-08-21", "profiles");

/**
 * Every Seat the user owns, discovered rather than typed.
 *
 * Two things are passed in rather than reached for, and both are why this can be
 * tested without a Keychain or a network: the key the stores are locked with, and
 * the asking of claude.ai. In real use both have exactly one implementation, so
 * the seam exists for the test and the module is honest about that.
 *
 * A Stats login that cannot be read never stops the others. It comes back under
 * `unread` with its reason, because a sitting that quietly covers some of the
 * Seats is worse than one that covers the same Seats and says which it missed.
 */
export async function readAccounts(options: {
  folder?: string;
  /**
   * Profile directories to read besides the ones in `folder`, named in full.
   *
   * The backup folder is a snapshot, and a snapshot goes stale: the login for
   * `cy` in it was signed out, so that Seat read "unknown" while the very
   * same account sat signed in and current in the Window the user works in. A
   * Claude Desktop folder has the same three files a Stats login needs, so it can
   * simply be read, and it is the freshest copy there is.
   *
   * Read only, and never written to. A folder that holds no login is reported as
   * unread like any other rather than stopping the run.
   */
  alsoProfiles?: readonly string[];
  keyFor?: (profileFolder: string) => Promise<Buffer>;
  /**
   * Also use the Stats logins this machine has kept, and prefer them.
   *
   * Off unless a caller asks, and asked for by the two commands that want it. It
   * exists for one Windows fact: Claude Desktop holds a profile's cookie store
   * open while it runs, so a profile that is open cannot be read where it lives.
   * See `internal/kept.ts`.
   *
   * Off by default rather than on, and that is not a preference. It reads real
   * credentials from a real file in the user's home, and a default of "on" meant
   * the test suite read ten of the user's own Stats logins and asserted against
   * them. No test in this suite may reach a real credential, and the way that
   * rule is kept is that reaching one is something a caller has to say.
   */
  alsoKept?: boolean;
  /** Where those are kept. An argument so a test can hold its own. */
  keptIn?: string;
  ask?: Ask;
  /**
   * Also read what each Seat has spent. Off by default: it is one more request
   * per Organization, and the caller that wants the list of Seats does not want
   * to pay for spending it will not read.
   */
  alsoWhatWasSpent?: boolean;
  askUsage?: AskUsage;
}): Promise<WhatWasRead> {
  const folder = options.folder ?? WHERE_THE_STATS_LOGINS_ARE;
  const ask = options.ask ?? askClaudeAi;

  /**
   * A folder that is not there is remembered rather than thrown, and thrown only
   * if it turns out to have been the only source.
   *
   * It used to throw at once, which was right when a folder of profiles was the
   * only place a Stats login could come from. There are three now, and a machine
   * that has never had the snapshot folder would otherwise be told it has no
   * logins at all while holding ten.
   */
  let noFolder: string | null = null;
  const profiles = await readdir(folder, { withFileTypes: true }).catch((error: unknown) => {
    noFolder = `there are no Stats logins to read at ${folder}: ${error instanceof Error ? error.message : String(error)}`;
    return [];
  });

  const fromFolder = profiles
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ profile: entry.name, at: join(folder, entry.name) }))
    .sort((a, b) => a.profile.localeCompare(b.profile));

  /**
   * Named by their folder rather than by an invented label, so a reading can be
   * traced back to the profile it came from without guessing.
   */
  const alsoNamed = (options.alsoProfiles ?? []).map((at) => ({ profile: basename(at), at }));

  // A profile reached twice is read once. The extra sources are the fresher copy,
  // so where a name collides they are the ones kept.
  const byName = new Map<string, { profile: string; at: string }>();
  for (const one of [...fromFolder, ...alsoNamed]) byName.set(one.profile, one);

  /**
   * The logins this machine has kept, which are read before any profile is opened.
   *
   * They win where a name collides, for the same reason `alsoProfiles` wins over
   * the snapshot folder: a login that was kept was readable, and a profile that
   * is open cannot be read at all.
   */
  const kept = new Map<string, string>();
  if (options.alsoKept === true) {
    const held = options.keptIn === undefined ? await keptStatsLogins().catch(() => []) : await keptStatsLogins(options.keptIn).catch(() => []);
    for (const one of held) kept.set(one.profile, one.statsLogin);
    for (const profile of kept.keys()) if (!byName.has(profile)) byName.set(profile, { profile, at: "" });
  }

  const names_ = [...byName.values()];
  if (names_.length === 0) {
    if (noFolder !== null) throw new Error(noFolder);
    return { accounts: [], unread: [] };
  }

  const keyFor = options.keyFor ?? keyForProfile;
  const accounts: AccountAsRead[] = [];
  const unread: AccountUnread[] = [];
  /**
   * A login read out of a profile is kept, so the next run does not need that
   * profile to be closed.
   *
   * This is what closes the Windows loop. A profile that is open cannot be read,
   * so without it the answer for the Window the user works in is "unknown" every
   * time except the once they happened to have it shut. Read it once while it is
   * closed and it is answered from then on.
   *
   * Only where the caller already asked for the kept store, so nothing writes a
   * credential anywhere on the strength of a default.
   */
  const worthKeeping: KeptLogin[] = [];

  for (const { profile, at } of names_) {
    const wasKept = kept.get(profile);
    const held = wasKept !== undefined
      ? { statsLogin: wasKept }
      // Asked for one profile at a time, and only where a login has to be
      // unlocked, so a run that is answered entirely from what is kept never
      // reaches the machine's own secret store at all.
      : await keyFor(at).then(
          (key) => statsLoginIn(at, key),
          (error: unknown) => ({ because: error instanceof Error ? error.message : String(error) }),
        );

    if ("because" in held) {
      unread.push({ profile, because: held.because });
      continue;
    }
    if (wasKept === undefined && options.alsoKept === true) {
      worthKeeping.push({ profile, statsLogin: held.statsLogin });
    }

    try {
      const read = accountFrom(await ask(held.statsLogin));
      const organizations = options.alsoWhatWasSpent
        ? await whatWasSpent(read.organizations, held.statsLogin, options.askUsage ?? askClaudeAiForUsage)
        : read.organizations;
      accounts.push({ profile, account: read.account, organizations });
    } catch (error) {
      unread.push({ profile, because: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Kept at the end rather than one at a time, because locking them is one call
   * to Windows for the whole list and one call per login would run into seconds.
   *
   * A failure here is not a failure of the reading: what was read is still what
   * is returned, and the only cost is that the next run has to read it again.
   */
  if (worthKeeping.length > 0) {
    await (options.keptIn === undefined
      ? keepStatsLogins(worthKeeping)
      : keepStatsLogins(worthKeeping, options.keptIn)
    ).catch(() => 0);
  }

  return { accounts, unread };
}

/**
 * Attach what each Organization has spent, leaving the rest of the reading intact.
 *
 * One Organization refusing never costs the others their spending, and never
 * costs this account its Seats: it comes back with `usage` null, which every
 * consumer already has to handle because a Seat can be read without its spending
 * at all. An expired login is a different matter and is caught by the caller,
 * because then nothing about this account was read.
 */
async function whatWasSpent(
  organizations: readonly OrganizationAsRead[],
  statsLogin: string,
  askUsage: AskUsage,
): Promise<OrganizationAsRead[]> {
  const filled: OrganizationAsRead[] = [];
  for (const organization of organizations) {
    // An Organization that yields no Seat has no spending worth asking for, and
    // asking would be one wasted request per free or API-only Organization: nine
    // of this user's twenty-five.
    if (organization.cannotPay !== null) {
      filled.push(organization);
      continue;
    }
    const usage = await askUsage(statsLogin, organization.id).then(usageFrom, () => null);
    filled.push({ ...organization, usage });
  }
  return filled;
}
