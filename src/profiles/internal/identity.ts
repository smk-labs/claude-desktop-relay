/**
 * Which account a profile is signed in as.
 *
 * A profile's own store says the account's UUID and holds its OAuth tokens, and
 * nothing on disk anywhere says the email address. So the name is asked for, once
 * in a while, with that profile's own token: `GET /api/oauth/profile` answers with
 * the account and the Organization it belongs to.
 *
 * Three rules, and all three are about not making this worse than the question it
 * answers. The token is read, used and dropped: it is never written anywhere, never
 * logged, and never handed to anything outside this file. The call has a ceiling,
 * because a page must not wait on the network. And an answer that does not arrive
 * leaves the profile saying "signed in" with no name, which is the truth, rather
 * than a name carried over from a profile that was read earlier.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { appLockFor } from "../../app-store/index.ts";

/** Who a profile is signed in as, as the server itself says it. */
export type Account = {
  readonly email: string;
  /** The Organization that account is working in, by name. */
  readonly organization: string | null;
  /** So an answer can be checked against the account the profile last signed in as. */
  readonly uuid: string | null;
};

/** Long enough that this is not a poll, short enough that a sign-out is noticed. */
export const A_NAME_KEEPS_FOR = 30 * 60_000;

/** A page must never wait on the network. Four seconds, then it is not known. */
const A_CALL_HAS_THIS_LONG = 4000;

/** Where the app asks the same question. */
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

/**
 * Every token in the cache, in the order the store holds them.
 *
 * The keys look like `<uuid>:<organization>:<audience>:<scopes>`, and that first
 * UUID is tempting to read as the account. It is not: measured 2026-08-25, it
 * matched neither `lastKnownAccountUuid` nor the account the server named for that
 * very token, and filtering on it found nothing at all. So nothing here parses the
 * key. The tokens are tried and the server says whose they are, which is the only
 * source that was ever going to be right.
 */
export function tokensFrom(cache: unknown): readonly string[] {
  if (typeof cache !== "object" || cache === null) return [];
  const tokens: string[] = [];
  for (const held of Object.values(cache as Record<string, unknown>)) {
    const token = (held as { token?: unknown }).token;
    if (typeof token === "string" && token !== "" && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

/** The account out of the server's answer, and nothing else from it. */
export function accountFrom(answer: unknown): Account | null {
  if (typeof answer !== "object" || answer === null) return null;
  const account = (answer as { account?: { email?: unknown; uuid?: unknown } }).account;
  const organization = (answer as { organization?: { name?: unknown } }).organization;
  if (typeof account?.email !== "string") return null;
  const uuid = (account as { uuid?: unknown }).uuid;
  return {
    email: account.email,
    organization: typeof organization?.name === "string" ? organization.name : null,
    uuid: typeof uuid === "string" ? uuid : null,
  };
}

/** The account UUID this profile last signed in as, or null when nobody has. */
export async function signedInAs(folder: string): Promise<string | null> {
  const config = await readFile(join(folder, "config.json"), "utf8").catch(() => "");
  if (config === "") return null;
  try {
    const held = JSON.parse(config) as Record<string, unknown>;
    const uuid = held["lastKnownAccountUuid"];
    return typeof uuid === "string" && uuid !== "" ? uuid : null;
  } catch {
    return null;
  }
}

/**
 * The account a profile is signed in as, asked for with that profile's own token.
 *
 * Null whenever it cannot be answered: nobody signed in, no token for that account,
 * the store would not decrypt, the call failed, or it took too long. Every one of
 * those is "not known", and the page says exactly that.
 */
export async function readAccount(folder: string): Promise<Account | null> {
  const uuid = await signedInAs(folder);
  if (uuid === null) return null;

  const tokens = await (async () => {
    try {
      const config = JSON.parse(await readFile(join(folder, "config.json"), "utf8")) as Record<string, unknown>;
      const held = config["oauth:tokenCacheV2"] ?? config["oauth:tokenCache"];
      if (typeof held !== "string" || held === "") return [];
      /**
       * Opened with that profile's own lock, which is not the same thing on the
       * two machines: one Keychain secret covers every profile on macOS, and on
       * Windows each profile keeps its own key beside its own store. Asking for
       * the lock by folder is what keeps this one line right on both.
       */
      return tokensFrom(JSON.parse(await appLockFor(folder).decrypt(Buffer.from(held, "base64"))));
    } catch {
      return [];
    }
  })();

  /**
   * At most this many tokens are tried. A profile holds one or two; a cache that
   * somehow held twenty must not become twenty calls every half hour.
   */
  let held: Account | null = null;
  for (const token of tokens.slice(0, 3)) {
    const account = await ask(token);
    if (account === null) continue;
    // The account this profile last signed in as wins outright; anything else is
    // kept only in case no token belongs to it.
    if (account.uuid === uuid) return account;
    held ??= account;
  }
  return held;
}

/** One call, with its ceiling. Null for every way it can fail to answer. */
async function ask(token: string): Promise<Account | null> {
  try {
    const answer = await fetch(PROFILE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(A_CALL_HAS_THIS_LONG),
    });
    if (!answer.ok) return null;
    return accountFrom(await answer.json());
  } catch {
    return null;
  }
}
