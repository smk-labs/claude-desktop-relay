/**
 * What the work would have cost at API rates. Data, with its own date.
 *
 * A subscription is not per-token, so nothing here is what the user paid. It is
 * what the same work would have cost had it gone through the API, which is the only
 * comparable number there is, and every place it is shown says so.
 *
 * No money is ever written into a history row. Costs are computed when they are
 * read, so correcting a rate here corrects every past total rather than leaving the
 * old ones wrong for ever.
 */

/** Dollars per million tokens, for one model. */
export type Rate = {
  readonly input: number;
  readonly output: number;
};

export type PriceTable = {
  /** When these rates were published, as `YYYY-MM`. Shown wherever a cost is. */
  readonly on: string;
  /** Where the numbers came from, so a reader can check them. */
  readonly from: string;
  readonly rates: Readonly<Record<string, Rate>>;
  /**
   * What the cache costs, as multiples of that model's input rate, which is how
   * they are published rather than a convenience.
   */
  readonly cache: {
    /** Writing a five-minute entry. */
    readonly written: number;
    /** Reading from an entry. */
    readonly read: number;
  };
};

/**
 * The published rates as of 2026-06.
 *
 * Keyed by a prefix of the model name rather than the whole thing, because the
 * server names a dated build (`claude-haiku-4-5-20251001`) and pinning every build
 * would mean a model priced as unknown the day a new build ships.
 */
export const PUBLISHED: PriceTable = {
  on: "2026-06",
  from: "Anthropic's published per-million-token rates",
  rates: {
    "claude-fable-5": { input: 10, output: 50 },
    "claude-opus-5": { input: 5, output: 25 },
    "claude-opus-4": { input: 5, output: 25 },
    "claude-sonnet-5": { input: 3, output: 15 },
    "claude-sonnet-4": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 1, output: 5 },
  },
  cache: { written: 1.25, read: 0.1 },
};

/**
 * The rate for a model, or null when the table does not know it.
 *
 * Null, never a guess. A model priced at a rate nobody published produces a total
 * that looks authoritative and is invented, which is worse than a total with a gap
 * in it that says so.
 */
export function rateFor(model: string | null, table: PriceTable = PUBLISHED): Rate | null {
  if (model === null) return null;
  // The longest matching prefix wins, so `claude-opus-4-5` prefers an entry for
  // `claude-opus-4-5` over one for `claude-opus-4` when both exist.
  let best: { key: string; rate: Rate } | null = null;
  for (const [key, rate] of Object.entries(table.rates)) {
    if (!model.startsWith(key)) continue;
    if (best === null || key.length > best.key.length) best = { key, rate };
  }
  return best?.rate ?? null;
}

/** What one row of counts would have cost at API rates, or null for an unknown model. */
export function costOf(
  options: {
    readonly model: string | null;
    readonly input: number;
    readonly output: number;
    readonly cacheWritten: number;
    readonly cacheRead: number;
  },
  table: PriceTable = PUBLISHED,
): number | null {
  const rate = rateFor(options.model, table);
  if (rate === null) return null;

  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    options.input * perToken(rate.input) +
    options.output * perToken(rate.output) +
    options.cacheWritten * perToken(rate.input * table.cache.written) +
    options.cacheRead * perToken(rate.input * table.cache.read)
  );
}
