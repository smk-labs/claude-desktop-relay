/**
 * What every Seat has spent, kept for as long as it is worth keeping.
 *
 * Utilization is a percentage the server states at a moment and then forgets.
 * Without a history the user can see that a Seat is at 40% and never whether it got
 * there in an hour or over four days, and never which of their Seats actually
 * carries the work.
 *
 * Three rules hold this module together:
 *
 * - No message content in a row, ever. Every field is a count, a name from a menu,
 *   an identifier the program generated, or a moment, and a test asserts it over a
 *   written file. A record of spending must not become a record of the work.
 * - No money in a row. Cost is computed when a row is read, from a dated price
 *   table kept as data, so correcting a rate corrects every past total rather than
 *   leaving the old ones wrong for ever.
 * - A cost is what the work would have cost at API rates, and never what the user
 *   paid. A subscription is not per-token, and every place a cost is shown says so.
 *
 * A Refusal is a row like any other, so "that Seat kept turning us away" is a
 * question with an answer.
 */
export type { Row, Total } from "./internal/rows.ts";
export { totalsBy, rolledUp, dayOf } from "./internal/rows.ts";
export type { History, Period } from "./internal/store.ts";
export { openHistory, KEEP_ROWS_FOR_DAYS, PERIODS } from "./internal/store.ts";
export type { Projects } from "./internal/projects.ts";
export { openProjects, pathFromDirectory, shortNameFor, WHERE_THE_TRANSCRIPTS_ARE } from "./internal/projects.ts";
export type { PriceTable, Rate } from "./internal/prices.ts";
export { PUBLISHED, costOf, rateFor } from "./internal/prices.ts";
