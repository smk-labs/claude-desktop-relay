/**
 * What one word answers: who is paying, how much room it has, and whether the
 * mechanism is live.
 *
 * A renderer of its own rather than the macOS one, for one reason: that screen
 * names commands this machine does not have. It ends with `whatToTypeNext`, which
 * spells every line `relay`, and the command here is `relay-linux`; its broken
 * branch adds `relay doctor` and its backup nag adds `relay back-up-seats`,
 * neither of which exists on Linux at all. A status that names commands a machine
 * does not have is worse than a shorter status.
 *
 * That is the whole of the fork. Everything it says about who is paying is the
 * same, including the two lines that take the claim back: a Seat that has been
 * removed and a Seat with no Send token both leave requests on the Window account,
 * and a screen reading `Paying: <seat>` over either of those is a bill somebody
 * finds out about from the bill.
 *
 * Pure. Lines out, nothing printed, no clock of its own.
 */
import { roomFor } from "../../src/control/internal/room.ts";
import { describeVerdict } from "../../src/verify/index.ts";

import type { Choice, Standing } from "../../src/payer/index.ts";
import type { ListedSeat } from "../../src/seats/index.ts";
import type { SeatUsage } from "../../src/usage/index.ts";
import type { Verdict } from "../../src/verify/index.ts";
import type { LinuxExamination } from "./examine.ts";

export type WhatIsGoingOn = {
  readonly choice: Choice;
  readonly seats: readonly ListedSeat[];
  readonly usage: readonly SeatUsage[];
  readonly verdict: Verdict | null;
  readonly standing: Standing | null;
  readonly examination: LinuxExamination;
  /** Seconds since 1970. */
  readonly at: number;
};

export function linuxStatusLines(what: WhatIsGoingOn): readonly string[] {
  const { choice, examination } = what;
  const lines: string[] = [];

  /**
   * Never a claim about who is paying while any part is broken. The file says
   * one thing; whether a request could reach a Seat at all is another, and
   * reporting the first as the second is how somebody finds out from a bill.
   */
  if (!examination.working) {
    lines.push(`Paying: not known, because the mechanism is not working.`);
    lines.push("");
    for (const finding of examination.findings) {
      lines.push(`  ${finding.ok ? "ok" : "NO"}  ${finding.what}: ${finding.saying}`);
    }
    return lines;
  }

  const roomUnder = (seat: string | null) => {
    for (const line of roomFor(what.usage.find((held) => held.seat === seat), what.at)) lines.push(`    ${line}`);
  };

  if (choice.mode === "off") {
    lines.push(`Paying: the Window account, because the relay is off.`);
  } else if (choice.mode === "auto") {
    lines.push(`Paying: whichever Seat has the most room, weighed again on every request.`);
    if (what.standing === null) {
      lines.push(`  nothing has asked yet, so nothing has been chosen`);
    } else {
      lines.push(`  ${what.standing.seat ?? "the Window account"}`);
      roomUnder(what.standing.seat);
    }
  } else if (choice.payer === null) {
    lines.push(`Paying: the Window account. The mode is manual and no Seat is picked.`);
  } else {
    // The Multiplier and the Organization, because the name alone does not say
    // what the Seat is worth or whose bill it lands on, and both are on the macOS
    // screen for that reason.
    const seat = what.seats.find((held) => held.name === choice.payer);
    const which = seat === undefined ? "" : ` (${seat.multiplier}x, ${seat.organization.label})`;
    lines.push(`Paying: ${choice.payer}${which}, picked by hand.`);
    roomUnder(choice.payer);

    // The pick on disk is not proof that the pick can pay. A Seat that was removed
    // and a Seat with no Send token both leave every request on the Window
    // account, and neither changes the file this line was read from.
    if (seat === undefined) {
      lines.push(`    there is no Seat by that name any more, so requests are landing on the Window account`);
    } else if (!seat.hasSendToken) {
      lines.push(`    it has no Send token, so requests are landing on the Window account`);
    }
  }

  lines.push("");
  for (const finding of examination.findings) lines.push(`  ok  ${finding.what}: ${finding.saying}`);

  // The server's own last word, which is the only proof of who paid. Absent
  // until a real exchange has been through, and said to be absent rather than
  // left out, because "no verdict yet" and "the verdict was fine" are different.
  lines.push("");
  lines.push(
    what.verdict === null
      ? `  Last verdict: none yet. Nothing has been through the relay since it was started.`
      : `  Last verdict: ${what.verdict.kind} - ${describeVerdict(what.verdict)}`,
  );

  return lines;
}
