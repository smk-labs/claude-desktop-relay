/**
 * Wait for something to become true, rather than for a length of time.
 *
 * A fixed sleep is the wrong tool for "the write has landed by now". It passes on
 * an idle machine and fails on a loaded one, and the usual repair is to make the
 * sleep longer, which makes the whole suite slower and still leaves the failure
 * waiting for a busier day. One of these did exactly that: fifty milliseconds,
 * green thousands of times, red once under a full parallel run.
 *
 * Nothing here waits on a clock the code under test can see. This is for facts
 * that arrive because of work that was deliberately not awaited: writing a verdict
 * or a usage figure is never allowed to slow an exchange down, so a test has to be
 * the thing that waits.
 */

/**
 * How long to keep asking before giving up and letting the assertion speak.
 *
 * Generous, and deliberately well under the runner's own `--test-timeout` of
 * twenty seconds. Set equal to it, the runner kills the test first and the
 * assertion below never gets to say what was missing, which is the whole reason
 * this returns instead of throwing.
 */
const GIVE_UP_AFTER_MS = 10_000;
const ASK_EVERY_MS = 5;

export async function until<T>(
  what: () => Promise<T | null | undefined> | T | null | undefined,
  options: { atMostMs?: number } = {},
): Promise<T | null> {
  const deadline = Date.now() + (options.atMostMs ?? GIVE_UP_AFTER_MS);

  for (;;) {
    const found = await what();
    if (found !== null && found !== undefined && found !== false) return found;
    // Returned rather than thrown, so the test's own assertion says what was
    // missing. A timeout that throws its own message hides the real one.
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, ASK_EVERY_MS));
  }
}

/** Wait until a count is reached, for the cases where nothing is on disk to read. */
export function untilThereAre(atLeast: number, held: () => { readonly length: number }): Promise<unknown> {
  return until(() => (held().length >= atLeast ? held().length : null));
}
