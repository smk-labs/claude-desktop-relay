import { asAge, asPercent, asSpan } from "./words.ts";

import type { AllowanceKnown, SeatUsage } from "../../usage/index.ts";

/**
 * How much room a Seat has, in the words a person asks the question in.
 *
 * The daily question is "what is paying for this window, and switch it", and the
 * half of it that is not a name is this. Every line says how the figure was
 * learned and how old it is, because a Utilization on its own invites a decision
 * it cannot support: a Seat read at 10% four hours ago and one read at 10% a
 * second ago are not the same Seat.
 *
 * Pure. The moment is an argument, so this is a table in a test.
 */

/** Past this, a reading is old enough that saying so changes a decision. */
const AN_HOUR = 60 * 60;

/**
 * The two windows, session first and week second, everywhere.
 *
 * One order, in one place, because the session is the window that stops work in
 * the next hour and the week is the one that decides which Seat to move to next.
 * The menu bar, the panel on Linux, the command line and the page all read this,
 * so none of them can put them in an order of its own.
 */
const WINDOWS = [
  { key: "fiveHour", called: "the 5-hour window" },
  { key: "sevenDay", called: "the week" },
] as const;

/** One window as a line, or null when nothing is known about it. */
function line(known: AllowanceKnown | null, called: string, at: number): string | null {
  if (known === null) return null;

  const spent = known.hasReset
    ? `${called}: reset, nothing spent`
    : `${called}: ${asPercent(known.utilization)} spent`;

  // Counted from now, not from when the figure was read. A reading taken an hour
  // ago whose window had two hours left has one hour left, and saying two is how
  // a Seat looks like capacity it no longer has.
  const resets =
    known.resetsAt === null || known.hasReset ? "" : `, resets in ${asSpan(Math.max(0, known.resetsAt - at))}`;

  const via = known.readVia === "exchange" ? "from a reply" : "read on the side";
  return `${spent}${resets}  (${via}, ${asAge(known.ageSeconds)})`;
}

/**
 * What is known about one Seat's room, as lines, or the one honest line when
 * nothing is known.
 *
 * "Nothing is known yet" rather than a row of zeroes. A Send token cannot read
 * usage from any endpoint, so a Seat that has not paid for anything and has not
 * been read on the side genuinely has no figure, and printing 0% would be the
 * app inventing capacity it has never seen.
 */
export function roomFor(usage: SeatUsage | undefined, at: number): readonly string[] {
  if (usage === undefined) return ["nothing is known about what it has spent yet"];

  const lines = WINDOWS.map(({ key, called }) => line(usage[key], called, at)).filter(
    (one): one is string => one !== null,
  );

  const cooling = Object.entries(usage.cooldowns);
  for (const [model, until] of cooling) {
    lines.push(`left alone for ${model} for another ${asSpan(Math.max(0, until - at))}, after it refused`);
  }

  return lines.length === 0 ? ["nothing is known about what it has spent yet"] : lines;
}

/**
 * How much room a Seat has, in one line, said so that it cannot be misread.
 *
 * The line this replaces was `5h 8%  7d 1%`, and it was wrong in three ways at
 * once. It never said whether the percentage was spent or left. It put a duration
 * where a window's *name* belonged, so `7d 1%` read as "one percent in seven
 * days" rather than "one percent of the week". And it never said when either
 * window turns over, which is the half of the answer that decides anything: a
 * Seat at 90% that resets in ten minutes is worth more than a Seat at 40% with
 * six days to run.
 *
 * So: the window by a letter, the share as spent, and when it comes back.
 *
 *     s 8% · in 2h 6m   w 1% · in 6d 8h
 *
 * `s` is the session, which is what the five-hour window is for anybody using it,
 * and `w` is the week. The session comes first because it is the window that stops
 * work within the hour. The letters are explained wherever there is room for a
 * legend, and never left to be guessed at in the only place they appear.
 */

/** The two windows, under the letters the brief uses. Session first, then the week. */
const BRIEF_WINDOWS = [
  { key: "fiveHour", letter: "s", called: "Session" },
  { key: "sevenDay", letter: "w", called: "Week" },
] as const;

/** The legend, so the letters are never the reader's problem. */
export const WHAT_THE_LETTERS_MEAN =
  "s = the 5-hour session, w = the week. The percentage is spent, then when it resets. " +
  "A Seat only reports while it is paying, so the relay asks the quiet ones every quarter hour; " +
  '"read 2h ago" beside a Seat means even that did not get through.';

function part(known: AllowanceKnown | null, letter: string, at: number): string | null {
  if (known === null) return null;
  // A window that has turned over holds no share at all, and saying "0%" of a
  // window that no longer exists is how capacity looks spent when it is whole.
  if (known.hasReset) return `${letter} fresh`;

  const spent = asPercent(known.utilization);
  // Counted from now, not from when the figure was read: a reading taken an hour
  // ago whose window had two hours left has one hour left.
  if (known.resetsAt === null) return `${letter} ${spent}`;
  return `${letter} ${spent} · in ${asSpan(Math.max(0, known.resetsAt - at))}`;
}

/** The oldest of the readings this line is built from, or null when there are none. */
function oldest(usage: SeatUsage): number | null {
  const ages = [usage.sevenDay?.ageSeconds, usage.fiveHour?.ageSeconds].filter(
    (age): age is number => age !== undefined,
  );
  return ages.length === 0 ? null : Math.max(...ages);
}

/**
 * The same figures as separate pieces, for anything laying out a table.
 *
 * A table needs its columns padded to a common width, and it cannot do that with
 * one string that has already been joined: the first version padded the whole
 * brief to a fixed 16 and the organization column came out ragged, because these
 * lines are not all the same length and never will be.
 */
export function roomColumns(usage: SeatUsage | undefined, at: number): {
  readonly session: string;
  readonly week: string;
  readonly age: string;
} {
  if (usage === undefined) return { session: "no reading yet", week: "", age: "" };

  const age = oldest(usage);
  return {
    session: part(usage.fiveHour, "s", at) ?? "",
    week: part(usage.sevenDay, "w", at) ?? "",
    age: age !== null && age > AN_HOUR ? `read ${asAge(age)}` : "",
  };
}

/**
 * One line, for a menu row or a list.
 *
 * The age is here only when it is old enough to change a decision. A timestamp on
 * every row is a texture the eye stops reading, and then the one row where it
 * matters is invisible too.
 */
export function roomBrief(usage: SeatUsage | undefined, at: number): string {
  if (usage === undefined) return "no reading yet";

  const parts = BRIEF_WINDOWS.map(({ key, letter }) => part(usage[key], letter, at)).filter(
    (one): one is string => one !== null,
  );
  if (parts.length === 0) return "no reading yet";

  // Said only when it is old enough to change a decision, and said as what it is.
  // "(1h 27m ago)" was the first version and it never said *what* was an hour old;
  // the first person to read it asked whether the window had reset then. The relay
  // now asks every stale Seat what it has spent, so this is rare and means
  // something is wrong rather than being the ordinary state of the screen.
  const age = oldest(usage);
  const stale = age !== null && age > AN_HOUR ? `  read ${asAge(age)}` : "";
  return `${parts.join("   ")}${stale}`;
}

/**
 * The same thing in whole words, for somewhere with room for them.
 *
 * The tooltip is one line and nobody is squinting at a column of them, so it
 * spells out what the letters stand for rather than relying on a legend that is
 * not on screen at the time.
 */
export function roomSpelled(usage: SeatUsage | undefined, at: number): string {
  if (usage === undefined) return "nothing is known about what it has spent yet";

  const said = BRIEF_WINDOWS.map(({ key, called }) => {
    const known = usage[key];
    if (known === null) return null;
    if (known.hasReset) return `${called}: reset, nothing spent`;
    const resets = known.resetsAt === null ? "" : `, resets in ${asSpan(Math.max(0, known.resetsAt - at))}`;
    return `${called}: ${asPercent(known.utilization)} spent${resets}`;
  }).filter((one): one is string => one !== null);

  if (said.length === 0) return "nothing is known about what it has spent yet";

  const age = oldest(usage);
  return `${said.join(". ")}${age === null ? "" : `. Read ${asAge(age)}.`}`;
}
