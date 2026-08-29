/**
 * Numbers turned into the words a person reads, and nothing else.
 *
 * Pure, so every line the control surface prints can be asserted as a table. It
 * is here rather than beside each caller because "in 38m" and "38 minutes from
 * now" appearing in one screen is how a surface starts to look assembled.
 */

/** A share of a window as a whole-number percentage. */
export function asPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * A span of seconds, coarsely, in at most two parts.
 *
 * Coarse on purpose: nobody reads "3h 41m 12s", and the extra digits imply a
 * precision these figures do not have. A window resets when the server says it
 * does, and our clock is not its clock.
 */
export function asSpan(seconds: number): string {
  if (seconds < 60) return "under a minute";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** How long ago something was read, for a figure that must never pass as current. */
export function asAge(seconds: number): string {
  return seconds < 60 ? "just now" : `${asSpan(seconds)} ago`;
}
