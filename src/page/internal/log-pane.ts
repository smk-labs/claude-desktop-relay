/**
 * The log the page shows: what happened while the page was open.
 *
 * In memory and bounded, and it starts clean on a refresh. That is deliberate and
 * not a shortcut: `src/journal` is the relay's own log, on disk, bounded at 8 MB,
 * and it is the record. This is the pane beside the numbers, and a pane that
 * reached back over days would be a second, worse history.
 *
 * Two levels, because they are two different jobs. Meaningful events are the
 * default: a switch, a Refusal, an error, an exchange that could not be verified.
 * Every exchange is behind the toggle, because reading those is debugging and
 * debugging is not the daily path.
 */
import type { LogLine } from "./state.ts";

/** How many lines are kept at each level. The oldest goes when it is full. */
export const KEEP_LINES = 200;

export type LogPane = {
  /** A meaningful event: shown by default. */
  say(at: number, event: string, text: string): void;
  /** One exchange: kept, and only shown behind the toggle. */
  exchange(at: number, event: string, text: string): void;
  lines(options?: { readonly every?: boolean }): readonly LogLine[];
};

export function openLogPane(options: { readonly cap?: number } = {}): LogPane {
  const cap = options.cap ?? KEEP_LINES;
  const meaningful: LogLine[] = [];
  const everything: LogLine[] = [];

  const push = (into: LogLine[], line: LogLine) => {
    into.push(line);
    // The oldest goes, so a page left open for a week cannot grow without bound.
    if (into.length > cap) into.splice(0, into.length - cap);
  };

  return {
    say(at, event, text) {
      const line = { at, event, text };
      push(meaningful, line);
      push(everything, line);
    },
    exchange(at, event, text) {
      push(everything, { at, event, text });
    },
    lines({ every = false } = {}) {
      // Newest at the bottom, like a chat, which is where the eye already is.
      return every ? [...everything] : [...meaningful];
    },
  };
}
