import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { dayOf, rolledUp, totalsBy, type Row, type Total } from "./rows.ts";
import { PUBLISHED, type PriceTable } from "./prices.ts";

/**
 * How long individual rows are kept before they are folded into daily totals.
 *
 * Long enough to answer "did that Seat reach 40% in an hour or over four days"
 * about anything recent, which is the question the history exists for. Past that
 * the timing inside a day stops being the question and the totals are what matter.
 */
export const KEEP_ROWS_FOR_DAYS = 45;

/** The periods anything asks about, in days. */
export const PERIODS = { day: 1, week: 7, month: 30 } as const;
export type Period = keyof typeof PERIODS;

export type History = {
  /**
   * Keep one exchange. Never awaited by the relay and never able to throw at it:
   * a record of spending is worth less than the request it is about.
   */
  keep(row: Row): Promise<void>;
  /** Every row from `since` onwards, oldest first. Readable with nothing running. */
  since(at: number): Promise<Row[]>;
  /** Totals per Seat over one period, ending at `at`. */
  perSeat(period: Period, at: number, table?: PriceTable): Promise<Total[]>;
  /** Totals per project over one period. Rows with no project yet are left out. */
  perProject(period: Period, at: number, table?: PriceTable): Promise<Total[]>;
  /** Totals per project crossed with Seat, which is the question ticket 19 asks. */
  perProjectAndSeat(period: Period, at: number, table?: PriceTable): Promise<Total[]>;
  /**
   * Fold rows older than the window into daily totals, exactly.
   *
   * Returns how many rows were replaced and by how many, so a caller can say what
   * happened rather than promising it did.
   */
  fold(at: number, keepForDays?: number): Promise<{ replaced: number; with: number }>;
  /**
   * Fill in the project of every row that still has none, from whatever can name
   * one now. Rows a name cannot be found for are left as they are, to be tried
   * again, rather than written as unknown for ever.
   */
  nameProjects(projectOf: (session: string) => Promise<string | null> | string | null): Promise<number>;
};

/**
 * Every exchange that was ever paid for by a Seat, as one row per line.
 *
 * Lines rather than one JSON document, for two reasons that both matter here. An
 * append is one write with no read before it, so keeping a row cannot lose the one
 * beside it under twelve concurrent exchanges. And a file that grows by lines can
 * be read by anything, including a person with `tail`, when the relay is not
 * running.
 *
 * A line that does not parse is skipped rather than fatal. A record that becomes
 * unreadable because of one bad line is a record nobody can use, and the one bad
 * line is usually the last one, half-written when the machine lost power.
 */
export function openHistory(options: { file: string }): History {
  const { file } = options;

  /**
   * Whether the file has been checked for a half-written last line.
   *
   * A machine that loses power mid-append leaves a line with no newline on the end,
   * and the next append glues a good row onto the broken one, so a crash costs two
   * rows instead of one. Checked once per process, on the first row kept, because
   * that is the only moment a truncated line can be there: the only writer is this
   * one, and it always ends what it writes.
   */
  let mended = false;

  let tail: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };

  async function every(): Promise<Row[]> {
    const text = await readFile(file, "utf8").catch(() => "");
    const rows: Row[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line) as Row;
        if (typeof row.at === "number" && typeof row.seat === "string") rows.push(row);
      } catch {
        // Skipped, deliberately. See the note on the module above.
      }
    }
    return rows.sort((a, b) => a.at - b.at);
  }

  const from = (period: Period, at: number) => at - PERIODS[period] * 24 * 60 * 60;

  async function totals(
    period: Period,
    at: number,
    by: (row: Row) => string | null,
    table: PriceTable | undefined,
  ): Promise<Total[]> {
    const rows = (await every()).filter((row) => row.at >= from(period, at) && row.at <= at);
    return totalsBy(rows, by, table ?? PUBLISHED);
  }

  return {
    async keep(row) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });

      if (!mended) {
        mended = true;
        // The last byte only. Reading the whole file to look at one character
        // would make the first row of a session cost as much as a month of them.
        const ending = await lastByteOf(file);
        if (ending !== null && ending !== "\n") await appendFile(file, "\n");
      }

      // One append, no read first, so twelve exchanges finishing together cannot
      // lose each other's rows the way a read-modify-write would.
      await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    },

    since: (at) => every().then((rows) => rows.filter((row) => row.at >= at)),

    perSeat: (period, at, table) => totals(period, at, (row) => row.seat, table),
    perProject: (period, at, table) => totals(period, at, (row) => row.project, table),
    perProjectAndSeat: (period, at, table) =>
      totals(period, at, (row) => (row.project === null ? null : `${row.project} on ${row.seat}`), table),

    fold: (at, keepForDays = KEEP_ROWS_FOR_DAYS) =>
      inTurn(async () => {
        const rows = await every();
        const keepFrom = at - keepForDays * 24 * 60 * 60;
        const older = rows.filter((row) => row.at < keepFrom).length;
        if (older === 0) return { replaced: 0, with: 0 };

        const folded = rolledUp({ rows, keepFrom });
        await writeWhole(file, folded);
        return { replaced: older, with: folded.length - rows.length + older };
      }),

    nameProjects: (projectOf) =>
      inTurn(async () => {
        const rows = await every();
        const named = new Map<string, string | null>();
        let filled = 0;

        const next: Row[] = [];
        for (const row of rows) {
          if (row.project !== null || row.session === null) {
            next.push(row);
            continue;
          }
          if (!named.has(row.session)) named.set(row.session, await projectOf(row.session));
          const project = named.get(row.session) ?? null;
          // Left alone rather than written as unknown, so a transcript that has not
          // been flushed yet is filled in on a later pass instead of lost.
          if (project === null) {
            next.push(row);
            continue;
          }
          next.push({ ...row, project });
          filled += 1;
        }

        if (filled > 0) await writeWhole(file, next);
        return filled;
      }),
  };
}

/** The last character of a file, or null when there is no file or it is empty. */
async function lastByteOf(file: string): Promise<string | null> {
  const handle = await open(file, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    const into = Buffer.alloc(1);
    await handle.read(into, 0, 1, size - 1);
    return into.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Replace the whole file, without ever leaving half of one behind.
 *
 * Written beside and moved into place. The two things that rewrite this file, the
 * fold and the project pass, are the only places a record of months can be lost,
 * so neither of them writes over it in place.
 */
async function writeWhole(file: string, rows: readonly Row[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const beside = join(dirname(file), `.${process.pid}.history.writing`);
  await writeFile(beside, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
  await rename(beside, file);
}

export { dayOf };
