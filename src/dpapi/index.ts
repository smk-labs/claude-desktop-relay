/**
 * Windows' own per-user secret box, which is what this machine has instead of a
 * Keychain.
 *
 * `CryptProtectData` locks bytes to the logged-in user's profile: another account
 * on the box cannot open them, and nor can the same bytes carried to another
 * machine. No passphrase, no prompt, and nothing for this program to hold. That
 * is the whole reason it is used rather than a file of our own with a key beside
 * it, which is the arrangement Linux was left with and which this does not have to
 * repeat.
 *
 * There is no binding for it in Node, so it is reached through PowerShell, which
 * ships with Windows. Every secret crosses on standard input and comes back on
 * standard output: never an argument and never an environment variable, because
 * both are readable by anyone who can list processes. That is the same rule the
 * Keychain side follows for the same reason.
 *
 * Batched on purpose. One PowerShell start costs a few hundred milliseconds, and
 * the Seats are read on every page refresh, so a separate call per Seat would be
 * seconds of the page sitting still. Everything here takes a list and gives
 * back a list.
 */
export type { Protected } from "./internal/protect.ts";
export { protectAll, unprotectAll, unprotectAllBytes, DPAPI_AVAILABLE } from "./internal/protect.ts";
