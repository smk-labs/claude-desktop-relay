import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One browser profile: a separate login, with its own cookies.
 *
 * The directory is the name the browser knows it by and the only thing that can be
 * handed to it. The label is what the user reads and renames at will, so it is
 * shown and never matched on. The account is the address the browser has on record,
 * and for the profiles that matter here it has none: a profile signed into claude.ai
 * with an email address has no Google account, so the browser records the address as
 * an empty string. Over half the profiles on a real machine read that way, which
 * is why the mapping is asked and remembered rather than worked out.
 */
export type BrowserProfile = {
  readonly directory: string;
  readonly label: string;
  readonly account: string | null;
};

/** Where Chrome keeps the list of its own profiles. */
export const WHERE_CHROME_LISTS_ITS_PROFILES = join(
  homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "Local State",
);

/**
 * A ceiling on the file, because it is somebody else's and it grows.
 *
 * 289 KB on this machine on 2026-08-23. Ten megabytes is far past anything a
 * profile list could honestly be and stops a corrupt or replaced file from being
 * read into memory whole.
 */
const AT_MOST = 10 * 1024 * 1024;

/** An address the browser left empty is no address at all. */
function blankIsNone(address: string | undefined): string | null {
  return address === undefined || address.trim() === "" ? null : address;
}

type LocalState = {
  readonly profile?: {
    readonly info_cache?: Readonly<Record<string, { readonly name?: string; readonly user_name?: string }>>;
  };
};

/**
 * Every browser profile on this machine, or nothing when the browser is not there.
 *
 * A missing file is not an error: a machine with no Chrome is a machine where every
 * link is handed over instead, which is a case the flow has to handle anyway
 * because a profile can always fail to be identified.
 */
export async function browserProfiles(options: { listedIn?: string } = {}): Promise<BrowserProfile[]> {
  const file = options.listedIn ?? WHERE_CHROME_LISTS_ITS_PROFILES;

  const how = await stat(file).catch(() => null);
  if (how === null) return [];
  if (how.size > AT_MOST) {
    throw new Error(`${file} is ${how.size} bytes, which is far too big to be a list of browser profiles`);
  }

  const read = await readFile(file, "utf8").catch(() => null);
  if (read === null) return [];

  let state: LocalState;
  try {
    state = JSON.parse(read) as LocalState;
  } catch {
    return [];
  }

  const listed = state.profile?.info_cache ?? {};
  return Object.entries(listed)
    .map(([directory, what]) => ({
      directory,
      label: what.name ?? directory,
      // Blank counts as none, and it has to: measured on a real machine on
      // 2026-08-23, every profile carries a `user_name` and over half of them carry
      // it empty. Reading an empty string as an address would make all of those look
      // identified when the browser knows nothing about them.
      account: blankIsNone(what.user_name),
    }))
    .sort((one, other) => one.directory.localeCompare(other.directory));
}

/**
 * The profiles in the order they are worth trying, likeliest first.
 *
 * An ordering and not an answer, and it decides nothing: the first of them is
 * printed as the window to have in front. So a resemblance between a label and an
 * account is allowed to move something up, which would not be allowed if opening
 * the link depended on it.
 */
export function profilesWorthTrying(options: {
  account: string;
  profiles: readonly BrowserProfile[];
}): BrowserProfile[] {
  const local = (options.account.split("@")[0] ?? "").toLowerCase();
  const bare = local.replace(/[^a-z0-9]/g, "");

  const score = (one: BrowserProfile): number => {
    const label = one.label.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (one.account?.toLowerCase() === options.account.toLowerCase()) return 0;
    if (bare !== "" && label.includes(bare)) return 1;
    if (bare !== "" && bare.includes(label) && label.length >= 4) return 2;
    if (one.account === null) return 3;
    return 4;
  };

  return [...options.profiles].sort((one, other) => score(one) - score(other) || one.directory.localeCompare(other.directory));
}
