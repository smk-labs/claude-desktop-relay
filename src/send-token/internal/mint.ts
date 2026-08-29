import { join } from "node:path";

/**
 * How a Send token begins, and how it is told apart from the other credentials
 * the user could paste by mistake.
 *
 * A Stats login (`sk-ant-sid…`) and an API key (`sk-ant-api…`) both look close
 * enough to accept by eye, and neither can pay for a request. Catching that here
 * turns a puzzle a week later into a sentence now.
 */
const BEGINS = "sk-ant-oat";

export function looksLikeASendToken(text: string): boolean {
  return text.trim().length > BEGINS.length + 4 && text.trim().startsWith(BEGINS);
}

/** Where a Send token is minted, and the command that mints it. */
export type Mint = {
  /** An isolated config folder, so the machine's own Claude Code login is untouched. */
  readonly folder: string;
  /** The exact line to paste, ready to run. */
  readonly command: string;
};

/**
 * The one command only the user can run, made exact so nothing has to be
 * remembered or invented.
 *
 * `CLAUDE_CONFIG_DIR` is the whole point: without it `claude setup-token` writes
 * into `~/.claude` and the machine's own login is replaced by whichever account
 * the user happened to be filling a Seat for. The folder is under our own home,
 * so removing this program removes every trace of the minting too.
 *
 * Quoted, and absolute rather than written with a tilde, because this line is
 * pasted into a shell that may sit in another directory and may expand nothing.
 */
export function mintFor(options: { under: string; seat: string }): Mint {
  const folder = join(whereMintingHappens(options.under), options.seat);
  return { folder, command: `CLAUDE_CONFIG_DIR="${folder}" claude setup-token` };
}

/**
 * The one folder every mint happens under.
 *
 * Named on its own because abandoning the flow halfway has to leave nothing
 * behind, and the only way to promise that is for the flow to be able to remove
 * the whole thing without knowing which Seats it got to.
 */
export function whereMintingHappens(under: string): string {
  return join(under, "mint");
}
