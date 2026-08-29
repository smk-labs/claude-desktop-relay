/**
 * Everything true about a Send token: how one is minted, what one looks like, and
 * which Seat one actually pays for.
 *
 * The last of those is the only one that needs the server. A Send token binds to
 * whichever Organization was active in the browser when it was minted, so a token
 * for the right account and the wrong Organization is the likeliest mistake in a
 * sitting and looks perfect from here. A Probe settles it from the server's own
 * answer, and reports it as the same Verdict the relay produces for live traffic,
 * so "verified" means one thing everywhere in this program.
 */
export type { Mint } from "./internal/mint.ts";
export { looksLikeASendToken, mintFor, whereMintingHappens } from "./internal/mint.ts";
export { probeSendToken, provesTheSeat } from "./internal/probe.ts";
