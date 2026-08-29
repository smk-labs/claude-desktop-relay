import { bestFirst, consider, type Considered } from "./rank.ts";

import type { Mode } from "../../payer/index.ts";
import type { ListedSeat } from "../../seats/index.ts";
import type { SeatUsage } from "../../usage/index.ts";

/** Why this Seat, or why none. Reasons as reasons, never as prose. */
export type Because =
  /** Auto weighed them and this one came out on top. */
  | "it-had-the-most-room"
  /** Manual, and the Seat the user picked can pay. */
  | "the-user-picked-it"
  /** Off. Nothing is swapped and the Window account pays, as if uninstalled. */
  | "it-is-off"
  /** Manual, and the Seat the user picked cannot pay. */
  | "the-picked-seat-cannot-pay"
  /** No Seats at all, or none with a Send token. */
  | "no-seat-can-pay"
  /** Every Seat is free, on cooldown, or has nothing left. */
  | "no-seat-has-room";

/**
 * One Seat, and why.
 *
 * `seat` is null for the Window account, which is always a legitimate answer: the
 * spec's rule is that the relay falls back to it and says so, never that it fails.
 */
export type Pick = {
  readonly seat: string | null;
  readonly because: Because;
  /**
   * Every Seat that was weighed, worth the most first, with what was known at the
   * time. Kept so that "why did it pick that one" has an answer later, rather than
   * being recomputed against figures that have since moved.
   */
  readonly considered: readonly Considered[];
};

/**
 * Choose who pays. Pure: no I/O, no clock, and the moment is an argument.
 *
 * The whole ranking rule is here and only here, which is what makes it a table in
 * a test rather than something that has to be reasoned about against a live
 * machine. Nothing in this file reads a file, asks a server or looks at a clock.
 */
export function choose(options: {
  readonly seats: readonly ListedSeat[];
  readonly usage: readonly SeatUsage[];
  readonly mode: Mode;
  /** The Seat the user picked by hand, or null when they have not. */
  readonly picked: string | null;
  /** The model the request asked for, or null when it could not be read. */
  readonly model: string | null;
  /** Seconds since 1970. */
  readonly at: number;
}): Pick {
  const known = new Map(options.usage.map((one) => [one.seat, one] as const));
  const considered = bestFirst(
    options.seats.map((seat) =>
      consider({ seat, usage: known.get(seat.name), model: options.model, at: options.at }),
    ),
  );

  if (options.mode === "off") return { seat: null, because: "it-is-off", considered };

  if (options.mode === "manual") {
    /**
     * The user's own choice, checked but never overridden.
     *
     * A deliberate pick is not something the app gets to second-guess (story 6),
     * so a Seat that can pay is used whatever its score says. What is refused is a
     * pick that cannot pay at all, and then the Window account is the answer with
     * that as the reason rather than a different Seat chosen on the user's behalf.
     */
    const wanted = considered.find((one) => one.seat === options.picked);
    if (options.picked === null) return { seat: null, because: "it-is-off", considered };
    if (wanted === undefined || wanted.ruledOut !== null) {
      return { seat: null, because: "the-picked-seat-cannot-pay", considered };
    }
    return { seat: options.picked, because: "the-user-picked-it", considered };
  }

  const candidates = considered.filter((one) => one.ruledOut === null);
  if (candidates.length === 0) {
    // Told apart on purpose. "You own no Seat that could ever pay" and "every Seat
    // you own is spent or resting" send a reader to two different places.
    const anyCouldEverPay = considered.some((one) => one.ruledOut !== "free" && one.ruledOut !== "no-send-token");
    return { seat: null, because: anyCouldEverPay ? "no-seat-has-room" : "no-seat-can-pay", considered };
  }

  const best = candidates[0]!;
  // A score of zero means both windows are spent, or the week is. Picking it would
  // be picking a Seat we already know will refuse.
  if (best.score <= 0) return { seat: null, because: "no-seat-has-room", considered };

  return { seat: best.seat, because: "it-had-the-most-room", considered };
}

const REASONS: Record<Because, string> = {
  "it-had-the-most-room": "it had the most room of any Seat that can pay",
  "the-user-picked-it": "you picked it",
  "it-is-off": "nothing is being swapped, so the Window account pays",
  "the-picked-seat-cannot-pay": "the Seat you picked cannot pay, so the Window account is paying instead",
  "no-seat-can-pay": "no Seat you own can pay, so the Window account is paying",
  "no-seat-has-room": "every Seat you own is spent or resting, so the Window account is paying",
};

/**
 * One plain sentence, built when it is read rather than when it is decided.
 *
 * Nothing recorded anywhere is English, so rewording this does not rewrite a
 * record that was already kept.
 */
export function describePick(pick: Pick): string {
  return pick.seat === null ? `the Window account: ${REASONS[pick.because]}.` : `${pick.seat}: ${REASONS[pick.because]}.`;
}
