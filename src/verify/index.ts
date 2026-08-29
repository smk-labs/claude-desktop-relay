/**
 * Whether the swap actually happened, judged from the server's own answer.
 *
 * This module exists so the app can never report a success it has not checked.
 * Agreement between two Organization ids that both exist is the only route to a
 * verdict of `verified`; everything else is recorded as what it is, with the
 * reason. The last verdict is kept on disk, so "who paid last time" is answerable
 * without running anything.
 *
 * Verify answers one question, who paid, and carries whether the request also
 * succeeded alongside it. A Refusal that names the chosen Seat's own Organization
 * is proof the swap worked, and throwing that away would cost the rotation in
 * ticket 15 the only evidence it has.
 */
import { isAboutASwap, judge } from "./internal/verdict.ts";
import { openVerdictLog } from "./internal/log.ts";

import type { Exchange } from "../relay/index.ts";
import type { Verdict } from "./internal/verdict.ts";

export type { Verdict, Because, VerdictLog } from "./internal/exports.ts";
export { judge, exitCodeFor, describeVerdict, isAboutASwap } from "./internal/verdict.ts";
export { openVerdictLog } from "./internal/log.ts";

/**
 * Judge every exchange as it happens and keep the last verdict.
 *
 * This is what makes the recorded verdict real: hand the returned function to the
 * relay as its exchange callback and the file on disk is always the last thing the
 * server actually said. Every exchange carries the Seat it was charged to, so
 * nothing here has to remember anything between requests.
 */
export function watchExchanges(options: {
  file: string;
  onVerdict?: (verdict: Verdict) => void;
  /** Told when a verdict could not be kept, which must never stop the relay. */
  onProblem?: (summary: string) => void;
}): (exchange: Exchange) => void {
  const log = openVerdictLog({ file: options.file });

  return (exchange) => {
    const verdict = judge(exchange);
    options.onVerdict?.(verdict);

    // Kept only when it says something about a swap. A Code session makes many
    // requests the relay was never asked to move, and keeping the last of those
    // reports unverified moments after a swap was verified.
    if (!isAboutASwap(verdict)) return;

    // Recorded without being waited for, so it cannot slow an exchange down, and
    // caught, because a failed write must not take the relay down with it.
    void log.record(verdict).catch((error: unknown) => {
      options.onProblem?.(`the verdict could not be written: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}
