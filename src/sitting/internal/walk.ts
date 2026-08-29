import { describeProof } from "../../cli-login/index.ts";
import type { WorklistEntry } from "../../worklist/index.ts";
import { fillOneSeat, type SeatOutcome, type WhatASittingNeeds } from "./fill.ts";

/** How a sitting went, whether it finished or was stopped halfway. */
export type SittingReport = {
  readonly filled: readonly string[];
  /** Every Seat still missing when the sitting ended, in the order it would take them. */
  readonly left: readonly string[];
  /** Why it ended early, or null when it worked through the whole list. */
  readonly stoppedBecause: string | null;
  /** Every Seat that was tried, and what came of it. */
  readonly outcomes: readonly { readonly seat: string; readonly outcome: SeatOutcome }[];
};

/**
 * Walk the Seats that still need a Send token, one at a time.
 *
 * The same function whether the list is one Seat or all of them, which is the
 * whole point of the module: a single Seat added by hand and a sitting that fills
 * every Seat are one flow, so they cannot drift apart, and an interface has one
 * thing to call.
 *
 * It advances only when the user says so, so a sitting can be paced, and it stops
 * dead the moment the `claude` command's own login turns out to have been written
 * to. That last one is not a policy choice. It is the hazard the ticket held this
 * work up for: an isolated config folder does not isolate that credential, and
 * fifteen more mints would replace the user's own login fifteen more times.
 */
export async function walkTheWorklist(
  needs: WhatASittingNeeds,
  missing: readonly WorklistEntry[],
): Promise<SittingReport> {
  const filled: string[] = [];
  const outcomes: { seat: string; outcome: SeatOutcome }[] = [];
  let stoppedBecause: string | null = null;

  for (const [at, entry] of missing.entries()) {
    const outcome = await fillOneSeat(needs, entry, `${at + 1} of ${missing.length}`);
    outcomes.push({ seat: entry.seat.name, outcome });

    if (outcome.kind === "filled" || (outcome.kind === "the-cli-login-moved" && outcome.keptTheToken)) {
      filled.push(entry.seat.name);
    }

    if (outcome.kind === "the-cli-login-moved") {
      needs.complain(``);
      needs.complain(`STOPPED, and this is the one worth stopping for.`);
      needs.complain(`Minting that Seat ${describeProof(outcome.proof)}`);
      needs.complain(
        `That entry is your own Claude Code login, and CLAUDE_CONFIG_DIR does not namespace it, ` +
          `so an isolated folder did not isolate it.`,
      );
      needs.complain(`Nothing else will be minted. Sign in with \`claude\` again if you have been logged out,`);
      needs.complain(`and please report it before running this again: it is the one failure here that touches a credential of yours.`);
      stoppedBecause = "the Claude Code login was written to";
      break;
    }

    if (outcome.kind === "stopped") {
      stoppedBecause = "you stopped it";
      break;
    }

    // One is enough: with nobody there, the next Seat cannot go any differently.
    if (outcome.kind === "nobody-is-there") {
      stoppedBecause = "nobody is at the keyboard";
      break;
    }

    const leftToDo = missing.length - (at + 1);
    if (leftToDo === 0) break;

    // Asked after every Seat, so a sitting can be paced. The first one is the
    // proof the ticket asked for: one Seat minted, the login read before and
    // after, and nothing more until the person has seen that reading.
    const carryOn = await needs.ask.carryOn({
      filledSoFar: filled.length,
      leftToDo,
      theFirstOne: at === 0,
      // The real reading, never a stand-in. Every outcome that reaches here took
      // one, and inventing a "could not be read" would be a claim about the
      // hazard pointing the wrong way.
      proof: outcome.proof,
    });
    if (!carryOn) {
      stoppedBecause = "you stopped it";
      break;
    }
  }

  // Everything that did not end up filled is still missing, whether it was never
  // reached, refused, or minted nothing. Counting them any other way is how a Seat
  // that was tried and failed drops off the list because it was reached.
  const done = new Set(filled);
  return {
    filled,
    left: missing.filter((entry) => !done.has(entry.seat.name)).map((entry) => entry.seat.name),
    stoppedBecause,
    outcomes,
  };
}

/** Whether a sitting may be resumed, or whether something has to be looked at first. */
export function mayCarryOnLater(report: SittingReport): boolean {
  return report.outcomes.every(({ outcome }) => outcome.kind !== "the-cli-login-moved");
}

/** The last lines of a sitting: what was filled, what is left, and what to do next. */
export function howItWent(report: SittingReport): readonly string[] {
  const lines = [`Filled ${report.filled.length} this sitting.`];

  if (report.left.length === 0) {
    lines.push(`Every Seat you own can now pay. Choose one with:  relay use <seat>`);
  } else {
    lines.push(`Still missing ${report.left.length}: ${report.left.join(", ")}`);
    if (mayCarryOnLater(report)) lines.push(`Run this again to carry on where you left off.`);
  }

  if (report.filled.length > 0) lines.push(`Take a backup if one was not taken:  relay back-up-seats`);
  return lines;
}
