/**
 * Which ways of making Claude do work actually land on the Seat we chose.
 *
 * Every other part of this program makes the app do something. This is the only
 * part that can say whether the app is honest about what it does, and a path that
 * silently goes round the relay is the worst failure this design has: the user
 * believes a Seat is paying, the percentages agree with them, and the bill lands
 * somewhere else.
 *
 * Coverage is judged by negative control and never by counting. A request that
 * went round the relay is simply absent, and an absence looks exactly like work
 * that never happened. With a credential that cannot buy anything in the Proving
 * Window's own store, the relay is the only thing that can make work complete, so
 * completing it is the proof.
 */
export type { Path, Row, Record_ } from "./internal/matrix.ts";
export { PATHS, judgePath, asTable, knownLimits } from "./internal/matrix.ts";
