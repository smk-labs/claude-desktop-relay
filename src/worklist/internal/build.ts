import type { AccountAsRead, CannotPay } from "../../stats-login/index.ts";
import type { ListedSeat, Multiplier, Seat } from "../../seats/index.ts";

import { seatNameFor } from "./name.ts";

/** An Organization that was read but yields no Seat, and why. */
export type Dropped = {
  readonly account: string;
  readonly label: string;
  readonly because: CannotPay;
};

/** One Seat the user owns, and whether it can pay yet. */
export type WorklistEntry = {
  readonly seat: Seat;
  /** True when a Send token for it is actually in the Keychain. */
  readonly filled: boolean;
};

export type Worklist = {
  /** Every Seat the user owns, worth the most first. */
  readonly entries: readonly WorklistEntry[];
  /** The entries still to be filled, in the order to work through them. */
  readonly missing: readonly WorklistEntry[];
  /**
   * Seats already held that no entry claims.
   *
   * Never guessed at. A Send token proves which Organization it pays for and can
   * say nothing about which account minted it (ADR 0002), and six of this user's
   * Seats share one Organization, so matching a held Seat to an entry by its
   * Organization alone would attach it to the wrong account five times out of
   * six.
   */
  readonly strays: readonly ListedSeat[];
};

/**
 * The order a sitting works through the Seats: an account's Seats together, and
 * the accounts worth the most first.
 *
 * Ordered here rather than where the Seats were discovered, so a Worklist read
 * back from an edited file is in the same order as one just discovered.
 *
 * Grouped by account because of what filling one actually costs. Every Seat needs
 * a sign-in as its account with the right Organization active, and the sign-in is
 * the slow part: with the Seats sorted by Multiplier alone, one account's Seats
 * ended up scattered down the list and meant signing back into some accounts three
 * separate times. Keeping
 * an account's Seats together means signing in once and then only switching
 * Organization, which is a click.
 *
 * Within that, worth the most first, twice over: the account holding the single
 * best Seat comes first, and inside each account the best Seat comes first. So a
 * sitting that stops halfway has still filled the Seats that matter. Ties break by
 * name, so the order is the same on every run and "carry on where I left off"
 * means the same thing each time.
 */
function inTheOrderToFillThem(wanted: readonly Seat[]): Seat[] {
  const best = new Map<string, number>();
  for (const seat of wanted) {
    best.set(seat.account, Math.max(best.get(seat.account) ?? 0, seat.multiplier));
  }

  return [...wanted].sort(
    (one, other) =>
      (best.get(other.account) ?? 0) - (best.get(one.account) ?? 0) ||
      one.account.localeCompare(other.account) ||
      other.multiplier - one.multiplier ||
      one.name.localeCompare(other.name),
  );
}

/**
 * A Multiplier for a Seat whose tier the server named in words nothing here
 * recognises. Pro, so it is neither dropped as worthless nor ranked above Seats
 * that are known to be worth more.
 */
const WHEN_UNKNOWN: Multiplier = 1;

/**
 * Turn what the logins said into the Seats the user owns.
 *
 * An Organization that cannot pay is not dropped silently: it comes back under
 * `dropped` with the reason, because "here is what you own" and "here is what you
 * own, and these Organizations were skipped because they are free" are different
 * answers
 * and only one of them lets the user check the work.
 */
export function seatsFrom(accounts: readonly AccountAsRead[]): {
  wanted: Seat[];
  dropped: Dropped[];
  guessed: string[];
} {
  const wanted: Seat[] = [];
  const dropped: Dropped[] = [];
  const guessed: string[] = [];

  for (const account of accounts) {
    for (const organization of account.organizations) {
      if (organization.cannotPay !== null) {
        dropped.push({ account: account.account, label: organization.label, because: organization.cannotPay });
        continue;
      }

      const where = { id: organization.id, label: organization.label };
      const name = seatNameFor(account.account, where);

      // A Seat has to carry a number, but a made-up one must never pass for a
      // measured one. The Seats it was guessed for come back by name so the flow
      // can say which, rather than ranking them silently against Seats whose
      // capacity is actually known.
      if (organization.multiplier === null) guessed.push(name);

      wanted.push({
        name,
        account: account.account,
        organization: where,
        multiplier: organization.multiplier ?? WHEN_UNKNOWN,
      });
    }
  }

  return { wanted, dropped, guessed };
}

/**
 * The Worklist as it stands: what is owned, against what is actually held.
 *
 * Which Seats are filled is worked out fresh every time rather than remembered,
 * so a token added or lost between two runs is noticed without anything being
 * told about it. That is also what makes the flow resumable: there is no
 * progress to keep, only a Keychain to look in.
 */
export function buildWorklist(options: {
  wanted: readonly Seat[];
  held: readonly ListedSeat[];
}): Worklist {
  const seen = new Map<string, Seat>();
  for (const seat of options.wanted) {
    const clash = seen.get(seat.name);
    if (clash !== undefined) {
      throw new Error(
        `two Seats would both be called "${seat.name}": ${clash.account} in ${clash.organization.id}, ` +
          `and ${seat.account} in ${seat.organization.id}. One would overwrite the other's Send token, ` +
          `so nothing has been done. Rename one of them in the Worklist file and run this again.`,
      );
    }
    seen.set(seat.name, seat);
  }

  const filled = new Set(options.held.filter((seat) => seat.hasSendToken).map((seat) => seat.name));

  const entries = inTheOrderToFillThem(options.wanted).map((seat) => ({
    seat,
    filled: filled.has(seat.name),
  }));

  return {
    entries,
    missing: entries.filter((entry) => !entry.filled),
    strays: options.held.filter((seat) => !seen.has(seat.name)),
  };
}
