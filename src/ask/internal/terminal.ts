/** What the terminal sends for the keys this has to understand. */
const ENTER = ["\r", "\n"];
const BACKSPACE = ["\x7f", "\b"];
const INTERRUPT = "\x03";
const END_OF_INPUT = "\x04";

/** The conventional exit code for a program the user interrupted. */
const INTERRUPTED = 130;

/** Whether the terminal has been taken off line-at-a-time behaviour right now. */
let holding = false;

function letGo(): void {
  if (!holding) return;
  holding = false;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

/**
 * Put the terminal back, whatever happens.
 *
 * A process that exits while the terminal is still in raw mode leaves the user's
 * shell with no echo and no line editing, which looks like the shell has broken
 * and is fixed only by typing `reset` blind. Every way out of this program is
 * covered, including the ones that are not ours: an uncaught error and a signal.
 */
process.once("exit", letGo);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    letGo();
    process.exit(INTERRUPTED);
  });
}

/** Restore the terminal and let the process end. */
export function stopAsking(): void {
  letGo();
}

/**
 * What arrived after the last line was taken.
 *
 * Kept between calls, because input does not arrive one line per chunk: a whole
 * script's worth can land in a single read. Throwing away the rest of the chunk
 * would swallow every answer after the first, and the flow would then sit waiting
 * for input that had already been given.
 */
let leftover = "";

/** The next whole line out of `leftover`, or null when there is not one yet. */
function nextLine(): string | null {
  const end = leftover.search(/[\r\n]/);
  if (end === -1) return null;

  const line = leftover.slice(0, end);
  // A carriage return and the newline after it are one ending, not two, or the
  // next answer would read as the empty one that means "stop".
  const after = leftover[end] === "\r" && leftover[end + 1] === "\n" ? end + 2 : end + 1;
  leftover = leftover.slice(after);
  return line;
}

/**
 * One line back, letting the terminal echo it as it always does.
 *
 * For answers that are not credentials: a number picked off a list, a yes or a
 * no. The terminal is left in its ordinary line-at-a-time mode, so the user keeps
 * their own editing keys, which is the whole difference from `askSecretly`.
 */
export function askOutLoud(): Promise<string> {
  const already = nextLine();
  if (already !== null) return Promise.resolve(already);

  return new Promise<string>((resolve) => {
    const take = (chunk: Buffer | string) => {
      leftover += chunk.toString();
      const line = nextLine();
      if (line === null) return;
      process.stdin.off("data", take);
      process.stdin.pause();
      resolve(line);
    };

    process.stdin.on("data", take);
    // Nothing more is coming: whatever is left is the last answer, and an empty
    // one is how the caller is told to stop.
    process.stdin.once("end", () => {
      process.stdin.off("data", take);
      const rest = leftover;
      leftover = "";
      resolve(rest);
    });
    process.stdin.resume();
  });
}

/**
 * Read one secret line back from the terminal without showing it.
 *
 * This writes nothing at all, not even the prompt, which is why the caller prints
 * that itself and prints the newline afterwards. Nothing under `src` may write to
 * the console, so that a message body can never reach one, and a module that
 * handles a pasted credential is the last place to make an exception.
 *
 * An empty answer is how the user says they are done, which is why Enter on its
 * own is a valid reply rather than a mistake.
 *
 * When nothing is attached to the terminal the answer is read a line at a time
 * instead, because there is no echo to suppress and raw mode on a pipe fails.
 */
export async function askSecretly(): Promise<string> {
  if (!process.stdin.isTTY) return askOutLoud();

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  holding = true;

  const answered = await new Promise<string>((resolve) => {
    let held = "";

    const take = (chunk: string) => {
      for (const key of chunk) {
        if (ENTER.includes(key)) {
          process.stdin.off("data", take);
          resolve(held);
          return;
        }
        if (key === INTERRUPT) {
          letGo();
          process.exit(INTERRUPTED);
        }
        // Nothing more is coming. Treated as Enter, so a closed input ends the
        // sitting cleanly rather than leaving the flow waiting forever.
        if (key === END_OF_INPUT) {
          process.stdin.off("data", take);
          resolve(held);
          return;
        }
        if (BACKSPACE.includes(key)) {
          held = held.slice(0, -1);
          continue;
        }
        held += key;
      }
    };

    process.stdin.on("data", take);
  });

  letGo();
  return answered;
}
