/**
 * Every Seat and the room it has left, as lines.
 *
 * A list of its own rather than the macOS one, for two reasons that are both
 * about not lying to the reader. That one ends by telling them to run
 * `relay back-up-seats`, which does not exist here. And every command it names is
 * spelled `relay`, where the command on this machine is `relay-linux`.
 *
 * The columns are that list's columns, imported and not copied: `roomColumns` and
 * `WHAT_THE_LETTERS_MEAN` come from `src/control/internal/room.ts`, which is the
 * one place that decides how room is worded, so the two lists cannot describe the
 * same Seat differently.
 *
 * Pure. Lines out, nothing printed, no clock of its own.
 */
import { roomColumns, WHAT_THE_LETTERS_MEAN } from "../../src/control/index.ts";

import type { Choice } from "../../src/payer/index.ts";
import type { ListedSeat } from "../../src/seats/index.ts";
import type { SeatUsage } from "../../src/usage/index.ts";

export function linuxSeatLines(what: {
  readonly choice: Choice;
  readonly seats: readonly ListedSeat[];
  readonly usage: readonly SeatUsage[];
  /** What Auto settled on, so Auto's list marks a Seat too. */
  readonly standing: string | null;
  readonly backedUpOn: string | null;
  readonly at: number;
}): readonly string[] {
  if (what.seats.length === 0) {
    return ["No Seats have been added yet.", "", `  relay-linux restore-seats   put them back from a backup`];
  }

  const paying =
    what.choice.mode === "off" ? null : what.choice.mode === "auto" ? what.standing : what.choice.payer;

  const widest = Math.max(...what.seats.map((seat) => seat.name.length));

  // Worth the most first, ties by name, so the order never changes between runs.
  const sorted = [...what.seats].sort((a, b) => b.multiplier - a.multiplier || a.name.localeCompare(b.name));

  // Measured before anything is written, so every column lines up. A dozen rows
  // whose last column starts in a dozen different places is a list the eye has to
  // read one row at a time.
  const room = sorted.map((seat) => roomColumns(what.usage.find((one) => one.seat === seat.name), what.at));
  const widthOf = (pick: (one: (typeof room)[number]) => string) => Math.max(0, ...room.map((one) => pick(one).length));
  const sessionWide = widthOf((one) => one.session);
  const weekWide = widthOf((one) => one.week);
  const ageWide = widthOf((one) => one.age);

  const rows = sorted.map((seat, i) => {
    const mark = seat.name === paying ? "*" : " ";
    const has = room[i] ?? { session: "", week: "", age: "" };
    const note = seat.hasSendToken ? "" : "  (no Send token)";
    return (
      `${mark} ${seat.name.padEnd(widest)}  ${`${seat.multiplier}x`.padEnd(6)}  ` +
      `${has.session.padEnd(sessionWide)}  ${has.week.padEnd(weekWide)}  ${has.age.padEnd(ageWide)}  ` +
      `${seat.organization.label}${note}`
    );
  });

  const held = what.seats.filter((seat) => seat.hasSendToken).length;
  const footer = [
    "",
    WHAT_THE_LETTERS_MEAN,
    what.backedUpOn === null
      ? `None of the ${held} Send tokens is backed up, and on Linux they are in a plain file. Take one on the Mac.`
      : `${held} Send tokens, last backed up ${what.backedUpOn}.`,
  ];

  return [...rows, ...footer];
}
