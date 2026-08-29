/**
 * The sitting: filling a Seat's Send token, with the copying and the pasting taken
 * out.
 *
 * One flow, and that is the point of the module rather than a detail of it. A
 * single Seat added by hand, a sitting that fills every one, and whatever an
 * interface offers
 * are all this function called with a longer or a shorter list. Two flows for the
 * same job is how the two stop agreeing about which account is next and which
 * Organization has to be active.
 *
 * What it does per Seat, in this order, because the order is what makes it safe:
 *
 *   1. Say which account, which Organization and which browser profile are coming,
 *      so the profile can be got ready while the Seat before it finishes.
 *   2. Read the date on the `claude` command's own login, wherever this machine
 *      keeps it.
 *   3. Run `claude setup-token` under an isolated `CLAUDE_CONFIG_DIR` and open the
 *      link in the right browser profile, or hand it over when there is no right
 *      one to be sure of.
 *   4. Read that date again, and stop the whole sitting if it moved. That is the
 *      user's own login, and an isolated `CLAUDE_CONFIG_DIR` does not move it on
 *      macOS, where it is a Keychain entry. It does move it on Windows, where it
 *      is a file, so the danger there is smaller and the question is the same. A
 *      mint run without the variable set writes exactly there on either machine,
 *      and one mint per Seat would replace that login once per Seat.
 *   5. Prove the token against the server before keeping it, because a token for
 *      the right account and the wrong Organization looks perfect from here.
 *   6. Back up, immediately. A sitting that fills Seats and does not back them up
 *      is the hole that cost every Send token on this machine on 2026-08-22.
 *   7. Advance only when the user says so, so a sitting can be paced.
 *
 * Nothing here reads a keyboard or opens a browser itself. Everything a person is
 * needed for is a named call on `Asking`, and everything the machine does is a seam
 * with one real implementation, so a test drives the whole flow without a network,
 * a Keychain, a Claude Desktop or a real authorization.
 */
export type { Announcement } from "./internal/announce.ts";
export { announcementInWords, whatIsAboutToHappen } from "./internal/announce.ts";
export type { Asking, SeatOutcome, WhatASittingNeeds } from "./internal/fill.ts";
export { fillOneSeat, likelyProfileFor } from "./internal/fill.ts";
export type { SittingReport } from "./internal/walk.ts";
export { howItWent, mayCarryOnLater, walkTheWorklist } from "./internal/walk.ts";
