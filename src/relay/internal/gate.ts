/**
 * How many exchanges the relay will have in the air at once, and the queue for
 * the rest.
 *
 * This exists because of a measured collapse rather than a theory. On 2026-08-22
 * the relay held 86 exchanges at once, each on its own connection through the
 * machine's proxy. The far end could not work on 86 things, so most of them sat
 * in silence waiting their turn; the proxy cannot tell a queued tunnel from a
 * dead one, so it hung up on them. 190 requests failed, and every one of them
 * was a request that would have succeeded had it been asked a moment later.
 *
 * That is congestion collapse, and the cure for congestion collapse is never a
 * bigger timeout. It is asking for less at once. A queue here costs a request a
 * short wait; no queue costs it the whole request.
 */
export type Gate = {
  /**
   * Wait for a turn. Resolves with the function that gives the turn back, which
   * must be called exactly once however the exchange ends.
   */
  enter(): Promise<() => void>;
  /** How many are in the air right now. */
  inFlight(): number;
  /**
   * The bound itself.
   *
   * On the interface because the connection pool has to agree with it: a pool that
   * allowed fewer connections than the gate allows exchanges would queue behind
   * itself, and one that allowed more would make the bound not a bound.
   */
  limit(): number;
  /** How many are waiting for a turn. */
  waiting(): number;
  /** The most that were ever in the air at once. */
  mostAtOnce(): number;
  /** Let everything waiting go, for shutdown. */
  release(): void;
};

/**
 * Twelve at once, which is a judgement and worth stating as one.
 *
 * A Code session with parallel agents genuinely wants dozens of requests served,
 * and it gets them: this bounds how many are *in flight*, not how many are
 * served. Twelve keeps the route far from the point where the proxy loses
 * patience, and the queue behind it drains in the time one exchange takes. The
 * number that failed was 86.
 */
export const AT_MOST_IN_FLIGHT = 12;

export function openGate(atMost: number = AT_MOST_IN_FLIGHT): Gate {
  const limit = Number.isInteger(atMost) && atMost > 0 ? atMost : AT_MOST_IN_FLIGHT;
  const queue: Array<() => void> = [];
  let inFlight = 0;
  let mostAtOnce = 0;

  /**
   * Guarded against being given back twice.
   *
   * A turn returned twice is worse than one never returned: it lets two
   * exchanges through for one slot, and the bound quietly stops being a bound.
   * The exchange path has several ways to end and they can race, so this is
   * enforced here rather than trusted there.
   */
  const turnFor = () => {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      inFlight -= 1;
      queue.shift()?.();
    };
  };

  return {
    inFlight: () => inFlight,
    limit: () => limit,
    waiting: () => queue.length,
    mostAtOnce: () => mostAtOnce,

    async enter() {
      if (inFlight >= limit) await new Promise<void>((resolve) => queue.push(resolve));
      inFlight += 1;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      return turnFor();
    },

    release() {
      while (queue.length > 0) queue.shift()?.();
    },
  };
}
