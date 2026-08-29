/**
 * The relay's own log, and the bound on it.
 *
 * A service has nowhere else to say what it is doing, so it says everything here.
 * Nothing rotated it before this, which on a machine that has already run out of
 * disk once is a slow leak with a known ending.
 *
 * The log is for a person reading what just happened. It is not the record: lines
 * aging out of it is the whole point, and anything that has to survive belongs in
 * the usage history, which is a different file for that reason.
 */
export type { Journal } from "./internal/bounded.ts";
export { openJournal, AT_MOST_BYTES, keptBeside } from "./internal/bounded.ts";
