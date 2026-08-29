import type { Seat } from "../../seats/index.ts";

/**
 * One thing that is no longer true about a Seat already held.
 *
 * A list of differences rather than a write, so the flow can show the user what
 * it is about to change and so a refresh that reads badly changes nothing. A plan
 * change is rare and a Seat quietly losing its Multiplier is expensive: every
 * comparison after it is arithmetic on a stale number.
 */
export type Change =
  | { readonly kind: "multiplier"; readonly seat: Seat; readonly was: number; readonly now: number }
  | { readonly kind: "label"; readonly seat: Seat; readonly was: string; readonly now: string }
  /** Owned, and no Send token held for it. The flow to fill one is ticket 16's. */
  | { readonly kind: "unheld"; readonly seat: Seat }
  /**
   * Held, and the account's own login no longer lists it.
   *
   * Never acted on without the user, and never inferred from a login that could
   * not be read: those two cases look identical from here and only one of them
   * means the Seat is gone.
   */
  | { readonly kind: "vanished"; readonly seat: Seat };

/**
 * What has changed between the Seats the logins say the user owns and the Seats
 * actually held.
 *
 * Only accounts that were actually read are judged. A Stats login dies roughly
 * once a year and reading nothing from it must degrade to "unknown", never to
 * "every Seat of that account has vanished": the second answer would empty the
 * store on a bad afternoon, and the Multiplier that was read last year is still
 * the best figure anyone has.
 */
export function changesBetween(options: {
  /** Every Seat the read logins say the user owns. */
  readonly wanted: readonly Seat[];
  /** Every Seat actually held, from the store. */
  readonly held: readonly Seat[];
  /** The accounts whose logins answered. Seats of any other account are left alone. */
  readonly accountsRead: readonly string[];
}): Change[] {
  const read = new Set(options.accountsRead);
  const wanted = new Map(options.wanted.map((seat) => [seat.name, seat] as const));
  const held = new Map(options.held.map((seat) => [seat.name, seat] as const));
  const changes: Change[] = [];

  for (const [name, owned] of wanted) {
    const mine = held.get(name);
    if (mine === undefined) {
      changes.push({ kind: "unheld", seat: owned });
      continue;
    }
    if (mine.multiplier !== owned.multiplier) {
      changes.push({ kind: "multiplier", seat: owned, was: mine.multiplier, now: owned.multiplier });
    }
    if (mine.organization.label !== owned.organization.label) {
      changes.push({ kind: "label", seat: owned, was: mine.organization.label, now: owned.organization.label });
    }
  }

  for (const [name, mine] of held) {
    if (wanted.has(name)) continue;
    if (!read.has(mine.account)) continue;
    changes.push({ kind: "vanished", seat: mine });
  }

  return changes;
}

/**
 * The Seat as it should now be recorded, for a change worth writing.
 *
 * Only the two changes that are safe to apply without asking. A Seat that has
 * vanished or was never held is the user's decision, not a refresh's.
 */
export function bringUpToDate(change: Change): Seat | null {
  return change.kind === "multiplier" || change.kind === "label" ? change.seat : null;
}

/** One plain sentence per change, fit to show a user as it stands. */
export function describeChange(change: Change): string {
  switch (change.kind) {
    case "multiplier":
      return `${change.seat.name} is now ${change.now}x, where it was recorded as ${change.was}x`;
    case "label":
      return `${change.seat.name} is in "${change.now}", which was called "${change.was}"`;
    case "unheld":
      return `${change.seat.name} is owned but has no Send token yet`;
    case "vanished":
      return `${change.seat.name} is held, but ${change.seat.account}'s own login no longer lists it`;
  }
}
