/**
 * The Worklist: every Seat the user owns, named, and each one filled or missing.
 *
 * The user is never asked to invent a name or to type out what they own. A Seat's
 * name is derived from its account and its Organization, so the same pair always
 * gives the same name and a sitting can be abandoned halfway and picked up later
 * without anything having to be remembered in between.
 */
export type { Dropped, Worklist, WorklistEntry } from "./internal/build.ts";
export { buildWorklist, seatsFrom } from "./internal/build.ts";
export { seatNameFor } from "./internal/name.ts";
export type { Change } from "./internal/refresh.ts";
export { changesBetween, bringUpToDate, describeChange } from "./internal/refresh.ts";
