import { roomFor } from "./room.ts";
import { CALLED, whatToTypeNext } from "./surface.ts";

import type { Choice } from "../../payer/index.ts";
import type { ListedSeat } from "../../seats/index.ts";
import type { SeatUsage } from "../../usage/index.ts";
import type { Standing } from "../../payer/index.ts";
import type { Verdict } from "../../verify/index.ts";
import type { Examination } from "./machine.ts";
import { describeVerdict } from "../../verify/index.ts";
import { roomColumns, WHAT_THE_LETTERS_MEAN } from "./room.ts";

/** Everything the answer is built from. No I/O and no clock: a table in a test. */
export type WhatIsGoingOn = {
  readonly choice: Choice;
  readonly seats: readonly ListedSeat[];
  readonly usage: readonly SeatUsage[];
  readonly verdict: Verdict | null;
  readonly examination: Examination;
  /** Whether a Window is open right now, which changes what to do next. */
  readonly windowRunning: boolean;
  /**
   * When the Send tokens were last backed up, or null when they never were.
   *
   * On the screen because on 2026-08-22 every one of them was lost to one wrong
   * command with nothing to restore from, and the rule to take a backup lived in a
   * document instead of in the program. A rule nobody is reminded of is a wish.
   */
  readonly backedUpOn: string | null;
  /** What Auto last settled on, or null when nothing has asked yet. */
  readonly standing: Standing | null;
  /** Seconds since 1970. */
  readonly at: number;
};

/**
 * The four things a person wants when they type one word: which Seat is paying,
 * how much room it has, whether the mechanism is live, and what to type next.
 *
 * Pure, and it returns lines rather than printing them, so the whole screen is
 * asserted as a table. The order is deliberate: the answer first, then the
 * evidence, then what to do. A status that opens with diagnostics makes the
 * reader hunt for the one line they came for.
 */
export function statusLines(what: WhatIsGoingOn): readonly string[] {
  const { choice, examination } = what;
  const off = choice.mode === "off" || (choice.mode === "manual" && choice.payer === null);
  const lines: string[] = [];

  /**
   * Never a claim of who is paying while any part is broken.
   *
   * The choice on disk says one thing; whether a request could reach a Seat at
   * all is another. Reporting the first as the second is how a user finds out
   * from a bill instead of from the app.
   */
  if (!examination.working) {
    lines.push(`Paying: not known, because the mechanism is not working.`);
    lines.push("");
    for (const finding of examination.findings) {
      if (!finding.ok) lines.push(`  NO  ${finding.what}: ${finding.saying}`);
    }
    lines.push("");
    lines.push(`  ${CALLED} doctor    every part of it, the ones that hold as well`);
    return lines;
  }

  if (choice.mode === "auto") {
    lines.push(`Paying: whichever Seat has the most room, weighed again on every request.`);
    if (what.standing === null) {
      lines.push(`  nothing has asked yet, so nothing has been chosen`);
    } else {
      lines.push(`  ${what.standing.seat ?? "the Window account"}`);
      for (const line of roomFor(
        what.usage.find((held) => held.seat === what.standing?.seat),
        what.at,
      )) {
        lines.push(`    ${line}`);
      }
    }
  } else if (off) {
    lines.push(`Paying: the Window account. Nothing is being swapped.`);
  } else {
    const seat = what.seats.find((held) => held.name === choice.payer);
    lines.push(`Paying: ${choice.payer}${seat === undefined ? "" : `  (${seat.multiplier}x, ${seat.organization.label})`}`);

    // The half of the daily question that is not a name.
    for (const line of roomFor(
      what.usage.find((one) => one.seat === choice.payer),
      what.at,
    )) {
      lines.push(`  ${line}`);
    }

    if (seat === undefined) {
      lines.push(`  there is no Seat by that name any more, so requests are landing on the Window account`);
    } else if (!seat.hasSendToken) {
      lines.push(`  it has no Send token, so requests are landing on the Window account`);
    }
  }

  lines.push("");
  lines.push(`Mechanism: live, and the relay is answering.`);
  lines.push(
    what.verdict === null
      ? off
        ? `Last: nothing is being swapped, so there is nothing to prove.`
        : `Last: no request has been paid for by a Seat yet.`
      : `Last: ${describeVerdict(what.verdict)}`,
  );

  if (!what.windowRunning) {
    lines.push("");
    lines.push(`Claude Desktop is not running. Open it and every Code session in it is relayed.`);
  }

  const held = what.seats.filter((seat) => seat.hasSendToken).length;
  if (held > 0 && what.backedUpOn === null) {
    lines.push("");
    lines.push(`${held} Send tokens are held and none of them is backed up anywhere.`);
    lines.push(`Each one is a sign-in by hand as its own account, and nothing here can mint them again.`);
    lines.push(`  ${CALLED} back-up-seats`);
  }

  lines.push("");
  lines.push("Next:");
  for (const line of whatToTypeNext({ mode: choice.mode, hasAPick: choice.payer !== null })) lines.push(line);

  return lines;
}

/** Every Seat, one to a line, marked, with what each has left. */
export function seatLines(what: {
  readonly choice: Choice;
  readonly seats: readonly ListedSeat[];
  readonly usage: readonly SeatUsage[];
  readonly backedUpOn: string | null;
  /** The moment the room is counted from, because "resets in" is counted from now. */
  readonly at: number;
  /**
   * Why the home this read is empty, when that is the real answer. Null when the
   * list is empty because no Seat has been collected yet. `whyThisHomeLooksEmpty`.
   */
  readonly emptyHome?: string | null;
}): readonly string[] {
  if (what.seats.length === 0) {
    // An unset variable and an unfilled home look identical here, and only one of
    // them is fixed by collecting Seats.
    if (what.emptyHome != null) return ["No Seats here.", "", what.emptyHome];
    return ["No Seats have been added yet.", "", `  ${CALLED} collect-seats   fill them from your own logins`];
  }

  const off = what.choice.mode !== "manual" || what.choice.payer === null;
  const widest = Math.max(...what.seats.map((seat) => seat.name.length));

  // Worth the most first, so the Seat with the biggest allowance is the one a
  // reader's eye lands on. Ties by name, so the order never changes between runs.
  const sorted = [...what.seats].sort((a, b) => b.multiplier - a.multiplier || a.name.localeCompare(b.name));

  const held = what.seats.filter((seat) => seat.hasSendToken).length;
  const footer = [
    "",
    // The legend, in the one place the letters appear. A brief nobody can read is
    // worse than a longer line that says what it means.
    WHAT_THE_LETTERS_MEAN,
    ...(held === 0
      ? []
      : what.backedUpOn === null
        ? [`None of the ${held} Send tokens is backed up. Take one:  ${CALLED} back-up-seats`]
        : [`${held} Send tokens, last backed up ${what.backedUpOn}.`]),
  ];

  // Measured before anything is written, so every column lines up. A list whose
  // last column starts in a different place on every row is a list the eye has to
  // read one row at a time.
  const room = sorted.map((seat) => roomColumns(what.usage.find((one) => one.seat === seat.name), what.at));
  const widthOf = (of: (one: (typeof room)[number]) => string) => Math.max(0, ...room.map((one) => of(one).length));
  const sessionWide = widthOf((one) => one.session);
  const weekWide = widthOf((one) => one.week);
  const ageWide = widthOf((one) => one.age);

  return [...sorted.map((seat, i) => {
    const paying = !off && seat.name === what.choice.payer;
    const has = room[i] ?? { session: "", week: "", age: "" };
    const note = seat.hasSendToken ? "" : "  (no Send token)";
    return (
      `${paying ? "*" : " "} ${seat.name.padEnd(widest)}  ${`${seat.multiplier}x`.padEnd(6)}  ` +
      `${has.session.padEnd(sessionWide)}  ${has.week.padEnd(weekWide)}  ${has.age.padEnd(ageWide)}  ` +
      `${seat.organization.label}${note}`
    );
  }), ...footer];
}
