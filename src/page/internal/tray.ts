/**
 * The tray menu, as a document.
 *
 * Four things and no more: the Seat paying now, the Mode, the Seats worth
 * switching to as one click each, and the way to the page. A system menu is not a
 * place for a table, so anything that would need a column goes on the page.
 *
 * Two lines were added to that since. The first, on 2026-08-24, because ADR 0014
 * made it ambiguous without one: there are two Claude Desktop profiles now and only
 * one is relayed, so a menu that never names which one leaves the reader guessing
 * which Window its numbers describe. The second, on 2026-08-26, is when the figures
 * were last read: every number here is a reading from an earlier moment, and a menu
 * that never dates itself looks equally current an hour later. Lines, not new
 * things.
 *
 * The sections and the words they use are in `src/tray/internal/menu.ts`, because
 * three shells draw this menu and none of them can import anything.
 *
 * Derived from the page's own document rather than gathered again, so the menu
 * and the page can never disagree about who is paying. Pure, like everything else
 * here: the shell is a shell.
 */
import { AT_MOST_SEATS, sayRefreshed } from "../../tray/index.ts";

import type { PageState } from "./state.ts";

export { AT_MOST_SEATS };

/** The four icon states, carried by shape as well as colour. */
export type Icon = "off" | "on" | "strained" | "broken";

export type TrayLine = {
  readonly name: string;
  readonly plan: string;
  /**
   * What is left of the week, as a bare percentage.
   *
   * Kept only so a tray built before `room` existed still draws something rather
   * than failing to decode the whole menu. Nothing new should read it: it never
   * said whether the figure was spent or left, which is the reason `room` exists.
   */
  readonly left: string;
  /**
   * Both windows, spent, and when each comes back: `s 8% · in 2h   w 12% · in 5d 3h`.
   *
   * The one line a person opens this menu for. Worded in `control/internal/room.ts`
   * and nowhere else, so the menu bar, the panel on Linux and the command line
   * cannot describe the same Seat three different ways.
   */
  readonly room: string;
};

export type TrayProfile = {
  readonly name: string;
  /** Relayed or not, open or not: the same words the page uses. */
  readonly saying: string;
  readonly relayed: boolean;
  readonly running: boolean;
};

export type TrayMenu = {
  readonly icon: Icon;
  readonly saying: string;
  /** The line under "Paying now", already assembled. */
  readonly paying: TrayLine | null;
  /**
   * The line under "Paying now", in words, whatever the state.
   *
   * The shell used to write "The Window account" whenever `paying` was null, which
   * is wrong in the one state that matters: Auto, on, with nothing chosen yet. The
   * text is decided here so the menu and the page cannot disagree.
   */
  readonly payingSaying: string;
  /**
   * What the Seat that is paying has spent, in whole words, for the tooltip.
   *
   * The tooltip is the only summary anybody gets without clicking, and "Relay is
   * on" is not a summary. Null when nothing is paying, because there is nothing
   * to spell out.
   */
  readonly payingRoom: string | null;
  /** Which Claude Desktop profile these figures are about. ADR 0014. */
  readonly relaying: string | null;
  readonly mode: "auto" | "manual" | "off";
  /**
   * The Claude Desktop profiles, one line each, so the menu can open any of them.
   *
   * The menu bar is where the relay is already managed, and the profile a person
   * wants to open is part of the same daily question: which Claude Desktop am I in,
   * and how do I get to the other one. Opening only. Whether a profile is relayed
   * is shown here and changed nowhere in this menu.
   */
  readonly profiles: readonly TrayProfile[];
  readonly seats: readonly TrayLine[];
  /**
   * When the figures were last read: `Refreshed today 09:47 · read 3 m ago`.
   *
   * The tray is often the only surface open, and every number in it is a reading
   * taken at some earlier moment. Without this the menu looks equally current
   * whether the last reading was a minute or a day old, which is how a Seat gets
   * switched to on figures nobody had checked.
   */
  readonly refreshed: string;
  readonly open: string;
};

/**
 * The machine row the menu borrows its "which profile" line from.
 *
 * Named once here and used by whoever builds the rows, so the menu cannot go
 * looking for a key that has been renamed and quietly show nothing.
 */
export const RELAYING_ROW = "Relaying";

/**
 * Past this share of its week used, the Seat paying is running out and the icon
 * says so before the page has to be opened. The same threshold the meters use.
 */
const STRAINED = 75;

function left(percent: number | null): string {
  return percent === null ? "–" : `${100 - percent}%`;
}

export function trayMenu(state: PageState): TrayMenu {
  const paying = state.paying.kind === "seat" ? state.groups.flatMap((one) => one.seats).find((one) => one.paying) ?? null : null;

  /**
   * On, and waiting for the first request, which is not Off.
   *
   * Reading the icon off "is a Seat chosen" made the menu bar say Relay is off
   * while the mode was Auto and Seats had room. The mode says whether the
   * relay is on; the Seat says who is paying; they are different questions.
   */
  const waiting = state.paying.kind === "window" && state.paying.waitingToChoose;

  const icon: Icon = state.banners.some((one) => one.tone === "critical")
    ? "broken"
    : paying !== null
      ? (paying.week.percent ?? 0) >= STRAINED || paying.verdict?.tone === "broken"
        ? "strained"
        : "on"
      : waiting
        ? "on"
        : "off";

  return {
    icon,
    payingSaying:
      paying !== null
        ? `${paying.name} · ${paying.plan}`
        : state.paying.kind === "window"
          ? state.paying.heading
          : "The Window account",
    relaying: state.machine.find((one) => one.key === RELAYING_ROW)?.value ?? null,
    saying:
      icon === "broken"
        ? "Relay is broken"
        : icon === "off"
          ? "Relay is off"
          : icon === "strained"
            ? "Relay is on, and the Seat is running out"
            : waiting
              ? "Relay is on, and has not chosen a Seat yet"
              : "Relay is on",
    paying:
      paying === null ? null : { name: paying.name, plan: paying.plan, left: left(paying.week.percent), room: paying.room },
    payingRoom: state.paying.kind === "seat" ? state.paying.room : null,
    refreshed: sayRefreshed(state.readStamp, state.read),
    mode: state.mode,
    profiles: state.profiles.map((one) => ({
      // Both halves, because the menu has one line per profile and the relayed
      // half is the reason a person opened the menu at all.
      name: one.name,
      saying: `${one.account} · ${one.badge} · ${one.saying}`,
      relayed: one.relayed,
      running: one.running,
    })),
    seats: state.picks
      .slice(0, AT_MOST_SEATS)
      .map((one) => ({ name: one.name, plan: one.plan, left: left(one.percent), room: one.room })),
    /** Where "Open Relay…" goes. The relay's own port, which is where it already is. */
    open: `http://127.0.0.1:${state.port}/`,
  };
}
