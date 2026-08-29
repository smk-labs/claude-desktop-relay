/**
 * The page, answered over HTTP.
 *
 * It lives on the relay's own port. That port is the one address the app has
 * already been told about, so it is one thing to install, one thing to guard and
 * one thing to explain. Plain HTTP there used to be a 405 saying "this proxy
 * speaks CONNECT"; it is the page now, and CONNECT is untouched.
 *
 * One document, at `/state`. Six endpoints answering at six different moments is
 * six ways for one screen to disagree with itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { RANKING } from "../../chooser/index.ts";

import { draw, liveValues, structure, type Knob } from "./draw.ts";
import { pageState, type PageState, type WhatThePageShows } from "./state.ts";
import { trayMenu } from "./tray.ts";

/** Where the page's own files sit, beside this one. Read once, at startup. */
const HERE = join(import.meta.dirname, "..");
const CSS = readFileSync(join(HERE, "relay.css"), "utf8");
/** The page's icon, the same cord the menu bar draws. Read once, like the stylesheet. */
const ICON = readFileSync(join(HERE, "icon.svg"), "utf8");
const MARK = readFileSync(join(HERE, "mark.svg"), "utf8");
const SCRIPT = readFileSync(join(HERE, "live.js"), "utf8");

/**
 * The constants the ranking is made of, taken from the Chooser as it runs.
 *
 * Every value here is read from `RANKING` rather than typed in. The three that
 * used to be typed in said 1.00, 1.00 and 4.00 under labels naming no constant the
 * Chooser has, because they were copied out of the design and the ranking moved
 * afterwards. A page that shows a number is making a claim about the program, and
 * a claim nothing keeps true is worse than no claim.
 *
 * Shown rather than adjustable. The design wanted sliders here; that is recorded
 * and not built, because a weight the user can move is a weight every past row in
 * the history was scored under a different value of. That is a change to the
 * Chooser and to what the history means, not a change to the page.
 */
export const KNOBS: readonly Knob[] = [
  {
    label: "Urgency exponent",
    description: "How much a sooner week reset outweighs raw capacity",
    value: RANKING.urgencyExponent.toFixed(2),
  },
  {
    label: "Running out",
    description: "How hard a Seat on course to lock out before its five hours are up is pushed down",
    value: RANKING.runningOut.toFixed(2),
  },
  {
    label: "Going to waste",
    description: "How much a Seat with more allowance left than time to spend it is preferred",
    value: RANKING.goingToWaste.toFixed(2),
  },
  {
    label: "How far five hours may move it",
    description: "The most and least the five-hour window may multiply a Seat's worth, either way",
    value: `${RANKING.leastGenerous.toFixed(2)}x to ${RANKING.mostGenerous.toFixed(2)}x`,
  },
];

/** Everything the page needs from the running program. The only I/O it does. */
export type PageSource = {
  /**
   * Everything the page shows, gathered fresh.
   *
   * `every` is the log's toggle, and it is asked for here rather than at a second
   * address so that the log a person is reading and the figures beside it were
   * taken at the same moment.
   */
  read(options: { readonly every: boolean; readonly period: "day" | "week" | "month" }): Promise<WhatThePageShows>;
  /** Pay with this Seat from the next request, and hold it: the Mode becomes Manual. */
  use(seat: string): Promise<void>;
  /** Auto, Manual or Off, in force at once. */
  mode(mode: "auto" | "manual" | "off"): Promise<void>;
  /**
   * Open this Claude Desktop profile, by the name the page and the menu show.
   *
   * Opening only. Nothing on this page closes a Window, and nothing on it changes
   * whether a profile is relayed.
   */
  open(profile: string): Promise<void>;
};

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    // Nothing here is cacheable: every figure on it is about right now.
    "cache-control": "no-store",
  });
  response.end(body);
}

/** At most this much of a POST is read, so a stray upload cannot fill memory. */
const AT_MOST_A_REQUEST = 4096;

async function bodyOf(request: IncomingMessage): Promise<string> {
  let held = "";
  for await (const chunk of request) {
    held += String(chunk);
    if (held.length > AT_MOST_A_REQUEST) throw new Error("that request is too big to be one of ours");
  }
  return held;
}

/**
 * The handler the relay hands its plain HTTP requests to.
 *
 * The relay never learns what a Seat is: it is given a function and calls it.
 */
/**
 * What every JSON answer here is labelled, charset and all.
 *
 * `application/json` is defined as UTF-8 by its own specification, so saying the
 * charset looks redundant and is not. A client that is not told falls back to
 * whatever it guesses, and Windows PowerShell's `Invoke-RestMethod` guesses
 * ISO-8859-1: the tray then drew every middle dot and every en dash in the menu
 * as two characters of rubbish. Measured 2026-08-25. Every other route this
 * server answers already said its charset; JSON was the one that did not.
 */
const JSON_UTF8 = "application/json; charset=utf-8";

export function pageHandler(source: PageSource): (request: IncomingMessage, response: ServerResponse) => void {
  const gather = async (asked: { every: boolean; period: "day" | "week" | "month" }): Promise<PageState> => pageState(await source.read(asked));

  return (request, response) => {
    const asked = new URL(request.url ?? "/", "http://relay.invalid");
    const path = asked.pathname;
    const every = asked.searchParams.get("every") === "1";
    const wanted = asked.searchParams.get("period");
    const period = wanted === "day" || wanted === "month" ? wanted : "week";

    void (async () => {
      try {
        if (request.method === "GET" && (path === "/" || path === "/index.html")) {
          const state = await gather({ every, period });
          return send(response, 200, "text/html; charset=utf-8", draw({ state, mark: MARK, knobs: KNOBS, script: SCRIPT }));
        }

        if (request.method === "GET" && path === "/relay.css") {
          return send(response, 200, "text/css; charset=utf-8", CSS);
        }

        // Asked for by every browser whether the page names it or not, so answering
        // it is also how the log stops filling with 404s for a file we do have.
        if (request.method === "GET" && (path === "/icon.svg" || path === "/favicon.ico")) {
          return send(response, 200, "image/svg+xml; charset=utf-8", ICON);
        }

        if (request.method === "GET" && path === "/state") {
          const state = await gather({ every, period });
          return send(
            response,
            200,
            JSON_UTF8,
            JSON.stringify({ structure: structure(state), live: liveValues(state), log: state.log, state }),
          );
        }

        /**
         * The tray's own document, and the only second endpoint here.
         *
         * The page reads one document because a screen must not disagree with
         * itself. The tray is a different client with a smaller question, and
         * handing a menu the whole page every few seconds would be the shell
         * doing the page's work.
         */
        if (request.method === "GET" && path === "/tray") {
          const state = await gather({ every: false, period: "week" });
          return send(response, 200, JSON_UTF8, JSON.stringify(trayMenu(state)));
        }

        if (request.method === "POST" && path === "/act") {
          const asked = JSON.parse(await bodyOf(request)) as { use?: string; mode?: string; open?: string };
          if (typeof asked.use === "string") await source.use(asked.use);
          else if (asked.mode === "auto" || asked.mode === "manual" || asked.mode === "off") await source.mode(asked.mode);
          else if (typeof asked.open === "string") await source.open(asked.open);
          else return send(response, 400, JSON_UTF8, JSON.stringify({ saying: "that is not a Seat, a Mode or a profile" }));
          return send(response, 200, JSON_UTF8, JSON.stringify({ done: true }));
        }

        send(response, 404, "text/plain; charset=utf-8", "relay: there is no page at that address\n");
      } catch (error) {
        /**
         * The sentence, never only the code. A page that goes blank with a 500 is
         * a page whose user has nothing to type into a search box.
         */
        send(response, 500, "text/plain; charset=utf-8", `relay: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    })();
  };
}
