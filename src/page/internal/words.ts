/**
 * Figures turned into the words the page shows, and nothing else.
 *
 * A second copy of this idea already exists in `src/control/internal/words.ts`,
 * and that is deliberate rather than an oversight: the terminal says "1h 12m" and
 * the page says "1 h 12 m", the terminal says "38m ago" and the page's detail list
 * says "4 minutes ago". Those spacings were chosen by eye on the design, which is
 * the newer decision and the one that wins. Sharing one formatter would mean one
 * of the two surfaces losing the wording somebody sat and picked.
 *
 * Pure, and the moment and the time zone are arguments, so every screen on the
 * page is a table in a test rather than something that reads differently in
 * Tehran than in a test runner set to UTC.
 */

/** A share of a window (0..1) as a whole-number percentage. */
export function asPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * Hours and minutes, single-letter units, spaced: `1 h 12 m`, `22 m`, `4 h 06 m`.
 *
 * Minutes are padded only when an hour precedes them, because `4 h 6 m` reads as
 * a typing slip in a column of `4 h 06 m`, while a bare `6 m` does not.
 */
export function asHoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} m`;
  return `${hours} h ${String(minutes).padStart(2, "0")} m`;
}

/**
 * Days and hours, for the countdown in the list: `1 d 4 h`, `20 h`.
 *
 * Days are dropped under a day, and hours under an hour, because a reset less
 * than an hour away is news of a different kind: it is `resets shortly`.
 */
export function asDaysHours(seconds: number): string | null {
  const hours = Math.floor(Math.max(0, seconds) / 3600);
  if (hours === 0) return null;
  const days = Math.floor(hours / 24);
  return days === 0 ? `${hours} h` : `${days} d ${hours % 24} h`;
}

/**
 * How long is left, in Claude's own words: `14 hr 39 min`.
 *
 * A duration and never a date, because the question a person has in front of this
 * screen is "how much longer", and answering it with "Fri 12:00" makes them do the
 * subtraction themselves. Past a day the minutes stop mattering and would only make
 * the line harder to read, so it becomes `3 d 16 hr`.
 */
export function asLongHoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} hr`;
  if (hours === 0) return `${minutes} min`;
  return `${hours} hr ${minutes} min`;
}

/** Compact elapsed, for tags and chrome: `47 s ago`, `4 m ago`, `2 h ago`. */
export function asAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Spelled out, for the key-and-value detail list: `4 seconds ago`. */
export function asAgoSpelled(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const [count, unit] =
    s < 60
      ? [s, "second"]
      : s < 3600
        ? [Math.floor(s / 60), "minute"]
        : s < 86400
          ? [Math.floor(s / 3600), "hour"]
          : [Math.floor(s / 86400), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

type Parts = Record<string, string>;

function parts(at: number, timeZone: string, options: Intl.DateTimeFormatOptions): Parts {
  const held: Parts = {};
  for (const part of new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).formatToParts(new Date(at * 1000))) {
    held[part.type] = part.value;
  }
  return held;
}

/** Which calendar day a moment falls on, in the zone being read, as a number. */
function dayNumber(at: number, timeZone: string): number {
  const p = parts(at, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000;
}

/**
 * A moment as a clock reading, said the way a person would say it out loud:
 * `today 09:47`, `yesterday 22:41`, `tomorrow 07:00`, `Fri 09:00`, and an ISO
 * date once it is far enough away that a weekday no longer identifies it.
 */
export function asClock(at: number, now: number, timeZone: string): string {
  const time = parts(at, timeZone, { hour: "2-digit", minute: "2-digit", hour12: false });
  const clock = `${time.hour}:${time.minute}`;

  const offset = dayNumber(at, timeZone) - dayNumber(now, timeZone);
  if (offset === 0) return `today ${clock}`;
  if (offset === -1) return `yesterday ${clock}`;
  if (offset === 1) return `tomorrow ${clock}`;

  if (offset > 1 && offset < 7) return `${parts(at, timeZone, { weekday: "short" }).weekday} ${clock}`;

  const date = parts(at, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${date.year}-${date.month}-${date.day} ${clock}`;
}

/** `23 Aug 15:04`, for the two places that date a whole panel. */
export function asStamp(at: number, timeZone: string): string {
  const p = parts(at, timeZone, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

/** `14:26`, a bare clock reading, for a sentence that already says which day. */
export function asTime(at: number, timeZone: string): string {
  const p = parts(at, timeZone, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${p.hour}:${p.minute}`;
}

/** `14:02:11`, for a log line. */
export function asLogTime(at: number, timeZone: string): string {
  const p = parts(at, timeZone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** A token count: `812k`, `9.8M`, `3.41M` in a stat tile, `0` when there is none. */
export function asTokens(count: number, decimals = 1): string {
  if (count === 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(decimals)}M`;
}

/** Money, always two decimals. Never what the user paid: an API-rate equivalent. */
export function asMoney(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}

/** A plain count, with a thousands separator: `18,402`. */
export function asCount(count: number): string {
  return count.toLocaleString("en-US");
}

/** A Multiplier as it is written on a badge: `20x`, `6.25x`. */
export function asMultiplier(multiplier: number): string {
  return `${multiplier}x`;
}
