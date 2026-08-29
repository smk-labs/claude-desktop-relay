/**
 * What a terminal said, read for the two things that matter, and the one thing
 * that must never be shown.
 *
 * Pure, and pure on purpose: the hard part of driving `claude setup-token` is
 * knowing which of its lines is the authorization link and which is the token, and
 * neither needs a process to test. `withTheTokenHidden` is here for the same
 * reason. A sitting shows the child's own lines to whoever is watching, so the
 * token has to be out of a line before it leaves this file.
 */

import { stripDressing } from "./dressing.ts";

export { stripDressing };

/**
 * The authorization link, if it has been said yet.
 *
 * Only an authorize address counts, and both hosts do. On 2026-08-23 it was
 * `https://claude.ai/oauth/authorize`; on 2026-08-24 the real run printed
 * `https://claude.com/cai/oauth/authorize`, the link went unrecognised, no browser
 * profile was opened and the sitting sat there. The host and the path in front of
 * `/oauth/authorize` are the vendor's to change, so neither is pinned.
 */
export function linkIn(said: string): string | null {
  const found = /https:\/\/claude\.(?:ai|com)\/\S*?oauth\/authorize\?[^\s"'<>]+/.exec(stripDressing(said));
  return found?.[0] ?? null;
}

/** How a Send token begins, and the characters one is made of. */
const TOKEN = "sk-ant-oat[A-Za-z0-9_-]{10,}";
/**
 * A token that is followed by something that is not part of one.
 *
 * A positive lookahead and not a negative one, and the difference is the whole
 * point: a negative lookahead is satisfied by the end of the text, so half a token
 * that is all that has arrived so far would match and be taken for the whole.
 */
const WHOLE_TOKEN = new RegExp(`${TOKEN}(?=[^A-Za-z0-9_-])`, "g");
/** The same, allowed to run to the end, for text nothing more is coming after. */
const TOKEN_TO_THE_END = new RegExp(`${TOKEN}(?![A-Za-z0-9_-])`, "g");
const TOKEN_ANYWHERE = new RegExp(TOKEN, "g");

/**
 * The Send token, if a whole one has been said yet.
 *
 * Whole is the word that matters. Output arrives in chunks of about a kilobyte and
 * a token sits a hundred characters into its line, so a read that lands in the
 * middle of one is ordinary rather than exotic. A match that runs to the end of
 * what has been said so far is therefore not a token: it is the first half of one,
 * and taking it would put a stub in the Keychain, kill the child, and lose the real
 * token for good, because a mint cannot be repeated without another sign-in.
 *
 * `theTextIsComplete` is how a caller says the child has exited and nothing more
 * is coming, which is the one case where a token at the very end is a whole one.
 *
 * The last match, not the first: a run that says the token twice, once in a
 * summary and once on its own line, has said one token.
 */
export function tokenIn(said: string, options: { theTextIsComplete?: boolean } = {}): string | null {
  const clean = stripDressing(said);
  const found = [...clean.matchAll(options.theTextIsComplete === true ? TOKEN_TO_THE_END : WHOLE_TOKEN)];
  return found.at(-1)?.[0] ?? null;
}

/**
 * A token, hidden, wherever it appears in a line meant for the screen.
 *
 * Nothing here may print a Send token. The whole point of this flow is that the
 * token goes from the terminal to the Keychain without a person or a scrollback
 * buffer ever holding it, so this runs on text that has had its escapes taken out
 * already: a reset sequence in the middle of a token is invisible on screen and
 * would carry the whole thing past a match on the raw bytes.
 */
export function withTheTokenHidden(line: string): string {
  return line.replace(TOKEN_ANYWHERE, "sk-ant-oat...(hidden)");
}
