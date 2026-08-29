import { onCooldown } from "../../usage/index.ts";

import type { ListedSeat } from "../../seats/index.ts";
import type { AllowanceKnown, SeatUsage } from "../../usage/index.ts";

/**
 * How urgency is weighted against capacity, and why these numbers.
 *
 * The shape is the spec's: a Seat's worth is its Multiplier times what is left of
 * its week, divided by the hours until that week resets, so that allowance about
 * to be lost outranks allowance there is plenty of time to spend. Every constant
 * below is carried over from claude-deck verbatim, because they were tuned there
 * against real bills and re-deriving them here produced a ranking that sorted by
 * plan size rather than by urgency.
 */

/**
 * The exponent on "hours until the week resets".
 *
 * Two and a half, not one. Above one, urgency outweighs raw remaining capacity, so
 * a small plan resetting in hours beats a big plan resetting in days. claude-deck
 * tried 1.5 and 2 and recorded that both still ranked too much by capacity; at one,
 * which is where this module started, a 20x Seat with half a week left and four
 * days to spend it sits only two-to-one behind a 1x Seat whose week dies tonight,
 * and the five-hour term flips even that. The whole point of the ranking is that it
 * must not.
 */
const URGENCY = 2.5;

/**
 * The smallest number of hours the divisor may be.
 *
 * One hour, and it is load-bearing rather than defensive now that the exponent is
 * above one. At a five-minute floor the divisor reaches a twelfth, and a twelfth
 * raised to 2.5 is a five-hundred-fold bonus: a Seat with a sliver of allowance and
 * a reset a minute away would outrank every healthy Seat on the machine. The floor
 * and the exponent are one decision and have to move together.
 */
const MINIMUM_HOURS = 1;

/**
 * How far the five-hour window may ever move a Seat, up and down.
 *
 * A bounded multiplier, never a term of its own. The weekly part of the score spans
 * orders of magnitude, so the five-hour part may only reorder Seats whose weekly
 * scores are already close: it must never resurrect a Seat with a dead week (no
 * week left is a base of zero, and zero times anything is still zero) nor outrank a
 * clearly healthier week. The earlier ratio form here reached four, which was
 * enough to do exactly that.
 */
const MOST_GENEROUS = 1.5;

/** Weight on the share of the window a Seat is on course to sit locked out for. */
const RUNNING_OUT = 1.2;

/** Weight on the share of the window a Seat is on course to leave unspent. */
const GOING_TO_WASTE = 0.5;

/** A deep penalty, never a disqualifier: a bad pace is not the same as no Seat. */
const LEAST_GENEROUS = 0.05;

/**
 * The constants above, under names a person can read, for the page that shows them.
 *
 * Read from here rather than written down a second time. The page used to show an
 * urgency exponent of 1.00, a "multiplier weight" of 1.00 and a five-hour weight
 * of 4.00, under labels that matched no constant in this file: they were copied
 * out of the design while the exponent was still one and the five-hour part was
 * still a ratio that reached four. A number somebody reads off the screen has to
 * be the number the ranking actually used, so there is one copy of it and the page
 * imports it.
 */
export const RANKING = {
  urgencyExponent: URGENCY,
  runningOut: RUNNING_OUT,
  goingToWaste: GOING_TO_WASTE,
  mostGenerous: MOST_GENEROUS,
  leastGenerous: LEAST_GENEROUS,
} as const;

/** The five-hour Allowance window, as hours, so both windows are one arithmetic. */
const FIVE_HOURS = 5;
const A_WEEK_IN_HOURS = 7 * 24;

/**
 * What was known about one Seat when it was weighed, and what it came to.
 *
 * Every part is kept, not just the total, because "why did it pick that one" is a
 * question somebody will ask about a real bill. A score on its own cannot answer
 * it, and recomputing it later against different figures answers it wrongly.
 */
export type Considered = {
  readonly seat: string;
  readonly score: number;
  /** Null when it was weighed; a reason when it was never a candidate. */
  readonly ruledOut: RuledOut | null;
  /** The share of the week left, and whether that was known or assumed. */
  readonly weekly: { readonly remaining: number; readonly assumed: boolean };
  /** The share of the five-hour window left, and whether that was assumed. */
  readonly fiveHour: { readonly remaining: number; readonly assumed: boolean };
  /** Hours until the week resets, as used. */
  readonly hoursToWeekReset: number;
};

export type RuledOut =
  /** Free Organizations yield no allowance to spend. */
  | "free"
  | "no-send-token"
  | "on-cooldown-for-this-model"
  /** Its five-hour window is spent and has not turned over yet. */
  | "five-hour-window-spent";

/**
 * What is left of one window, and whether we actually know.
 *
 * An unknown Utilization is read as untouched, and it is worth being clear that
 * this is a choice. A Send token cannot read usage from any endpoint, so the only
 * figures that exist arrive attached to a reply the Seat already paid for: a Seat
 * with no figure is, far more often than not, a Seat nobody has used. And the cost
 * of being wrong is one Refusal, which puts that Seat on cooldown and moves the
 * work along, so the mistake corrects itself. Reading it as spent instead would
 * mean a fresh install never picks anybody.
 */
function remainingOf(known: { utilization: number; hasReset: boolean } | null): {
  remaining: number;
  assumed: boolean;
} {
  if (known === null) return { remaining: 1, assumed: true };
  return { remaining: known.hasReset ? 1 : Math.max(0, Math.min(1, 1 - known.utilization)), assumed: false };
}

/**
 * Hours until this window next resets.
 *
 * The whole window when the moment was never stated, and also when the moment
 * stated has already passed: a reset that has happened means the window turned
 * over and the next one is a whole window away. Reading a passed moment as "resets
 * in no time at all" made a Seat with a completely fresh week look like the most
 * urgent thing on the machine, which is the opposite of true.
 */
function hoursUntilReset(resetsAt: number | null, at: number, wholeWindow: number): number {
  if (resetsAt === null) return wholeWindow;
  const left = (resetsAt - at) / 3600;
  return left <= 0 ? wholeWindow : left;
}

/**
 * How much of the five-hour window is still ahead, as a share of it.
 *
 * The reset moment is what says this, and when the Seat never stated one there are
 * two different silences. A Seat nothing has been spent on has no window running at
 * all: using it starts a fresh one, so the whole window is ahead. A Seat that has
 * spent something but named no reset is mid-window somewhere and half is the only
 * honest guess. Reading both as a full window ahead made a half-spent Seat look
 * like it was pacing perfectly.
 */
function aheadShareOf(fiveHour: AllowanceKnown | null, at: number): number {
  if (fiveHour === null) return 1;
  if (fiveHour.resetsAt === null) return fiveHour.utilization > 0 && !fiveHour.hasReset ? 0.5 : 1;
  return Math.min(1, Math.max(0, hoursUntilReset(fiveHour.resetsAt, at, FIVE_HOURS) / FIVE_HOURS));
}

/**
 * How the five-hour window adjusts a Seat's worth.
 *
 * A Seat with more allowance left than time to spend it is about to lose the
 * difference, and that is capacity worth using now. A Seat with less allowance than
 * time is on course to lock out before its window turns over, and sending more work
 * to it brings the lockout forward. So the two shares are compared rather than
 * either being read on its own, and the comparison is a straight difference each
 * way, weighted, exactly as claude-deck did it.
 *
 * A fresh window sits at neither: all the allowance and all the time, difference
 * zero, factor one. That is what keeps the weekly signal the thing doing the
 * ranking. The floor is a deep penalty rather than a nought, because a bad pace is
 * a reason to prefer somebody else and not a reason a Seat cannot be used at all;
 * a Seat with a genuinely dead week is already zero from the weekly term.
 */
function paceFrom(remaining: number, aheadShare: number): number {
  const runningOut = Math.max(0, aheadShare - remaining);
  const goingToWaste = Math.max(0, remaining - aheadShare);
  const factor = 1 - RUNNING_OUT * runningOut + GOING_TO_WASTE * goingToWaste;
  return Math.min(MOST_GENEROUS, Math.max(LEAST_GENEROUS, factor));
}

/**
 * Whether the five-hour window we know about is spent, and still running.
 *
 * This is a rule-out and not a penalty, and that is the correction. The pace
 * factor below is bounded on purpose so that the five-hour window may only
 * reorder Seats whose weekly scores are close, and a bound cannot express "this
 * Seat cannot serve a single request right now". Measured on 2026-08-26: a Seat
 * reading 102% of its five-hour window, with an hour and a half still to run,
 * scored a pace of 0.69 and stayed top of the ranking for six hours and 2,250
 * requests while every other Seat with a fresh window sat idle. A 31% penalty is
 * not
 * what "locked out" means.
 *
 * Ruled out until the window turns over, exactly as a Refusal's cooldown would
 * be, because it is the same fact learned a request earlier. `hasReset` already
 * reads a passed reset as a fresh window, so a Seat leaves this state on its own.
 *
 * When the Seat never stated a reset there is no moment to wait for, so the
 * reading is only trusted for as long as a window lasts. Beyond that it is a
 * figure about a window that has almost certainly ended, and reading it as a
 * lockout would retire a Seat on the strength of yesterday.
 */
function fiveHourIsSpent(fiveHour: AllowanceKnown | null): boolean {
  if (fiveHour === null || fiveHour.hasReset || fiveHour.utilization < 1) return false;
  return fiveHour.resetsAt !== null || fiveHour.ageSeconds < FIVE_HOURS * 3600;
}

/** Weigh one Seat, or say why it was never in the running. */
export function consider(options: {
  seat: ListedSeat;
  usage: SeatUsage | undefined;
  model: string | null;
  at: number;
}): Considered {
  const { seat, usage, at } = options;
  const weekly = remainingOf(usage?.sevenDay ?? null);
  const fiveHour = remainingOf(usage?.fiveHour ?? null);
  const hoursToWeekReset = hoursUntilReset(usage?.sevenDay?.resetsAt ?? null, at, A_WEEK_IN_HOURS);

  const bare = { seat: seat.name, weekly, fiveHour, hoursToWeekReset };

  const ruledOut: RuledOut | null =
    seat.multiplier === 0
      ? "free"
      : !seat.hasSendToken
        ? "no-send-token"
        : usage !== undefined && onCooldown(usage, options.model, at)
          ? "on-cooldown-for-this-model"
          : fiveHourIsSpent(usage?.fiveHour ?? null)
            ? "five-hour-window-spent"
            : null;

  if (ruledOut !== null) return { ...bare, score: 0, ruledOut };

  const urgency = 1 / Math.max(MINIMUM_HOURS, hoursToWeekReset) ** URGENCY;
  const pace = paceFrom(fiveHour.remaining, aheadShareOf(usage?.fiveHour ?? null, at));

  return { ...bare, ruledOut: null, score: seat.multiplier * weekly.remaining * urgency * pace };
}

/**
 * Worth the most first, and the same order every time.
 *
 * The tie-breaks are not decoration. Two Seats of the same Multiplier that nothing
 * is known about score identically, which on a real machine is several Seats at a
 * time, and an unstable order there would move the Payer between requests of one
 * conversation and throw away prompt caching for no reason at all (ADR 0003).
 */
export function bestFirst(considered: readonly Considered[]): Considered[] {
  return [...considered].sort((a, b) => b.score - a.score || a.seat.localeCompare(b.seat));
}
