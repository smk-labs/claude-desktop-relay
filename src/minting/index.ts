/**
 * Minting a Send token by driving `claude setup-token`, rather than printing a
 * command and asking somebody to paste the answer back.
 *
 * Three things were measured on 2026-08-23 and this module is shaped by all
 * three. The command writes to a terminal or writes nothing, so it runs under a
 * pseudo-terminal and not a pipe. It opens the authorization link itself, in
 * whatever profile the machine defaults to, which is the wrong one often enough to
 * matter. And it offers no non-interactive mode to ask for instead.
 *
 * What a person is needed for leaves here as two calls, `link` and `heard`, and
 * nothing else. So this module never writes to a screen, never reads a keyboard,
 * and the same function drives a sitting at a terminal and a page in an interface.
 * The token leaves only as the return value: it is never printed, never passed to
 * the line watcher, and never written to a file by us.
 */
export type { MintOne, MintOutcome } from "./internal/mint.ts";
export { MINTS, mintOneToken } from "./internal/mint.ts";
export type { OpenATerminal, TerminalEnd, TerminalSession } from "./internal/terminal.ts";
export { underATerminal } from "./internal/terminal.ts";
/**
 * On the interface so the rule it encodes can be held to, rather than only
 * exercised by whichever argument a real mint happens to carry.
 *
 * `claude setup-token` is one word with no space, quote or backslash in it, so
 * this could be wrong in every interesting way and every real mint would still
 * work. A guard that only ever sees the easy case is not a guard.
 */
export { asOneArgument } from "./internal/windows-terminal.ts";
/**
 * On the interface because what a mint may inherit is a claim about identity, and
 * a claim like that is worth a test of its own rather than a comment.
 */
export { environmentForAMint, WHAT_MAY_PASS } from "./internal/environment.ts";
/**
 * On the interface because a sitting shows the child's own lines to whoever is
 * watching, and every one of them has to have the token taken out first.
 */
export { linkIn, stripDressing, tokenIn, withTheTokenHidden } from "./internal/watch.ts";
