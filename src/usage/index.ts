/**
 * What is known about every Seat's allowance, and how fresh that knowledge is.
 *
 * Kept current from real traffic at no extra cost: a Send token cannot read usage
 * from any endpoint, so the only figures that exist arrive attached to a reply the
 * Seat already paid for. A Seat that is sitting idle has no reply to read, which is
 * why a reading taken through a Stats login can be folded in as well, and why every
 * figure here carries where it came from and how old it is.
 *
 * Two rules in here are the reason this is a module and not a variable:
 *
 * - An exchange only teaches about a Seat when the relay actually swapped and the
 *   server did not name somebody else as the payer. Otherwise the figures are
 *   another account's spending written against ours.
 * - A Refusal is evidence about one request, never proof that a Seat is out of
 *   allowance (ADR 0005). A Refusal on a request that did not carry the Claude Code
 *   system prompt is a Refusal we caused, and it leaves the Seat untouched.
 *
 * Nothing here has a clock. The moment is an argument everywhere, so every rule in
 * it can be tested as a table.
 */
export type { AllowanceKnown, SeatUsage, ReadVia, Remembered, SeatMemory } from "./internal/known.ts";
export { COOLDOWN_SECONDS, onCooldown, refusalIsAboutTheSeat, seatTaughtBy } from "./internal/known.ts";
export type { UsageMemory } from "./internal/memory.ts";
export { openUsageMemory } from "./internal/memory.ts";
export type { Refreshed } from "./internal/refresh.ts";
export { refreshStaleSeats, whichAreStale, STALE_AFTER_SECONDS } from "./internal/refresh.ts";
