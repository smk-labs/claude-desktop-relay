/**
 * The token counts of one reply, read off the bytes as they pass, and nothing
 * else taken.
 *
 * This module exists because of a gap in ticket 18's premise. The counts are not
 * in any reply header: every header on a real reply was captured in full on
 * 2026-08-21 and all thirteen are about allowance. So the counts are in the reply
 * body, which is the one place this program had no business being.
 *
 * What makes it safe is what it keeps. Four integers, and a rolling window of a
 * few hundred bytes that exists only to bridge a count split across two chunks and
 * is overwritten as it goes. A test writes a passphrase into every text field of a
 * real reply shape and asserts it appears in nothing this emits.
 */

/** What one reply cost, in tokens, as the server counted it. */
export type TokenCounts = {
  readonly input: number;
  readonly output: number;
  /** Tokens written into the cache, which are charged above the input rate. */
  readonly cacheWritten: number;
  /** Tokens read from the cache, which are charged well below the input rate. */
  readonly cacheRead: number;
};

/** Whether anything at all was counted, so an absence is never reported as zero. */
export const counted = (counts: TokenCounts): boolean =>
  counts.input > 0 || counts.output > 0 || counts.cacheWritten > 0 || counts.cacheRead > 0;

/**
 * The names the server uses, and where they came from.
 *
 * Anthropic's published shape as of 2026-06, not yet measured on this machine: a
 * streaming reply reports input and cache counts on `message_start` and the final
 * output count on `message_delta`, and a whole reply carries one `usage` object.
 * Nothing here depends on which of those it is looking at; it takes every `usage`
 * object it sees and keeps the largest of each field, because the last word on a
 * stream is the complete one and a partial count is never larger than the total.
 *
 * If a name changes, the counts read as absent rather than as zero, which is the
 * one property that matters: a history row with no counts says so.
 */
const FIELDS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheWritten", "cache_creation_input_tokens"],
  ["cacheRead", "cache_read_input_tokens"],
] as const;

const MARKER = '"usage":';

/**
 * How much of the previous chunk is carried forward.
 *
 * Only enough to bridge a `usage` object split across a chunk boundary. One of
 * those is around 120 bytes, so this is generous and still small enough that
 * nothing meaningful can be reconstructed from it. It is a window, not a buffer:
 * it is replaced on every chunk and never grows.
 */
const CARRY_BYTES = 512;

export type Scanner = {
  /** Take a chunk of the reply. Returns nothing; it is a scanner, not a filter. */
  take(chunk: string): void;
  /** What was counted, and whether anything was. Null when nothing was found. */
  counts(): TokenCounts | null;
};

/**
 * Read the `usage` object out of a JSON fragment starting at `from`.
 *
 * Hand-walked rather than parsed, because the fragment is part of a stream and the
 * enclosing object is usually incomplete. It reads only until the matching brace
 * and only understands numbers, so nothing it walks past can become a string it
 * keeps.
 */
function usageAt(text: string, from: number): Partial<Record<(typeof FIELDS)[number][0], number>> | null {
  const open = text.indexOf("{", from);
  if (open === -1) return null;

  let depth = 0;
  let close = -1;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "{") depth += 1;
    else if (text[at] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = at;
        break;
      }
    }
  }
  // Incomplete: the rest of it is in the next chunk, and the carry will bring it
  // back round. Returning a half-read count would be worse than returning none.
  if (close === -1) return null;

  const inside = text.slice(open, close + 1);
  const found: Partial<Record<(typeof FIELDS)[number][0], number>> = {};
  for (const [mine, theirs] of FIELDS) {
    const stated = new RegExp(`"${theirs}"\\s*:\\s*(\\d+)`).exec(inside);
    if (stated?.[1] !== undefined) found[mine] = Number(stated[1]);
  }
  return found;
}

/**
 * Watch a reply go past and keep only what it cost.
 *
 * Nothing is retained between chunks except the four counts and the carry window,
 * so a reply of any length costs a fixed and tiny amount of memory.
 */
export function openScanner(): Scanner {
  const most: Record<(typeof FIELDS)[number][0], number> = { input: 0, output: 0, cacheWritten: 0, cacheRead: 0 };
  let anything = false;
  let carry = "";

  return {
    take(chunk) {
      const text = carry + chunk;

      let from = 0;
      for (;;) {
        const at = text.indexOf(MARKER, from);
        if (at === -1) break;
        const found = usageAt(text, at + MARKER.length);
        if (found !== null) {
          for (const [mine] of FIELDS) {
            const value = found[mine];
            if (value !== undefined) {
              // The largest wins, because a stream reports a partial output count
              // first and the total last, and a total is never the smaller number.
              most[mine] = Math.max(most[mine], value);
              anything = true;
            }
          }
        }
        from = at + MARKER.length;
      }

      // Replaced, never appended to. This is a window over the join between two
      // chunks and it is the only thing here that ever holds reply text at all.
      carry = text.length <= CARRY_BYTES ? text : text.slice(text.length - CARRY_BYTES);
    },

    counts: () => (anything ? { ...most } : null),
  };
}
