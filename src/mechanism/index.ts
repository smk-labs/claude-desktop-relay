/**
 * Whether the mechanism still works, and which part of it changed when it does
 * not.
 *
 * Everything here rests on behaviour of an app we do not control. When an update
 * moves the store, changes how it is locked, or starts stripping our variables,
 * the symptom is a Code session that cannot reach anything, and that is a mystery
 * unless somebody says which of those it was. This says it.
 *
 * It also refuses to be reassuring: if any part is broken, `working` is false, and
 * nothing in this program may claim a Seat is paying while that is so.
 */
export type { Finding, Inspection, WhatToCheck } from "./internal/check.ts";
export { inspect } from "./internal/check.ts";
