/**
 * The one credential here that belongs to somebody else: the login the `claude`
 * command keeps for itself.
 *
 * On macOS it lives in a single Keychain entry, service `Claude Code-credentials`,
 * keyed by the OS user, and `CLAUDE_CONFIG_DIR` does not namespace it. On Windows
 * there is no Keychain and it is a file, `.credentials.json`, which that variable
 * does move; smaller danger, same question, and the same answer if it is ever
 * wrong. So minting a Send
 * token under an isolated config folder isolates every file the command writes and
 * does not isolate this. If a completed `claude setup-token` were to write here,
 * a sitting would replace the user's own login once for every Seat it filled, and
 * the first sign they would get is being logged out as somebody else.
 *
 * This module cannot fix that. What it can do is see it: read the entry's date
 * before a mint and after it, and say plainly whether it moved. It reads
 * attributes only, never the secret, so it can neither leak the login nor make
 * the Keychain ask the user for anything.
 *
 * The same shape lost every Send token on this machine on 2026-08-22: a per-run
 * action reaching
 * a machine-wide store. Once is enough.
 */
export type { AskSecurity, CliLoginReading } from "./internal/read.ts";
export {
  CLI_LOGIN_SERVICE,
  cliLoginAccount,
  cliLoginFile,
  lastChangedIn,
  readCliLogin,
  readCliLoginFromKeychain,
  readCliLoginFromFile,
} from "./internal/read.ts";
export type { Proof } from "./internal/proof.ts";
export { describeProof, safeToCarryOn, whatItProves } from "./internal/proof.ts";
