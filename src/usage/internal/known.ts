/**
 * What is known about one Seat's allowance, and the rules for folding news into
 * it. Pure: no clock, no file, no I/O. The moment is always an argument.
 */
import type { Exchange } from "../../relay/index.ts";
import type { UsageAsRead } from "../../stats-login/index.ts";

/**
 * Where a figure came from, kept because the two are not interchangeable.
 *
 * A reply names the moment a Seat actually paid. A Stats login is a reading taken
 * on the side and can be minutes old. A Chooser that mixed them would rank a Seat
 * on a number it could not date.
 */
export type ReadVia = "exchange" | "stats-login";

/** One Allowance window as it is remembered. Everything here is dated. */
export type Remembered = {
  /** The share of the window spent, 0 to 1, at the moment it was learned. */
  readonly utilization: number;
  /** When the window resets, seconds since 1970, or null when it was not said. */
  readonly resetsAt: number | null;
  /** When this was learned, seconds since 1970. */
  readonly readAt: number;
  readonly readVia: ReadVia;
};

/**
 * One Allowance window as it reads now, which is not the same as how it was
 * learned.
 *
 * The age is here rather than left for the reader to subtract, because a figure
 * without its age is the one thing a ranking rule must never be handed: a Seat
 * read at 10% four hours ago and a Seat read at 10% a second ago are not the same
 * Seat.
 */
export type AllowanceKnown = Remembered & {
  /** How old the reading is, in seconds, at the moment it was asked for. */
  readonly ageSeconds: number;
  /**
   * The window this figure describes has ended.
   *
   * When it has, the Utilization reads zero: the figure was about a window that no
   * longer exists, and a Seat whose window has turned over starts again from
   * nothing. Reporting the old share would be the exact mistake of story 8, where
   * capacity about to reset unused is the capacity worth spending.
   */
  readonly hasReset: boolean;
};

/** Everything known about one Seat, as of one moment. */
export type SeatUsage = {
  readonly seat: string;
  readonly fiveHour: AllowanceKnown | null;
  readonly sevenDay: AllowanceKnown | null;
  /** Model to the moment its cooldown ends, seconds since 1970. Expired ones are gone. */
  readonly cooldowns: Readonly<Record<string, number>>;
};

/** What is held for one Seat between readings. The on-disk shape, too. */
export type SeatMemory = {
  fiveHour: Remembered | null;
  sevenDay: Remembered | null;
  cooldowns: Record<string, number>;
};

export const nothingKnown = (): SeatMemory => ({ fiveHour: null, sevenDay: null, cooldowns: {} });

/**
 * How long a Seat is left alone after it refuses, when the server did not say.
 *
 * Stated here because it is a judgement rather than a measurement: long enough
 * that Auto does not walk into the same wall on the next request, short enough
 * that a Refusal which had nothing to do with allowance costs a moment. ADR 0005
 * is why it is a cooldown at all and not a Seat being retired.
 */
export const COOLDOWN_SECONDS = 10 * 60;

/**
 * Never sit out longer than the five-hour Allowance window, whatever a header says.
 *
 * The shorter of the two windows on purpose. Once it has turned over, the Refusal
 * that started the cooldown is about a window that no longer exists, so holding a
 * Seat out past that is holding it out on the strength of nothing.
 */
const AT_MOST_COOLDOWN_SECONDS = 5 * 60 * 60;

/**
 * Fold one reading of one window in, and say which of the two to keep.
 *
 * The newer reading wins, and on a tie the reply wins over the reading on the
 * side, because the reply is the one that was there when the Seat paid. Without
 * this a Stats refresh running once a minute would keep overwriting figures that
 * arrived from real traffic a moment ago.
 */
function keepTheBetter(held: Remembered | null, arriving: Remembered): Remembered {
  if (held === null) return arriving;
  if (arriving.readAt > held.readAt) return arriving;
  if (arriving.readAt < held.readAt) return held;
  return arriving.readVia === "exchange" ? arriving : held;
}

/**
 * Whether this exchange says anything about the Seat it names.
 *
 * Three ways it does not, and each of them has cost somebody a wrong number
 * somewhere:
 *
 * - Nobody was charged, so the figures are the Window account's.
 * - A Seat was chosen but the relay did not swap, so the figures belong to
 *   whatever credential the caller sent for itself.
 * - The server named a different Organization as the payer, so the figures are
 *   that Organization's. Writing them against our Seat would poison the memory
 *   with another Seat's spending, and the mismatch is already being shouted about
 *   elsewhere.
 */
export function seatTaughtBy(exchange: Exchange): string | null {
  const charged = exchange.chargedTo;
  if (charged === null || !exchange.swapped) return null;
  if (exchange.paidBy !== null && exchange.paidBy !== charged.organizationId) return null;
  return charged.seat;
}

/**
 * Whether a Refusal is evidence about the Seat, or about our own request.
 *
 * A request without the Claude Code system prompt is refused for every premium
 * model with a message that reads like an exhausted allowance, while the Seat is
 * untouched (ADR 0005). A body that could not be read at all lands here too, and
 * that is the safe direction: concluding nothing about a Seat costs a ranking
 * decision, where concluding wrongly retires a healthy Seat for as long as the
 * cooldown lasts.
 *
 * The second half is the reply's own figures, and it is there because the first
 * half is a guess about our request where this is the server's statement about
 * the Seat. Measured on 2026-08-26: eight 429s on one Seat over six hours set no
 * cooldown and moved no work, because every one of them failed the shape test,
 * while the same replies carried a five-hour Utilization of 1.02. The ADR 0005
 * Refusal is precisely the one that comes back with the Seat untouched, so a
 * window the server says is at or past its whole cannot be that Refusal. Nothing
 * is being guessed here that the header did not already say.
 */
export function refusalIsAboutTheSeat(exchange: Exchange): boolean {
  if (!exchange.refused) return false;
  if (exchange.about.looksLikeCode) return true;
  return spentByItsOwnAccount(exchange.utilization.fiveHour) || spentByItsOwnAccount(exchange.utilization.sevenDay);
}

/** A window the reply itself says is at or past its whole. */
const spentByItsOwnAccount = (utilization: number | null): boolean => utilization !== null && utilization >= 1;

/** When a Seat that has just refused may be tried again. */
function cooldownUntil(exchange: Exchange, at: number): number {
  const stated = exchange.resets.fiveHour;
  // A 429 that names when the window turns over has told us exactly when to come
  // back, and that beats any number chosen here. Anything else is not a statement
  // about allowance, so the flat period applies.
  const asked = exchange.status === 429 && stated !== null && stated > at ? stated : at + COOLDOWN_SECONDS;
  return Math.min(asked, at + AT_MOST_COOLDOWN_SECONDS);
}

/**
 * Everything one exchange teaches about one Seat, folded into what was held.
 *
 * Returns the memory unchanged when the exchange teaches nothing, so a caller can
 * tell a no-op from a change without knowing any of the rules above.
 */
export function foldExchange(held: SeatMemory, exchange: Exchange, at: number): SeatMemory {
  const next: SeatMemory = { ...held, cooldowns: { ...held.cooldowns } };

  const readings: readonly (readonly ["fiveHour" | "sevenDay", number | null, number | null])[] = [
    ["fiveHour", exchange.utilization.fiveHour, exchange.resets.fiveHour],
    ["sevenDay", exchange.utilization.sevenDay, exchange.resets.sevenDay],
  ];
  for (const [window, utilization, resetsAt] of readings) {
    if (utilization === null) continue;
    next[window] = keepTheBetter(held[window], { utilization, resetsAt, readAt: at, readVia: "exchange" });
  }

  if (refusalIsAboutTheSeat(exchange)) {
    const model = exchange.about.model;
    // No model named means nothing to name as the thing to avoid. Putting the
    // whole Seat on cooldown instead is the ADR 0005 mistake wearing a different
    // hat: a request we could not read taking a healthy Seat out of the running.
    if (model !== null) next.cooldowns[model] = cooldownUntil(exchange, at);
  }

  return next;
}

/** A reading taken on the side, folded in the same way. */
export function foldReading(held: SeatMemory, usage: UsageAsRead, at: number): SeatMemory {
  const next: SeatMemory = { ...held, cooldowns: { ...held.cooldowns } };

  for (const window of ["fiveHour", "sevenDay"] as const) {
    const read = usage[window];
    if (read === null) continue;
    next[window] = keepTheBetter(held[window], {
      utilization: read.utilization,
      resetsAt: read.resetsAt,
      readAt: at,
      readVia: "stats-login",
    });
  }

  return next;
}

function asKnown(held: Remembered | null, at: number): AllowanceKnown | null {
  if (held === null) return null;
  const hasReset = held.resetsAt !== null && held.resetsAt <= at;
  return {
    ...held,
    utilization: hasReset ? 0 : held.utilization,
    ageSeconds: Math.max(0, at - held.readAt),
    hasReset,
  };
}

/** Drop every cooldown that has run out. Expired is the same as never set. */
export function stillCooling(cooldowns: Readonly<Record<string, number>>, at: number): Record<string, number> {
  return Object.fromEntries(Object.entries(cooldowns).filter(([, until]) => until > at));
}

/** What is held for one Seat, read as of one moment. */
export function asOf(seat: string, held: SeatMemory, at: number): SeatUsage {
  return {
    seat,
    fiveHour: asKnown(held.fiveHour, at),
    sevenDay: asKnown(held.sevenDay, at),
    cooldowns: stillCooling(held.cooldowns, at),
  };
}

/** Whether this Seat is being left alone for the model being asked for. */
export function onCooldown(usage: SeatUsage, model: string | null, at: number): boolean {
  if (model === null) return false;
  const until = usage.cooldowns[model];
  return until !== undefined && until > at;
}
