/**
 * The words the tray uses, on all three machines, in one place.
 *
 * There are three shells: a Swift status item on macOS, a PowerShell notification
 * icon on Windows, and a `yad` panel icon on Linux. None of them can import this
 * file, and that is exactly why it exists: the menu drifted into three menus, with
 * "Switch to" on one, "PAY WITH" on another and no Mode at all on the third, and
 * the only way anybody noticed was by opening two machines side by side.
 *
 * So the sections, their order and their labels are written down once here, and a
 * test reads the three shells and fails when one of them says something else. The
 * file is data, not behaviour: nothing here runs at run time on macOS or Windows.
 */

/** The headings, under the names the code refers to them by. */
export const TRAY_WORDS = {
  paying: "Paying now",
  mode: "Mode",
  /** Picking a Seat is a deliberate choice, so it sets Manual. Said, never implied. */
  switch: "Switch to",
  switchHint: "sets Manual",
  desktop: "Claude Desktop",
  desktopHint: "click to open",
  relaying: "Relaying",
  /** The date of the last reading, which is the one fact no tray showed before. */
  refreshed: "Refreshed",
  open: "Open Relay…",
  quit: "Quit Relay tray",
  /** When the relay is not answering, and the tray has nothing true to draw. */
  silent: "Relay is not answering",
} as const;

/** The three Modes, in the order they are drawn, as the relay names them. */
export const TRAY_MODES = [
  { name: "auto", label: "Auto" },
  { name: "manual", label: "Manual" },
  { name: "off", label: "Off" },
] as const;

/** How many Seats a tray offers. Six, because a menu is not a table. */
export const AT_MOST_SEATS = 6;

/**
 * When the figures were last read, in one sentence, worded once.
 *
 * Both halves, because they answer different questions: the clock reading says
 * *when*, and the elapsed says whether it is stale. "3 h ago" alone leaves the
 * reader doing arithmetic; "today 09:47" alone leaves them doing it the other way.
 *
 * `stamp` and `ago` are the page's own words for the same reading, so the tray and
 * the page can never date the same figures differently.
 */
export function sayRefreshed(stamp: string, ago: string): string {
  // "Refreshed never" is a sentence nobody writes, so the state where nothing has
  // been read yet is said as what it is.
  if (stamp === "never") return "Nothing has been read yet";
  return `${TRAY_WORDS.refreshed} ${stamp} · ${ago}`;
}
