/**
 * Which Seat should pay, as a pure function of what is known.
 *
 * Given the Seats, what is known about their usage, the Mode, the Seat the user
 * picked and the model, it returns one Seat and the reason it won. No I/O, no
 * clock of its own: the moment is an argument. That is the whole point, because
 * this is the one place the ranking rule lives and a rule that can only be
 * examined by watching a real machine is a rule nobody examines.
 *
 * The rule, from the spec: a Seat's worth is its Multiplier times what is left of
 * its week, divided by the hours until that week resets, so allowance about to be
 * lost outranks allowance there is plenty of time to spend. Then the five-hour
 * window adjusts it, rewarding a Seat with more allowance left than time to spend
 * it and penalising one on course to lock out. Free Seats never win, and a Seat on
 * cooldown for the model being asked for is not a candidate.
 *
 * The Window account is always a legitimate answer. The rule is that the relay
 * falls back to it and says why, never that it fails.
 */
export type { Because, Pick } from "./internal/choose.ts";
export { choose, describePick } from "./internal/choose.ts";
export type { Considered, RuledOut } from "./internal/rank.ts";
export { consider, bestFirst, RANKING } from "./internal/rank.ts";
