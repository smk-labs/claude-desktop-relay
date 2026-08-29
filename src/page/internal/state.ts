/**
 * Everything the page shows, as one document, computed once.
 *
 * Pure: facts in, a document out. No I/O and no clock, so every screen the page
 * can draw is a table in a test, the same way `src/control/internal/status.ts`
 * makes the terminal's screens tables. It is also the shape served at `/state`,
 * because a page that re-reads one document cannot disagree with itself, and
 * six endpoints answering at six different moments can.
 *
 * The words here are the design's words. Where a figure has to be composed from
 * facts a drawing could invent and this cannot, the design's sentence is kept and
 * only the figure inside it is substituted. `src/page/internal/draw.ts` says what
 * that design was and where it went.
 */
import { asAgo, asAgoSpelled, asClock, asCount, asDaysHours, asHoursMinutes, asLongHoursMinutes, asLogTime, asMoney, asMultiplier, asPercent, asStamp, asTime, asTokens } from "./words.ts";

import { bestFirst, consider } from "../../chooser/index.ts";
import { costOf, PERIODS, PUBLISHED, totalsBy, type Period, type Row, type Total } from "../../history/index.ts";
import type { Verdict } from "../../verify/index.ts";
import type { Choice, Standing } from "../../payer/index.ts";
import type { Profile } from "../../profiles/index.ts";
import type { ListedSeat } from "../../seats/index.ts";
import type { AllowanceKnown, SeatUsage } from "../../usage/index.ts";
import type { Examination } from "../../control/index.ts";
import { roomBrief, roomSpelled } from "../../control/index.ts";

/**
 * One week of a Max subscription, in tokens, as an order of magnitude.
 *
 * It is here so a Utilization has a second reading that means something to a
 * person: 41% of a week is an abstraction, 19.2M tokens is not. It is an
 * estimate and the page says so with the `≈` the design puts on both sides of
 * it. Anthropic publishes no figure to derive it from, so it is one constant in
 * one place rather than a calculation dressed up as a measurement.
 */
export const A_WEEKS_WORTH_OF_TOKENS = 46_900_000;

/** Past this share of a window, the meter changes colour. The design's numbers. */
const STRAINED = 0.75;
const NEARLY_GONE = 0.95;
/** Past this, a Seat is not a candidate at all and leaves the ranking. */
const SPENT = 0.98;

export type Level = "plain" | "warn" | "full";
export type Bar = { readonly percent: number | null; readonly level: Level };
export type Meter = { readonly label: string; readonly when: string; readonly percent: number | null; readonly level: Level };
export type Tag = { readonly text: string; readonly tone: "on" | "off" | "broken" };
export type Pair = { readonly key: string; readonly value: string };

/** Which of the four cord shapes a row carries, or `quiet` for a row with nothing to say. */
export type Cord = "on" | "off" | "broken" | "quiet";

export type SeatShown = {
  readonly name: string;
  readonly account: string;
  readonly organization: string;
  readonly organizationId: string;
  readonly plan: string;
  readonly cord: Cord;
  readonly tag: Tag | null;
  readonly paying: boolean;
  readonly five: Bar;
  readonly week: Bar;
  readonly meters: readonly Meter[];
  /**
   * Both windows in one line, spent and when they come back, the session first:
   * `s 8% · in 2h   w 12% · in 5d 3h`.
   *
   * Here rather than in the menu that shows it, because the menu is derived from
   * this document and the two must never word the same fact differently. The
   * wording itself belongs to `control/internal/room.ts`, which is the only place
   * that decides it, on either platform.
   */
  readonly room: string;
  /** The `resets` column: `in 2 d 6 h`, `resets shortly`, `not started`, `unknown`. */
  readonly resets: string;
  readonly detail: readonly Pair[];
  readonly verdict: Tag | null;
  readonly note: string | null;
  readonly group: "available" | "untouched" | "spent";
};

export type PickShown = {
  readonly name: string;
  readonly plan: string;
  readonly percent: number | null;
  /** The same one-line brief the table's rows carry. `SeatShown.room`. */
  readonly room: string;
  /** Nothing to say means no chip at all, rather than a chip saying nothing. */
  readonly chip: string | null;
  readonly chipTone: "warn" | "urgent" | null;
  readonly primary: boolean;
};

export type Figure = { readonly label: string; readonly value: string; readonly foot: string };

export type Paying =
  | {
      readonly kind: "seat";
      readonly name: string;
      readonly plan: string;
      readonly sub: string;
      /**
       * Both windows in whole words, for a tooltip: no letters to look up, and
       * nowhere on screen for a legend to sit. `roomSpelled`.
       */
      readonly room: string;
      readonly meters: readonly Meter[];
    }
  | {
      readonly kind: "window";
      readonly heading: string;
      readonly sub: string;
      readonly figures: readonly Figure[];
      /** The one sentence that turns "nothing works" into "wait this long". */
      readonly foot: string | null;
      /**
       * On, with a Seat still to be chosen, which is not the same as paying from
       * the Window account and must never be drawn as if it were.
       *
       * Auto picks per request, so between a restart and the next request there is
       * genuinely no Seat yet. That state used to be told apart from nothing: the
       * page said "no Seat has room" while its own figure beside it said nearly
       * every Seat had room, and the menu bar said "Relay is off" while the mode was
       * Auto. The command line had it right all along, and now all three read from
       * this.
       */
      readonly waitingToChoose: boolean;
    };

export type Banner = {
  readonly tone: "critical" | "strain";
  readonly heading: string;
  readonly body: string;
  readonly command: string | null;
  readonly foot: string | null;
};

export type Group = { readonly label: string; readonly count: number; readonly seats: readonly SeatShown[] };

export type LogLine = { readonly at: number; readonly event: string; readonly text: string };
export type LogShown = { readonly time: string; readonly event: string; readonly text: string; readonly tone: string };

/**
 * Which of the log's three colours a verb gets. Anything else stays plain: a log
 * where every line is coloured is a log where no line is.
 */
export function toneOf(verb: string): string {
  if (verb === "switched") return "switch";
  if (verb === "refused") return "refuse";
  if (verb === "unverified") return "warn";
  return "";
}

export type Stat = { readonly label: string; readonly value: string; readonly foot: string };
export type SpendRow = { readonly project: string; readonly seat: string; readonly tokens: string; readonly cost: string };

/**
 * One of the folded tables: which Seat, which model, which project, and which
 * project on which Seat.
 *
 * Every row carries the exchanges behind it as well as the total, because "every
 * figure can be traced to the rows behind it" is the whole point of the history
 * and a number with no count behind it cannot be argued with.
 */
export type Slice = {
  readonly title: string;
  readonly of: string;
  readonly rows: readonly {
    readonly of: string;
    readonly calls: string;
    readonly refused: string;
    readonly input: string;
    readonly output: string;
    readonly cache: string;
    readonly cost: string;
  }[];
};

export type Analytics = {
  readonly when: string;
  readonly period: Period;
  readonly stats: readonly Stat[];
  readonly spend: readonly SpendRow[];
  readonly slices: readonly Slice[];
  readonly prices: string;
  readonly nothing: string | null;
};

/** One profile, in the words the menu and the page both use. */
export type ProfileShown = {
  readonly name: string;
  readonly where: string;
  readonly relayed: boolean;
  readonly running: boolean;
  /**
   * Whether this profile is relayed, in words.
   *
   * Four answers, never a yes-or-no flattening of them: "relayed by another relay"
   * and "its store could not be read" send a reader somewhere else entirely, and
   * both would otherwise be shown as "not relayed", which is a guess dressed as a
   * fact about the one thing this section exists to answer.
   */
  readonly badge: string;
  /**
   * Who it is signed in as, and where that came from.
   *
   * "not signed in" and "signed in, name not read yet" are different states and are
   * said differently: the second one is about our reading, not about the profile.
   */
  readonly account: string;
  /** Whether it is open, and whether anybody has ever signed in to it. */
  readonly saying: string;
  /** Amber on a profile that is relayed by something that is not this relay. */
  readonly tone: "on" | "off" | "warn";
};

export type Empty = { readonly heading: string; readonly body: string; readonly command: string; readonly foot: string };

export type PageState = {
  readonly at: number;
  /** The port the relay is listening on, which is also where the page is. */
  readonly port: number;
  readonly title: string;
  readonly subtitle: string;
  readonly account: string | null;
  /** What the masthead says about the Window, which is not always an account. */
  readonly windowSaying: string;
  readonly read: string;
  /**
   * When the figures were last read, as a clock reading: `today 09:47`.
   *
   * `read` alone says how long ago, which answers "is this stale" and not "when".
   * The tray shows both, because a menu bar item is often the only surface open
   * and "3 h ago" on its own leaves the reader doing arithmetic.
   */
  readonly readStamp: string;
  readonly mode: "auto" | "manual" | "off";
  readonly empty: Empty | null;
  readonly banners: readonly Banner[];
  readonly paying: Paying;
  readonly picks: readonly PickShown[];
  readonly groups: readonly Group[];
  readonly rankedByPlanSize: boolean;
  readonly analytics: Analytics;
  readonly log: readonly LogShown[];
  readonly machine: readonly Pair[];
  /**
   * The Claude Desktop profiles on this machine, as the page shows them.
   *
   * Carried through rather than derived: which profile is relayed is read from
   * that profile's own store, and a page that guessed it would be guessing about
   * the one thing this section exists to answer.
   */
  readonly profiles: readonly ProfileShown[];
  readonly mechanism: string;
  readonly statsLogins: string;
  readonly backup: string | null;
};

export type WhatThePageShows = {
  readonly choice: Choice;
  readonly seats: readonly ListedSeat[];
  readonly usage: readonly SeatUsage[];
  readonly verdict: Verdict | null;
  readonly standing: Standing | null;
  readonly examination: Examination;
  readonly windowRunning: boolean;
  /** The account Claude Desktop is signed into, or null when it cannot be read. */
  readonly windowAccount: string | null;
  readonly backedUpOn: string | null;
  /** Recent history rows, newest last. Used for last paid, last refused and tokens. */
  readonly history: readonly Row[];
  readonly perProjectAndSeat: readonly Total[];
  /** Which period the analytics view is showing. A week by default. */
  readonly period?: Period;
  readonly log: readonly LogLine[];
  /** How many Stats logins still read, of how many accounts, or null when unasked. */
  readonly statsLogins: { readonly alive: number; readonly of: number } | null;
  /** What the machine is, as key and value pairs. Facts only, never a guess. */
  readonly machine: readonly Pair[];
  /** Every Claude Desktop profile found on this machine. Empty when unread. */
  readonly profiles?: readonly Profile[];
  /** When the figures on the page were last read from anywhere. */
  readonly readAt: number | null;
  readonly port: number;
  readonly at: number;
  readonly timeZone?: string;
};

/** A window's share, counting a window that has reset as empty rather than as unknown. */
function share(known: AllowanceKnown | null): number | null {
  if (known === null) return null;
  return known.hasReset ? 0 : known.utilization;
}

function levelOf(percent: number | null): Level {
  if (percent === null) return "plain";
  if (percent >= NEARLY_GONE * 100) return "full";
  if (percent >= STRAINED * 100) return "warn";
  return "plain";
}

function bar(known: AllowanceKnown | null): Bar {
  const raw = share(known);
  const percent = raw === null ? null : Math.round(raw * 100);
  return { percent, level: levelOf(percent) };
}

/** The five-hour meter's sub-line, in the list's lowercase form. */
function fiveWhen(known: AllowanceKnown | null, at: number): string {
  if (known === null) return "window not started";
  if (known.resetsAt === null) return "no reset time yet";
  return `resets in ${asLongHoursMinutes(Math.max(0, known.resetsAt - at))}`;
}

/**
 * How long the weekly window has left, not the day and time it lands on.
 *
 * It used to read `resets Fri 12:00`, which is a fact about the calendar and makes
 * the reader do the subtraction. Every window on this screen now answers the same
 * question the same way, in Claude's own words: how much longer.
 *
 * `zone` is still taken, and still unused, so that a caller which has one does not
 * have to know that this line stopped needing it.
 */
function weekWhen(known: AllowanceKnown | null, at: number, _zone: string): string {
  if (known === null || known.resetsAt === null) return "no reset time yet";
  return `resets in ${asLongHoursMinutes(Math.max(0, known.resetsAt - at))}`;
}

/**
 * The `resets` column: when the week comes back.
 *
 * The week rather than the sooner of the two, because the column sits under the
 * `seven days` one and a countdown that silently switched windows would make two
 * adjacent columns disagree about which figure they are about.
 */
function resetsIn(usage: SeatUsage | undefined, at: number): string {
  const when = usage?.sevenDay?.resetsAt;
  if (when === undefined || when === null) return nothingKnown(usage) ? "unknown" : "not started";
  const span = asDaysHours(when - at);
  return span === null ? "resets shortly" : `in ${span}`;
}

function isSpent(usage: SeatUsage | undefined): boolean {
  const week = share(usage?.sevenDay ?? null);
  const five = share(usage?.fiveHour ?? null);
  return (week !== null && week >= SPENT) || (five !== null && five >= 1);
}

function isUntouched(usage: SeatUsage | undefined): boolean {
  const week = share(usage?.sevenDay ?? null);
  return week === 0;
}

/** Nothing has ever been measured about this Seat, which is not the same as zero. */
function nothingKnown(usage: SeatUsage | undefined): boolean {
  return usage === undefined || (usage.fiveHour === null && usage.sevenDay === null);
}

function lastRow(history: readonly Row[], seat: string, refused: boolean): Row | null {
  let found: Row | null = null;
  for (const row of history) {
    if (row.seat !== seat || row.refused !== refused) continue;
    if (found === null || row.at > found.at) found = row;
  }
  return found;
}

function tokensSpent(history: readonly Row[], seat: string): number {
  let total = 0;
  for (const row of history) {
    if (row.seat !== seat || row.tokens === null) continue;
    total += row.tokens.input + row.tokens.output + row.tokens.cacheWritten + row.tokens.cacheRead;
  }
  return total;
}

function oneSeat(options: {
  seat: ListedSeat;
  usage: SeatUsage | undefined;
  choice: Choice;
  standing: Standing | null;
  history: readonly Row[];
  verdict: Verdict | null;
  at: number;
  zone: string;
}): SeatShown {
  const { seat, usage, at, zone } = options;
  const payer = options.choice.mode === "auto" ? (options.standing?.seat ?? null) : options.choice.mode === "off" ? null : options.choice.payer;
  const paying = payer === seat.name;

  const cooldown = Object.entries(usage?.cooldowns ?? {})
    .filter(([, until]) => until > at)
    .sort((a, b) => b[1] - a[1])[0];
  const refused = lastRow(options.history, seat.name, true);
  const spent = isSpent(usage);

  const cord: Cord = paying ? "on" : cooldown !== undefined ? "broken" : spent || !seat.hasSendToken ? "off" : "quiet";
  const tag: Tag | null = paying
    ? { text: "paying", tone: "on" }
    : cooldown !== undefined && refused !== null
      ? { text: `refused ${asAgo(at - refused.at)}`, tone: "broken" }
      : !seat.hasSendToken
        ? { text: "no Send token", tone: "off" }
        : spent
          ? { text: "spent", tone: "off" }
          : null;

  const paid = lastRow(options.history, seat.name, false);
  const tokens = tokensSpent(options.history, seat.name);

  const meters: Meter[] = [
    { label: "Session", when: fiveWhen(usage?.fiveHour ?? null, at), ...pick(bar(usage?.fiveHour ?? null)) },
    { label: "Weekly", when: weekWhen(usage?.sevenDay ?? null, at, zone), ...pick(bar(usage?.sevenDay ?? null)) },
  ];

  const group = !seat.hasSendToken || spent ? "spent" : isUntouched(usage) ? "untouched" : "available";

  const note =
    group === "untouched"
      ? "The week starts on the first request, so there is nothing to expire yet."
      : cooldown !== undefined
        ? `Refused on ${cooldown[0]} at ${asTime(refused?.at ?? at, zone)}, so it is held out of Auto for that model for ${asHoursMinutes(cooldown[1] - at)} more. A Refusal is evidence about one request, never proof a Seat is spent.`
        : !seat.hasSendToken
          ? "It has no Send token, so it cannot pay for anything. Mint one with relay add-seat."
          : spent
            ? "Not a candidate until the week resets. The Seat is healthy, only empty."
            : null;

  return {
    name: seat.name,
    account: seat.account,
    organization: seat.organization.label,
    organizationId: seat.organization.id,
    plan: asMultiplier(seat.multiplier),
    cord,
    tag,
    paying,
    five: bar(usage?.fiveHour ?? null),
    week: bar(usage?.sevenDay ?? null),
    meters,
    room: roomBrief(usage, at),
    resets: resetsIn(usage, at),
    detail: [
      { key: "Plan", value: `Max ${asMultiplier(seat.multiplier)}` },
      { key: "Account", value: seat.account },
      { key: "Organization", value: `${seat.organization.label} · ${seat.organization.id}` },
      { key: "Token equivalent", value: `≈ ${asTokens(tokens)} of ≈ ${asTokens(A_WEEKS_WORTH_OF_TOKENS)}` },
      { key: "Last paid", value: paid === null ? "never" : whenSaid(paid.at, at, zone) },
      { key: "Last refused", value: refused === null ? "never" : whenSaid(refused.at, at, zone) },
    ],
    verdict:
      paying && options.verdict !== null
        ? options.verdict.kind === "verified"
          ? { text: "verified", tone: "on" }
          : { text: `${options.verdict.status} ${options.verdict.because ?? options.verdict.kind}`, tone: "broken" }
        : null,
    note,
    group,
  };
}

/** A meter carries the same figure a bar does; this keeps them from drifting apart. */
function pick(one: Bar): { percent: number | null; level: Level } {
  return { percent: one.percent, level: one.level };
}

/** Recent moments are said as elapsed, older ones as a clock reading. */
function whenSaid(at: number, now: number, zone: string): string {
  const ago = now - at;
  return ago < 3600 ? asAgoSpelled(ago) : asClock(at, now, zone);
}

/**
 * The hours left in a Seat's weekly window before its unused allowance is gone.
 *
 * Fifteen hours, not a whole day. Under it, whatever is left on that Seat is about
 * to be lost and spending it first costs nothing. Beyond it the reset is far enough
 * off that a chip saying so on every card is texture rather than news.
 */
const A_CHIP_UNDER_HOURS = 15;
const URGENT_UNDER_HOURS = 5;

/**
 * A chip, only when there is something to say, and nothing when there is not.
 *
 * Every Seat used to carry one, and most of them said `session untouched`, which is
 * the same as saying nothing while taking a line to do it. A row that is quiet
 * unless it has something to report is the whole idea of this table, and a chip on
 * every card broke it.
 *
 * The one thing worth a chip is a weekly window about to turn over: what is left on
 * that Seat is about to be lost, so it should be spent first. Amber inside fifteen
 * hours, red inside five, and nothing at all before that.
 */
function chipFor(usage: SeatUsage | undefined, at: number): { chip: string; tone: "warn" | "urgent" } | null {
  const week = usage?.sevenDay ?? null;
  if (week?.resetsAt == null) return null;

  const left = Math.max(0, week.resetsAt - at);
  const hours = left / 3600;
  if (hours >= A_CHIP_UNDER_HOURS) return null;

  return { chip: `resets in ${asLongHoursMinutes(left)}`, tone: hours < URGENT_UNDER_HOURS ? "urgent" : "warn" };
}

/**
 * The order of the whole table, which is the order the Chooser would pick in.
 *
 * The heading over this table says "Best value first" and for a while it was not
 * true: the rows were sorted by Multiplier and then alphabetically by name, so a
 * Seat with seven percent of its week gone sat below one with forty-seven, and the
 * table disagreed with both the Chooser and the six suggestions drawn above it.
 * That is worse than an arbitrary order, because it reads as a ranking.
 *
 * The score is the Chooser's own, so the table, the suggestions and what Auto
 * actually does can never tell three different stories. A Seat that is ruled out
 * has no score to compare, so those fall to the foot, in a stable order by name:
 * they are already gathered under their own heading and the ranking is not about
 * them.
 */
function bestValueFirst(
  seats: readonly ListedSeat[],
  usage: readonly SeatUsage[],
  at: number,
): (a: { name: string }, b: { name: string }) => number {
  const scored = new Map<string, number>();
  for (const seat of seats) {
    const considered = consider({ seat, usage: usage.find((one) => one.seat === seat.name), model: null, at });
    scored.set(seat.name, considered.ruledOut === null ? considered.score : -1);
  }

  return (a, b) => {
    const left = scored.get(a.name) ?? -1;
    const right = scored.get(b.name) ?? -1;
    // By name when the scores tie, so the order is the same on every read rather
    // than wandering between refreshes.
    return right - left || a.name.localeCompare(b.name);
  };
}

/** The six worth switching to, best value first, the way the Chooser ranks them. */
function picksFrom(options: {
  seats: readonly ListedSeat[];
  usage: readonly SeatUsage[];
  payer: string | null;
  at: number;
}): PickShown[] {
  const considered = bestFirst(
    options.seats.map((seat) =>
      consider({ seat, usage: options.usage.find((one) => one.seat === seat.name), model: null, at: options.at }),
    ),
  );

  return considered
    .filter((one) => one.ruledOut === null && one.seat !== options.payer)
    .slice(0, 6)
    .map((one, index) => {
      const usage = options.usage.find((held) => held.seat === one.seat);
      const seat = options.seats.find((held) => held.name === one.seat);
      const week = share(usage?.sevenDay ?? null);
      const said = chipFor(usage, options.at);
      return {
        name: one.seat,
        plan: asMultiplier(seat?.multiplier ?? 0),
        percent: week === null ? null : Math.round(week * 100),
        room: roomBrief(usage, options.at),
        chip: said?.chip ?? null,
        chipTone: said?.tone ?? null,
        primary: index === 0,
      };
    });
}

function analyticsFrom(options: { history: readonly Row[]; perProjectAndSeat: readonly Total[]; period: Period; at: number; zone: string }): Analytics {
  const days = PERIODS[options.period];
  const from = options.at - days * 86400;
  const rows = options.history.filter((row) => row.at >= from && row.tokens !== null);

  const empty = { input: 0, output: 0, cacheWritten: 0, cacheRead: 0 };
  const buckets = ["input", "output", "cacheWritten", "cacheRead"] as const;

  /**
   * Each bucket costed on its own, by asking the price table for a row that has
   * only that bucket in it. Splitting one total four ways in proportion to token
   * counts would be arithmetic that looks like a measurement: output costs five
   * times what input does, and a cache read costs a fraction.
   */
  const counted = { input: 0, output: 0, cacheWritten: 0, cacheRead: 0 };
  const costs = { input: 0, output: 0, cacheWritten: 0, cacheRead: 0 };
  for (const row of rows) {
    if (row.tokens === null) continue;
    for (const bucket of buckets) {
      counted[bucket] += row.tokens[bucket];
      costs[bucket] += costOf({ model: row.model, ...empty, [bucket]: row.tokens[bucket] }) ?? 0;
    }
  }

  const labels = { input: "Input", output: "Output", cacheWritten: "Cache write", cacheRead: "Cache read" } as const;
  const stats: Stat[] = buckets.map((bucket) => ({
    label: labels[bucket],
    value: asTokens(counted[bucket], 2),
    foot: `\u2248 ${asMoney(costs[bucket])}`,
  }));

  const spend = [...options.perProjectAndSeat]
    .sort((a, b) => (b.wouldHaveCost ?? 0) - (a.wouldHaveCost ?? 0))
    .slice(0, 5)
    .map((total) => {
      const [project, seat] = total.of.split(" \u00b7 ");
      return {
        project: project ?? total.of,
        seat: seat ?? "",
        tokens: asTokens(total.input + total.output + total.cacheWritten + total.cacheRead),
        cost: total.wouldHaveCost === null ? "unpriced" : asMoney(total.wouldHaveCost),
      };
    });

  /**
   * The four slices, folded away. They are computed here rather than asked of
   * the history so that every figure on this screen was taken from one set of
   * rows at one moment: two reads a second apart is two screens that disagree.
   */
  const sliceOf = (title: string, of: string, by: (row: Row) => string | null): Slice => ({
    title,
    of,
    rows: totalsBy(rows, by)
      .sort((a, b) => (b.wouldHaveCost ?? 0) - (a.wouldHaveCost ?? 0))
      .map((total) => ({
        of: total.of,
        calls: asCount(total.exchanges),
        refused: total.refusals === 0 ? "\u2013" : asCount(total.refusals),
        input: asTokens(total.input),
        output: asTokens(total.output),
        cache: asTokens(total.cacheWritten + total.cacheRead),
        cost: total.wouldHaveCost === null ? "unpriced" : asMoney(total.wouldHaveCost),
      })),
  });

  const slices = [
    sliceOf("By Seat", "Seat", (row) => row.seat),
    sliceOf("By model", "Model", (row) => row.model),
    sliceOf("By project", "Project", (row) => row.project),
    sliceOf("By project, on which Seat", "Project \u00b7 Seat", (row) => (row.project === null ? null : `${row.project} \u00b7 ${row.seat}`)),
  ].filter((slice) => slice.rows.length > 0);

  const called = { day: "last 24 hours", week: "last 7 days", month: "last 30 days" } as const;

  return {
    when: `${called[options.period]}, to ${asStamp(options.at, options.zone)}`,
    period: options.period,
    stats,
    spend,
    slices,
    prices: `Costs are what these tokens would have come to at API rates published ${PUBLISHED.on}. They are not what you paid: a Seat is a subscription.`,
    nothing: rows.length === 0 ? `Nothing was paid for by a Seat in the ${called[options.period]}.` : null,
  };
}

/**
 * The whole page, as one document.
 */
export function pageState(what: WhatThePageShows): PageState {
  const zone = what.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const at = what.at;
  const seats = what.seats;
  const usageOf = (name: string) => what.usage.find((one) => one.seat === name);

  const payer = what.choice.mode === "auto" ? (what.standing?.seat ?? null) : what.choice.mode === "off" ? null : what.choice.payer;

  const shown = seats
    .map((seat) =>
      oneSeat({
        seat,
        usage: usageOf(seat.name),
        choice: what.choice,
        standing: what.standing,
        history: what.history,
        verdict: what.verdict,
        at,
        zone,
      }),
    )
    .sort(bestValueFirst(what.seats, what.usage, at));

  const everythingUnknown = seats.length > 0 && seats.every((seat) => nothingKnown(usageOf(seat.name)));

  const banners: Banner[] = [];
  if (!what.examination.working) {
    const wrong = what.examination.findings.filter((one) => !one.ok);
    banners.push({
      tone: "critical",
      heading: "Nothing is being swapped.",
      body: `The relay is running and requests are going through, but every one of them is being paid for by the Window account. ${wrong.map((one) => one.saying).join(" ")}`,
      command: "relay doctor",
      foot: null,
    });
  }
  if (everythingUnknown) {
    banners.push({
      tone: "strain",
      heading: `Usage is unknown for ${seats.length} of ${seats.length} Seats.`,
      body:
        what.statsLogins !== null && what.statsLogins.alive === 0
          ? "every Stats login has expired, so nothing has been measured. Auto is ranking on plan size alone until a Seat pays for something."
          : "nothing has been measured yet. Auto is ranking on plan size alone until a Seat pays for something.",
      command: null,
      foot: "Re-read them with relay refresh.",
    });
  }

  const withRoom = shown.filter((one) => one.group === "available" || one.group === "untouched").length;
  const paidSeat = payer === null ? null : shown.find((one) => one.name === payer) ?? null;

  const nextResets = seats
    .map((seat) => ({ seat, usage: usageOf(seat.name) }))
    .map(({ seat, usage }) => ({
      seat,
      when: [usage?.fiveHour?.resetsAt, usage?.sevenDay?.resetsAt].filter((one): one is number => typeof one === "number").sort((a, b) => a - b)[0],
    }))
    .filter((one): one is { seat: ListedSeat; when: number } => one.when !== undefined)
    .sort((a, b) => a.when - b.when);

  const heldOut = seats.filter((seat) => Object.values(usageOf(seat.name)?.cooldowns ?? {}).some((until) => until > at)).length;

  /**
   * Nothing has asked yet, as opposed to nothing being able to pay.
   *
   * Told apart by whether any Seat has room: if Seats do and none has been chosen,
   * then nobody has asked, not that nobody can serve.
   */
  const waitingToChoose = paidSeat === null && what.choice.mode !== "off" && withRoom > 0;

  const paying: Paying =
    paidSeat === null
      ? {
          kind: "window",
          heading: waitingToChoose
            ? what.choice.mode === "auto"
              ? "Auto has not chosen yet"
              : "No Seat is picked yet"
            : "The Window account is paying",
          sub:
            what.choice.mode === "off"
              ? `${what.windowAccount ?? "the Window account"} · Off, so nothing is being swapped and work continues on the subscription the Window is signed into.`
              : waitingToChoose
                ? `nothing has asked yet, so nothing has been chosen. The next request picks a Seat and it pays from that moment.`
                : `${what.windowAccount ?? "the Window account"} · no Seat has room, so work continues on the subscription the Window is signed into.`,
          waitingToChoose,
          figures:
            what.choice.mode === "off"
              ? []
              : [
                  {
                    label: "Seats with room",
                    value: `${withRoom} of ${seats.length}`,
                    foot: `${shown.filter((one) => one.group === "spent").length} spent, ${heldOut} held out after a Refusal`,
                  },
                  ...nextResets.slice(0, 2).map((one, index) => ({
                    label: index === 0 ? "Nearest reset" : "Then",
                    value: asHoursMinutes(one.when - at),
                    foot: `${one.seat.name} · ${asMultiplier(one.seat.multiplier)} · ${asClock(one.when, at, zone)}`,
                  })),
                ],
          foot:
            what.choice.mode === "off" || waitingToChoose || nextResets[0] === undefined
              ? null
              : `Auto keeps watching. The moment ${nextResets[0].seat.name} resets it becomes a candidate again, on the very next request.`,
        }
      : {
          kind: "seat",
          name: paidSeat.name,
          plan: paidSeat.plan,
          /**
           * The account, and not the Organization's UUID beside it.
           *
           * Thirty-six characters of hexadecimal that nobody reads and nothing on
           * this screen needs: the Seat's own name already says which Organization
           * it is, and the verdict names it in full where it is actually evidence.
           */
          sub: paidSeat.account,
          room: roomSpelled(usageOf(paidSeat.name), at),
          meters: [
            {
              label: "Session",
              when: longWhen(usageOf(paidSeat.name)?.fiveHour ?? null, at),
              ...pick(paidSeat.five),
            },
            { label: "Weekly", when: capitalise(weekWhen(usageOf(paidSeat.name)?.sevenDay ?? null, at, zone)), ...pick(paidSeat.week) },
          ],
        };

  const combined = seats.reduce((sum, seat) => sum + seat.multiplier, 0);
  const accounts = new Set(seats.map((seat) => seat.account)).size;

  const held = seats.filter((seat) => seat.hasSendToken).length;

  return {
    at,
    port: what.port,
    title: "Relay",
    subtitle: `${seats.length} Seat${seats.length === 1 ? "" : "s"} · ${accounts} account${accounts === 1 ? "" : "s"} · ${combined}x combined`,
    account: what.windowAccount,
    windowSaying:
      what.windowAccount !== null
        ? `Claude signed in as ${what.windowAccount}`
        : what.windowRunning
          ? "Claude Desktop is running"
          : "Claude Desktop is not running",
    read: what.readAt === null ? "read nothing yet" : `read ${asAgo(at - what.readAt)}`,
    readStamp: what.readAt === null ? "never" : asClock(what.readAt, at, zone),
    mode: what.choice.mode,
    empty:
      seats.length === 0
        ? {
            heading: "No Seats collected yet",
            body: "Relay finds your Seats from the accounts you are already signed into. Run this once, and it opens a browser for each account in turn.",
            command: "relay collect-seats",
            foot: "It reads which Organizations each account can pay for. It never writes to your claude login.",
          }
        : null,
    banners,
    paying,
    picks: picksFrom({ seats, usage: what.usage, payer, at }),
    groups: [
      { label: everythingUnknown ? "Ranked by plan size" : "Available now", count: 0, seats: shown.filter((one) => one.group === "available") },
      { label: "Untouched this week", count: 0, seats: shown.filter((one) => one.group === "untouched") },
      { label: "Nothing left", count: 0, seats: shown.filter((one) => one.group === "spent") },
    ]
      .filter((group) => group.seats.length > 0)
      .map((group) => ({ ...group, count: group.seats.length })),
    rankedByPlanSize: everythingUnknown,
    analytics: analyticsFrom({ history: what.history, perProjectAndSeat: what.perProjectAndSeat, period: what.period ?? "week", at, zone }),
    log: what.log.map((line) => ({ time: asLogTime(line.at, zone), event: line.event, text: line.text, tone: toneOf(line.event) })),
    machine: what.machine,
    profiles: (what.profiles ?? []).map(profileShown),
    mechanism: what.examination.working
      ? `healthy, checked ${what.readAt === null ? "just now" : asAgo(at - what.readAt)}`
      : "not working",
    statsLogins: what.statsLogins === null ? "not read yet" : `${what.statsLogins.alive} of ${what.statsLogins.of} alive`,
    backup:
      held === 0
        ? null
        : what.backedUpOn === null
          ? `None of the ${asCount(held)} Send tokens is backed up. Take one: relay back-up-seats`
          : `${asCount(held)} Send tokens, last backed up ${what.backedUpOn}.`,
  };
}

/**
 * One profile as a line of words.
 *
 * "Relayed by this relay" and "relayed by another" are told apart, because they
 * send a reader to two different places, and "could not be read" is never
 * flattened into "not relayed": a store that would not open is not an empty one.
 */
function profileShown(one: Profile): ProfileShown {
  return {
    name: one.name,
    where: one.where,
    badge:
      one.relayed === "this relay"
        ? "relayed"
        : one.relayed === "another relay"
          ? "relayed by another relay"
          : one.relayed === "unreadable"
            ? "its store could not be read"
            : "not relayed",
    relayed: one.relayed === "this relay",
    running: one.running,
    account: !one.signedIn
      ? "not signed in"
      : one.account === null
        ? "signed in, reading the account"
        : one.account.organization === null
          ? one.account.email
          : `${one.account.email} · ${one.account.organization}`,
    saying: one.running ? "open" : "not open",
    tone: one.relayed === "this relay" ? "on" : one.relayed === "no" ? "off" : "warn",
  };
}

/** The Paying now panel is the one place that spells the units out. */
function longWhen(known: AllowanceKnown | null, at: number): string {
  if (known === null) return "window not started";
  if (known.resetsAt === null) return "no reset time yet";
  return `Resets in ${asLongHoursMinutes(Math.max(0, known.resetsAt - at))}`;
}

function capitalise(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1);
}
