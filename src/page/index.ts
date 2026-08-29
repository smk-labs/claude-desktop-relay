/**
 * The page the relay serves, at the relay's own port.
 *
 * At its heart two things: the document that says what is going on, and the markup
 * that draws it. Both are pure, so the whole of what the page shows is a table in
 * a test, and the relay is handed a function rather than being taught what a Seat
 * is.
 *
 * Four more things sit around them, and it is worth being plain that they are not
 * pure. `pageHandler` answers over HTTP and reads its stylesheet, icons and script
 * off disk once at load. The log pane is a bounded buffer written to as the relay
 * runs. The tray menu is derived from the same document so the menu and the page
 * cannot word one fact two ways. And the words are shared so the other surfaces
 * date the same figures the same way.
 */
export type {
  Analytics,
  Banner,
  Bar,
  Cord,
  Empty,
  Figure,
  Group,
  Level,
  LogLine,
  LogShown,
  Meter,
  PageState,
  Pair,
  Paying,
  ProfileShown,
  PickShown,
  SeatShown,
  SpendRow,
  Stat,
  Tag,
  WhatThePageShows,
} from "./internal/state.ts";
export { pageState, toneOf, A_WEEKS_WORTH_OF_TOKENS } from "./internal/state.ts";
export type { Knob, Live } from "./internal/draw.ts";
export { draw, liveValues, structure, escape, cord } from "./internal/draw.ts";
export type { PageSource } from "./internal/serve.ts";
export { pageHandler, KNOBS } from "./internal/serve.ts";
export type { LogPane } from "./internal/log-pane.ts";
export { openLogPane, KEEP_LINES } from "./internal/log-pane.ts";
export type { Icon, TrayLine, TrayMenu, TrayProfile } from "./internal/tray.ts";
export { trayMenu, AT_MOST_SEATS, RELAYING_ROW } from "./internal/tray.ts";
// The words the page turns moments into, for the other surfaces that date the same
// figures: the Linux tray says "read 3 m ago" because the page does, not because it
// worded it again.
export { asAgo, asClock, asMultiplier } from "./internal/words.ts";
