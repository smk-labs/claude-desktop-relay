import { readJsonFile, writeJsonFile } from "../../json-file/index.ts";
import { asOf, foldExchange, foldReading, nothingKnown, seatTaughtBy, stillCooling } from "./known.ts";

import type { Exchange } from "../../relay/index.ts";
import type { UsageAsRead } from "../../stats-login/index.ts";
import type { SeatMemory, SeatUsage } from "./known.ts";

type OnDisk = { readonly seats: Readonly<Record<string, SeatMemory>> };

export type UsageMemory = {
  /**
   * Fold one exchange in. Everything the reply can teach about the Seat it names,
   * and nothing it cannot: see `seatTaughtBy` and `refusalIsAboutTheSeat`.
   */
  rememberExchange(exchange: Exchange, at: number): Promise<void>;
  /**
   * Fold in a reading taken through a Stats login, which is the only news a Seat
   * that is sitting idle ever has.
   */
  rememberReading(seat: string, usage: UsageAsRead, at: number): Promise<void>;
  /** What is known about every Seat, as of one moment. Dated, never bare. */
  known(at: number): Promise<readonly SeatUsage[]>;
};

/**
 * What is known about every Seat's allowance, kept on disk.
 *
 * Held in memory and written through, for two reasons. Twelve exchanges can land
 * together, and a read-modify-write of a file per exchange would lose whichever
 * updates finished in the wrong order; and a Chooser asked on every request must
 * not wait on a disk read. Every write is queued behind the last, so the file is
 * always a whole picture rather than an interleaving of two.
 */
export function openUsageMemory(options: { file: string }): UsageMemory {
  const { file } = options;

  let held: Map<string, SeatMemory> | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  /** One at a time, in the order asked. Errors do not poison the queue. */
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };

  async function load(): Promise<Map<string, SeatMemory>> {
    if (held !== null) return held;
    const onDisk = await readJsonFile<OnDisk>(file);
    const seats = onDisk?.seats;
    held = new Map(
      typeof seats === "object" && seats !== null
        ? Object.entries(seats).map(
            ([seat, memory]) =>
              [
                seat,
                // The file is ours, but it is also editable by hand, and a
                // `cooldowns` that is not an object would throw on every read
                // afterwards rather than at the moment it was written.
                {
                  ...nothingKnown(),
                  ...memory,
                  cooldowns: typeof memory?.cooldowns === "object" && memory.cooldowns !== null ? memory.cooldowns : {},
                },
              ] as const,
          )
        : [],
    );
    return held;
  }

  /** Expired cooldowns are dropped on the way out, so the file cannot only grow. */
  async function save(memory: Map<string, SeatMemory>, at: number): Promise<void> {
    const seats: Record<string, SeatMemory> = {};
    for (const [seat, one] of memory) seats[seat] = { ...one, cooldowns: stillCooling(one.cooldowns, at) };
    await writeJsonFile(file, { seats } satisfies OnDisk);
  }

  const change = (seat: string, at: number, fold: (was: SeatMemory) => SeatMemory) =>
    inTurn(async () => {
      const memory = await load();
      const was = memory.get(seat) ?? nothingKnown();
      const now = fold(was);
      memory.set(seat, now);
      await save(memory, at);
    });

  return {
    async rememberExchange(exchange, at) {
      // Which Seat an exchange is allowed to teach about is the subtle part, and
      // it is a pure rule kept in one place rather than a condition written here.
      const seat = seatTaughtBy(exchange);
      if (seat === null) return;
      await change(seat, at, (was) => foldExchange(was, exchange, at));
    },

    rememberReading(seat, usage, at) {
      return change(seat, at, (was) => foldReading(was, usage, at));
    },

    known: (at) =>
      inTurn(async () => {
        const memory = await load();
        return [...memory].map(([seat, one]) => asOf(seat, one, at));
      }),
  };
}
