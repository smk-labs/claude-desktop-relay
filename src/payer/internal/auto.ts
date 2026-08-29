import { readJsonFile, writeJsonFile } from "../../json-file/index.ts";
import { choose, type Because, type Pick } from "../../chooser/index.ts";

import type { ListedSeat } from "../../seats/index.ts";
import type { SeatUsage } from "../../usage/index.ts";

/**
 * How long the last decision is worth reporting after it was made.
 *
 * A Payer nobody has used for half a day is not a claim worth putting on a status
 * line: it names a Seat for work that is not happening.
 */
const FORGET_AFTER_SECONDS = 12 * 60 * 60;

/** The Payer as it stands: one value for the machine, not one per conversation. */
export type Standing = {
  readonly seat: string | null;
  readonly because: Because;
  /** When this was decided. */
  readonly at: number;
};

/**
 * Where the standing is written, and why it is written at all.
 *
 * The relay decides who pays and holds it in memory. Everything that asks "what is
 * paying right now" is a different process: the command a person types, and the
 * page the service serves. So the answer is put on disk as it changes, once per
 * change rather than once per request, and read from there.
 */
export type OnDisk = { readonly standing: Standing | null };

export async function writeStanding(file: string, standing: Standing | null): Promise<void> {
  await writeJsonFile(file, { standing } satisfies OnDisk);
}

/** What Auto last settled on, or null when it is stale or was never written. */
export async function readStanding(
  file: string,
  at: number,
  forgetAfterSeconds = FORGET_AFTER_SECONDS,
): Promise<Standing | null> {
  const held = await readJsonFile<OnDisk>(file).catch(() => null);
  const standing = held?.standing ?? null;
  if (standing === null || typeof standing.at !== "number") return null;
  return at - standing.at <= forgetAfterSeconds ? standing : null;
}

export type Auto = {
  /** The Payer for one request, decided again from what is known right now. */
  decide(options: {
    readonly model: string | null;
    readonly seats: readonly ListedSeat[];
    readonly usage: readonly SeatUsage[];
    readonly at: number;
  }): Pick;
  /** What it last settled on, for a status line and for tests. */
  standing(): Standing | null;
};

/**
 * Auto: the best Seat, every request.
 *
 * It used to choose once per conversation and hold, to keep a prompt cache warm
 * (ADR 0003). That bought a warm cache and charged three things for it: a Payer
 * you chose that was not paying yet, a page that had to explain the delay, and a
 * Seat on screen nobody asked for. The cache saving is real and smaller than the
 * cost of not understanding your own tool, so the hold is gone: a change to the
 * Payer is in force on the very next request, including inside conversations that
 * are already running.
 *
 * The ranking is a pure function of what is known, so this does not flap: it moves
 * when the figures move, and that is exactly when it should.
 *
 * No clock and no I/O: the moment is an argument, and the Seats and what is known
 * about them are handed in per request.
 */
export function openAuto(): Auto {
  let settled: Standing | null = null;

  return {
    decide({ model, seats, usage, at }) {
      const pick = choose({ seats, usage, mode: "auto", picked: null, model, at });
      settled = { seat: pick.seat, because: pick.because, at };
      return pick;
    },

    standing: () => settled,
  };
}
