import { open, rename, stat, type FileHandle } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * How much of its own log the relay is allowed to keep, live and kept together.
 *
 * Stated here, once, because a bound that lives in a comment is not a bound. Eight
 * megabytes is roughly a month of ordinary use at one line an exchange, and it is
 * chosen against a machine that has already run out of disk once: the failure this
 * prevents is slow, certain, and arrives as something unrelated breaking.
 */
export const AT_MOST_BYTES = 8 * 1024 * 1024;

/**
 * Two generations, so a rotation never throws away the most recent lines.
 *
 * The live file is allowed half the bound. When it fills, it becomes the kept
 * generation and the previous kept generation is the only thing ever discarded,
 * which is always the older half of everything there is.
 */
const GENERATIONS = 2;

export type Journal = {
  /**
   * One line, at a stated moment.
   *
   * Never awaited by the caller and never able to throw at one. A log that can
   * stop the relay is worse than no log, and the thing being logged is always
   * worth less than the request it is about.
   */
  say(line: string, at?: number): void;
  /** Everything said so far is on disk. For a clean shutdown, and for tests. */
  settled(): Promise<void>;
  /** How many bytes are held in total, live plus the kept generation. */
  held(): Promise<number>;
  close(): Promise<void>;
};

/** Where the kept generation lives. One name, derived, never configured. */
export const keptBeside = (file: string): string => `${file}.1`;

/**
 * The relay's own log, bounded.
 *
 * It writes its own log rather than letting the service capture its output,
 * because a file the service holds open cannot be rotated from in here: renaming
 * it leaves the service writing to a name that no longer exists, and truncating it
 * leaves a hole the size of everything that was there. Owning the file is what
 * makes the bound possible at all.
 *
 * Every line goes through one queue, so a rotation cannot land between the two
 * halves of a line and no line said before a rotation is lost by it. That matters
 * here rather than in theory: twelve exchanges can finish together.
 *
 * This is the log, and not the record. It is for a person reading what just
 * happened, so lines aging out of it is the point. Anything that has to survive
 * belongs in the usage history, which is a different file for exactly this reason.
 */
export function openJournal(options: {
  file: string;
  /** Total bytes, live and kept together. Defaults to `AT_MOST_BYTES`. */
  atMostBytes?: number;
  /** Told when a line could not be written, which must never stop the relay. */
  onProblem?: (summary: string) => void;
}): Journal {
  const { file } = options;
  const liveAtMost = Math.max(1, Math.floor((options.atMostBytes ?? AT_MOST_BYTES) / GENERATIONS));

  let handle: FileHandle | null = null;
  /** Bytes in the live file. Read from disk once, so a restart continues the count. */
  let live = 0;
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();

  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };

  async function opened(): Promise<FileHandle> {
    if (handle !== null) return handle;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // The bound survives a restart because the size is read rather than assumed.
    live = await stat(file).then(
      (found) => found.size,
      () => 0,
    );
    // Appending, so two writers can never interleave half a line, and so nothing
    // here has to track an offset of its own.
    handle = await open(file, "a", 0o600);
    return handle;
  }

  /** The live file becomes the kept one, and the older kept one is let go. */
  async function rotate(): Promise<void> {
    await handle?.close();
    handle = null;
    await rename(file, keptBeside(file));
    live = 0;
  }

  return {
    say(line, at) {
      if (closed) return;
      const stamped = `${new Date((at ?? Math.trunc(Date.now() / 1000)) * 1000).toISOString()}  ${line}\n`;
      const bytes = Buffer.byteLength(stamped);

      void inTurn(async () => {
        let held = await opened();
        // Rotated before the line is written, never after, so the live file is
        // never over the bound even for an instant.
        if (live > 0 && live + bytes > liveAtMost) {
          await rotate();
          held = await opened();
        }
        await held.write(stamped);
        live += bytes;
      }).catch((error: unknown) => {
        options.onProblem?.(`a line could not be written to ${file}: ${error instanceof Error ? error.message : String(error)}`);
      });
    },

    settled: () => inTurn(async () => {}),

    held: () =>
      inTurn(async () => {
        const sizes = await Promise.all(
          [file, keptBeside(file)].map((one) =>
            stat(one).then(
              (found) => found.size,
              () => 0,
            ),
          ),
        );
        return sizes.reduce((all, one) => all + one, 0);
      }),

    close: () =>
      inTurn(async () => {
        closed = true;
        await handle?.close();
        handle = null;
      }),
  };
}
