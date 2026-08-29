/**
 * The document, drawn.
 *
 * Lifted from a design rather than re-invented: the same elements, the same class
 * names, the same words. The design was an HTML mockup and a stylesheet, and it
 * left the repository before the first public release, because a drawing is not a
 * program and a program is what is shipped. What is left of it is here: `relay.css`
 * beside this file is that stylesheet, copied byte for byte and served as it is,
 * and `docs/design.md` holds the reasoning.
 *
 * This is the one place that says so. Everywhere else under `src/page` that
 * credits "the design" means this, and it explains why the page looks the way it
 * does rather than the way a program written from the facts alone would.
 *
 * Pure: a document in, a string out. Nothing here reads a clock, a file or a
 * network, so what the page says is asserted in a test rather than looked at.
 */
import type { Bar, Group, Meter, PageState, Pair, SeatShown, Tag } from "./state.ts";

/** One constant the ranking is made of, disclosed rather than hidden. */
export type Knob = { readonly label: string; readonly description: string; readonly value: string };

const MARK = "#rmark";

/**
 * The four cord shapes, verbatim from the design.
 *
 * Shape as well as colour: take the colour away and no cord, a cord, a cord with
 * one end run down and a snapped cord still read differently. That is why these
 * are four drawings rather than one drawing and four fills.
 */
export function cord(state: "on" | "off" | "broken" | "strained", size: number): string {
  const open = `<svg class="cord is-${state}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">`;
  const mark = (y: number) => `<use class="mark" href="${MARK}" transform="translate(0.6 ${y}) scale(0.028125)"/>`;
  if (state === "off") return `${open}<rect class="plug" x="11.4" y="5.5" width="3.9" height="5" rx="1.5"/>${mark(4.397)}</svg>`;
  if (state === "strained")
    return `${open}<path class="line" d="M4.2 8h6.9"/><rect class="plug" x="10.8" y="6.9" width="4.2" height="2.2" rx="1.1"/>${mark(4.397)}</svg>`;
  if (state === "broken")
    return `${open}<path class="line" d="M4.2 5.6h5.4"/><path class="line" d="M11.2 10.6h1"/><rect class="plug" x="11.5" y="8.1" width="3.7" height="5" rx="1.5"/>${mark(1.997)}</svg>`;
  return `${open}<path class="line" d="M4.2 8h6.9"/><rect class="plug" x="10.8" y="5.5" width="4.2" height="5" rx="1.6"/>${mark(4.397)}</svg>`;
}

/** Everything that reaches the page from a name, an account or a log line. */
export function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const width = (percent: number | null) => `width:${percent ?? 0}%`;
const levelled = (base: string, one: Bar | Meter) => (one.level === "plain" ? base : `${base} ${one.level}`);

function tag(one: Tag | null): string {
  return one === null ? "" : `<span class="tag ${one.tone}">${escape(one.text)}</span>`;
}

function meter(one: Meter, live: string): string {
  const figure =
    one.percent === null
      ? `<div class="mt"></div><div class="mv" data-live="${live}-pct">unknown</div>`
      : `<div class="mt" data-live="${live}-bar"><i style="${width(one.percent)}"></i></div>` +
        `<div class="mv" data-live="${live}-pct"><b>${one.percent}%</b> used</div>`;
  return (
    `<div class="${levelled("meter", one)}" data-live="${live}">` +
    `<div class="ml"><b>${escape(one.label)}</b><span data-live="${live}-when">${escape(one.when)}</span></div>${figure}</div>`
  );
}

function cell(one: Bar, live: string): string {
  return one.percent === null
    ? `<div class="cell"><div class="bar unknown"></div></div><div class="seat-pct" data-live="${live}-pct">\u2013</div>`
    : `<div class="cell"><div class="${levelled("bar", one)}" data-live="${live}-bar"><i style="${width(one.percent)}"></i></div></div>` +
      `<div class="seat-pct" data-live="${live}-pct">${one.percent}%</div>`;
}

function pairs(list: readonly Pair[], style = ""): string {
  const rows = list.map((one) => `<div><span class="k">${escape(one.key)}</span><span class="v">${escape(one.value)}</span></div>`).join("");
  return `<div class="dl"${style === "" ? "" : ` style="${style}"`}>${rows}</div>`;
}

function seatRow(seat: SeatShown): string {
  const key = escape(seat.name);
  const icon = seat.cord === "quiet" ? `<span class="mark-slot"></span>` : cord(seat.cord, 16);
  const meters = seat.meters.map((one, index) => meter(one, `seat:${seat.name}:meter${index}`)).join("");
  const verdict =
    seat.verdict === null && seat.note === null
      ? ""
      : `<p class="verdict">${tag(seat.verdict)}${seat.note === null ? "" : `<p class="note">${escape(seat.note)}</p>`}</p>`;

  return (
    `<div class="seat${seat.paying ? " is-payer" : ""}" data-seat="${key}">` +
    `<div class="seat-line">${icon}` +
    `<div class="seat-name">${key} <span data-live="seat:${key}:tag">${tag(seat.tag)}</span></div>` +
    `<span class="badge">${escape(seat.plan)}</span>` +
    cell(seat.five, `seat:${key}:five`) +
    cell(seat.week, `seat:${key}:week`) +
    `<div class="seat-reset" data-live="seat:${key}:resets">${escape(seat.resets)}</div>` +
    `</div>` +
    `<div class="seat-detail"><div class="cols"><div class="meters">${meters}</div>${pairs(seat.detail)}</div>${verdict}</div>` +
    `</div>`
  );
}

const LIST_HEAD =
  `<div class="list-head"><span></span><span>Seat</span><span></span>` +
  `<span class="c2">session</span><span class="c2">weekly</span><span class="r">resets</span></div>`;

function group(one: Group): string {
  return (
    `<div class="group-head"><span>${escape(one.label)}</span><span class="count">${one.count}</span></div>` +
    LIST_HEAD +
    one.seats.map(seatRow).join("")
  );
}

const SORTS = [
  "Best value first",
  "Weekly used: low to high",
  "Weekly used: high to low",
  "Five hours used: low to high",
  "Weekly reset: soonest",
];

const MODES = [
  { name: "auto", label: "Auto", saying: "Always pay from the best Seat" },
  { name: "manual", label: "Manual", saying: "Hold the Seat I picked" },
  { name: "off", label: "Off", saying: "Everything lands on the Window account" },
] as const;

function banners(state: PageState): string {
  return state.banners
    .map((one) => {
      if (one.tone === "critical") {
        return (
          `<div class="banner">${cord("broken", 20)}<div class="body">` +
          `<h3>${escape(one.heading)}</h3><p>${escape(one.body)}</p>` +
          (one.command === null ? "" : `<pre><code>${escape(one.command)}</code></pre>`) +
          `</div></div>`
        );
      }
      return (
        `<div class="panel" style="padding:12px 16px;margin-bottom:12px;background:var(--bg-strain);border-color:var(--strain)">` +
        `<b style="font-size:13px">${escape(one.heading)}</b>` +
        `<span class="tiny muted"> \u2014 ${escape(one.body)}</span>` +
        (one.foot === null ? "" : `<p class="dim" style="margin-top:8px">${escape(one.foot)}</p>`) +
        `</div>`
      );
    })
    .join("");
}

function payingSection(state: PageState): string {
  const head =
    `<div class="sec-head"><h2>Paying now</h2><div class="rule"></div>` +
    `</div>`;

  if (state.paying.kind === "window") {
    const figures = state.paying.figures
      .map(
        (one) =>
          `<div class="figure"><div class="lab">${escape(one.label)}</div>` +
          `<div class="val n">${escape(one.value)}</div><div class="foot">${escape(one.foot)}</div></div>`,
      )
      .join("");
    return (
      `<section>${head}<div class="payer" style="border-left-color:var(--idle)">${cord("off", 28)}<div>` +
      `<h3 class="name">${escape(state.paying.heading)}</h3>` +
      `<p class="org">${escape(state.paying.sub)}</p>` +
      (figures === "" ? "" : `<div class="room">${figures}</div>`) +
      `</div></div>` +
      (state.paying.foot === null ? "" : `<p class="dim" style="margin-top:10px">${escape(state.paying.foot)}</p>`) +
      `</section>`
    );
  }

  const meters = state.paying.meters.map((one, index) => meter(one, `payer:meter${index}`)).join("");
  return (
    `<section>${head}<div class="payer">${cord("on", 26)}<div>` +
    `<h3 class="name" data-live="payer:name">${escape(state.paying.name)} <span class="badge big">${escape(state.paying.plan)}</span></h3>` +
    `<p class="org" data-live="payer:sub">${escape(state.paying.sub)}</p>` +
    `<div class="meters">${meters}</div></div></div></section>`
  );
}

function picksSection(state: PageState): string {
  if (state.picks.length === 0) return "";
  const cards = state.picks
    .map(
      (one) =>
        `<div class="pick"><div class="pt"><span class="t">${escape(one.name)}</span> <span class="badge">${escape(one.plan)}</span>` +
        `<button class="btn${one.primary ? " primary" : ""}" data-use="${escape(one.name)}">Use</button></div>` +
        `<div class="pb"><div class="bar"><i style="${width(one.percent)}"></i></div><span class="pv n">${one.percent === null ? "–" : `${one.percent}%`}</span></div>` +
        // No chip at all when there is nothing to report, so a quiet card stays quiet.
        `${one.chip === null ? "" : `<span class="chip ${one.chipTone === "urgent" ? "urgent" : "warn"}">${escape(one.chip)}</span>`}</div>`,
    )
    .join("");
  return (
    `<section><div class="sec-head"><h2>Worth switching to</h2><div class="rule"></div>` +
    `</div><div class="picks">${cards}</div></section>`
  );
}

/**
 * The profiles: which Claude Desktop this relay is behind, and one click to open
 * any of them.
 *
 * Visibility first, because the question it answers used to have no answer on this
 * screen at all: there are several Claude Desktops on this machine and only one of
 * them is relayed, so figures without a profile beside them are figures about
 * something the reader has to guess. Opening is the second half, and it is the
 * whole of what this section does: nothing here closes a Window, and nothing here
 * turns the relay on or off for a profile.
 *
 * Built from the same classes the Seat cards use, so it costs no stylesheet.
 */
function profilesSection(state: PageState): string {
  if (state.profiles.length === 0) return "";
  const cards = state.profiles
    .map(
      (one) =>
        // The name and the button, then the words. A chip beside the name as well
        // pushed the name into an ellipsis and said the same thing twice.
        `<div class="pick"><div class="pt"><span class="t">${escape(one.name)}</span>` +
        `<button class="btn${one.relayed ? " primary" : ""}" data-open="${escape(one.name)}">Open</button></div>` +
        `<div class="dim">${escape(one.account)}</div>` +
        `<div class="dim">${escape(one.badge)} · ${escape(one.saying)}</div>` +
        `<span class="dim">${escape(one.where)}</span></div>`,
    )
    .join("");
  return (
    `<section><div class="sec-head"><h2>Claude Desktop profiles</h2><div class="rule"></div>` +
    `</div><div class="picks">${cards}</div></section>`
  );
}

function seatsSection(state: PageState, knobs: readonly Knob[]): string {
  const sort = `<label class="sort">Sort<select data-sort>${SORTS.map((one) => `<option>${one}</option>`).join("")}</select></label>`;
  const knobRows = knobs
    .map(
      (one) =>
        `<div class="knob" style="grid-template-columns:1fr auto"><div><b>${escape(one.label)}</b><div class="d">${escape(one.description)}</div></div>` +
        `<div class="cur">${escape(one.value)}</div></div>`,
    )
    .join("");
  return (
    `<section><div class="sec-head"><h2>Every Seat</h2><div class="rule"></div>${sort}</div>` +
    `<div class="seats">${state.groups.map(group).join("")}</div>` +
    `<details style="margin-top:12px"><summary>How value is scored</summary>` +
    `<div class="panel knobs" style="margin-top:8px">${knobRows}` +
    `<p class="dim">These are what the ranking is made of, as it runs. They are shown rather than adjustable: a number you can move is a number the history has to be read against, and the history is counting while these are taste.</p>` +
    `</div></details></section>`
  );
}

const PERIODS = [
  { name: "day", label: "Day" },
  { name: "week", label: "Week" },
  { name: "month", label: "Month" },
] as const;

function analyticsSection(state: PageState): string {
  const stats = state.analytics.stats
    .map(
      (one) =>
        `<div class="stat"><div class="lab">${escape(one.label)}</div><div class="val">${escape(one.value)}</div><div class="foot">${escape(one.foot)}</div></div>`,
    )
    .join("");
  const rows = state.analytics.spend
    .map(
      (one) =>
        `<tr><td>${escape(one.project)}</td><td class="muted">${escape(one.seat)}</td><td class="num">${escape(one.tokens)}</td><td class="num">${escape(one.cost)}</td></tr>`,
    )
    .join("");

  const periods = PERIODS.map(
    (one) =>
      `<button class="btn${state.analytics.period === one.name ? " primary" : " quiet"}" data-period="${one.name}">${one.label}</button>`,
  ).join(" ");

  /**
   * The four crossings, behind their own fold. The default view stays small: a
   * period, four totals and the biggest spenders, which is what somebody opening
   * this once a week came for.
   */
  const slices = state.analytics.slices
    .map(
      (slice) =>
        `<details style="margin-top:8px"><summary>${escape(slice.title)}</summary>` +
        `<table class="spend"><thead><tr><th>${escape(slice.of)}</th>` +
        `<th style="text-align:right">Calls</th><th style="text-align:right">Refused</th>` +
        `<th style="text-align:right">In</th><th style="text-align:right">Out</th>` +
        `<th style="text-align:right">Cache</th><th style="text-align:right">At list</th></tr></thead><tbody>` +
        slice.rows
          .map(
            (row) =>
              `<tr><td>${escape(row.of)}</td><td class="num">${escape(row.calls)}</td><td class="num">${escape(row.refused)}</td>` +
              `<td class="num">${escape(row.input)}</td><td class="num">${escape(row.output)}</td>` +
              `<td class="num">${escape(row.cache)}</td><td class="num">${escape(row.cost)}</td></tr>`,
          )
          .join("") +
        `</tbody></table></details>`,
    )
    .join("");

  const body =
    state.analytics.nothing === null
      ? `<div class="stat-row">${stats}</div>` +
        `<table class="spend"><thead><tr><th>Biggest spenders</th><th>Seat</th>` +
        `<th style="text-align:right">Tokens</th><th style="text-align:right">At list</th></tr></thead><tbody>${rows}</tbody></table>` +
        `<div class="knobs">${slices}</div>`
      : `<div class="knobs"><p class="dim">${escape(state.analytics.nothing)}</p></div>`;

  return (
    `<section><details><summary class="sec-head"><h2>Analytics</h2><div class="rule"></div>` +
    `<span class="aside">${escape(state.analytics.when)}</span></summary>` +
    `<div class="panel"><div class="log-bar">${periods}</div>${body}` +
    `<div class="knobs" style="padding-top:0"><p class="dim">${escape(state.analytics.prices)}</p></div>` +
    `</div></details></section>`
  );
}

function logSection(state: PageState): string {
  const lines = state.log
    .map(
      (one) =>
        `<div class="l"><span class="ts">${escape(one.time)}</span><span class="ev ${one.tone}">${escape(one.event)}</span><span>${escape(one.text)}</span></div>`,
    )
    .join("");
  return (
    `<section><details open><summary class="sec-head"><h2>Log</h2><div class="rule"></div></summary>` +
    `<div class="panel" style="overflow:hidden"><div class="log" data-log>${lines}</div>` +
    `<div class="log-bar"><label><input type="checkbox" data-every> Show every exchange</label></div>` +
    `</div></details></section>`
  );
}

function modeSection(state: PageState): string {
  const buttons = MODES.map(
    (one) =>
      `<button class="mode${state.mode === one.name ? " sel" : ""}" data-mode="${one.name}"><b>${one.label}</b><span>${one.saying}</span></button>`,
  ).join("");
  return (
    `<section><div class="sec-head"><h2>Mode</h2><div class="rule"></div></div><div class="panel">` +
    `<div class="modes">${buttons}</div><div class="knobs">` +
    pairs(
      [
        { key: "Mechanism", value: state.mechanism },
        { key: "Stats logins", value: state.statsLogins },
      ],
      "margin:0",
    ) +
    (state.backup === null ? "" : `<p class="dim">${escape(state.backup)}</p>`) +
    `<details style="margin-top:8px"><summary>Machine</summary>${pairs(state.machine, "margin:0")}</details>` +
    `<details style="margin-top:4px"><summary>Undo everything</summary><pre><code>relay uninstall</code></pre></details>` +
    `</div></div></section>`
  );
}

function masthead(state: PageState): string {
  return (
    `<header class="masthead"><span class="wordmark">${escape(state.title)}</span>` +
    `<span class="sub" data-live="subtitle">${escape(state.subtitle)}</span>` +
    `<span class="right"><span class="n" data-live="window">${escape(state.windowSaying)}</span><br>` +
    `<button class="refresh" type="button" data-refresh>` +
    `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">` +
    `<path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.6 2.4v3.3h-3.3"/></svg>` +
    `<span class="n" data-live="read">${escape(state.read)}</span></button></span></header>`
  );
}

/**
 * The whole page.
 *
 * `mark` is the design's `<defs>` block, carrying the Claude mark once so every
 * cord is a `<use>` of it. `script` is the small amount of behaviour the page has.
 */
export function draw(options: { state: PageState; mark: string; knobs: readonly Knob[]; script: string }): string {
  const { state } = options;

  const body =
    state.empty !== null
      ? `<section><div class="empty">${cord("off", 44)}<h3>${escape(state.empty.heading)}</h3>` +
        `<p>${escape(state.empty.body)}</p><pre><code>${escape(state.empty.command)}</code></pre>` +
        `<p class="dim" style="margin-top:12px">${escape(state.empty.foot)}</p></div></section>`
      : payingSection(state) +
        picksSection(state) +
        profilesSection(state) +
        seatsSection(state, options.knobs) +
        analyticsSection(state) +
        logSection(state) +
        modeSection(state);

  return (
    `<!doctype html>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>Relay</title>\n<link rel="icon" href="/icon.svg" type="image/svg+xml">\n<link rel="stylesheet" href="/relay.css">\n<body data-structure="${escape(structure(state))}">\n` +
    options.mark +
    `<div class="page">` +
    masthead(state) +
    banners(state) +
    body +
    `</div>\n<script>${options.script}</script>\n`
  );
}

/**
 * The figures on the page, keyed by the same names the markup carries.
 *
 * The page updates by writing these into place. It never re-renders a list, so a
 * row cannot move under a cursor that is on its way to clicking it, which
 * design.md names as the worst bug this page can have.
 */
export type Live = {
  readonly key: string;
  readonly text?: string;
  readonly html?: string;
  readonly width?: number;
  readonly level?: string;
};

function meterLive(one: Meter, key: string): Live[] {
  const live: Live[] = [{ key, level: one.level }, { key: `${key}-when`, text: one.when }];
  if (one.percent === null) live.push({ key: `${key}-pct`, text: "unknown" });
  else {
    live.push({ key: `${key}-bar`, width: one.percent });
    live.push({ key: `${key}-pct`, html: `<b>${one.percent}%</b> used` });
  }
  return live;
}

export function liveValues(state: PageState): readonly Live[] {
  const live: Live[] = [
    { key: "read", text: state.read },
    { key: "subtitle", text: state.subtitle },
    { key: "window", text: state.windowSaying },
  ];

  if (state.paying.kind === "seat") {
    live.push({ key: "payer:name", html: `${escape(state.paying.name)} <span class="badge big">${escape(state.paying.plan)}</span>` });
    live.push({ key: "payer:sub", text: state.paying.sub });
    state.paying.meters.forEach((one, index) => live.push(...meterLive(one, `payer:meter${index}`)));
  }

  for (const seat of state.groups.flatMap((one) => one.seats)) {
    live.push({ key: `seat:${seat.name}:tag`, html: tag(seat.tag) });
    live.push({ key: `seat:${seat.name}:resets`, text: seat.resets });
    for (const [which, bar] of [["five", seat.five], ["week", seat.week]] as const) {
      live.push({ key: `seat:${seat.name}:${which}-pct`, text: bar.percent === null ? "–" : `${bar.percent}%` });
      if (bar.percent !== null) live.push({ key: `seat:${seat.name}:${which}-bar`, width: bar.percent, level: bar.level });
    }
    seat.meters.forEach((one, index) => live.push(...meterLive(one, `seat:${seat.name}:meter${index}`)));
  }

  return live;
}

/**
 * What would have to be redrawn rather than written into.
 *
 * A Seat appearing, a group emptying, a meter going from unknown to measured: the
 * page reloads for those, because writing a figure into an element that is not
 * there is how a live page starts lying quietly. Everything else is a write.
 */
export function structure(state: PageState): string {
  return JSON.stringify([
    state.mode,
    state.empty !== null,
    state.banners.map((one) => [one.tone, one.heading]),
    state.paying.kind,
    state.paying.kind === "seat" ? state.paying.name : null,
    state.picks.map((one) => one.name),
    state.groups.map((one) => [one.label, one.seats.map((seat) => [seat.name, seat.five.percent === null, seat.week.percent === null, seat.meters.map((meter) => meter.percent === null)])]),
    state.profiles.map((one) => [one.name, one.relayed, one.running]),
    state.analytics.nothing !== null,
    state.analytics.period,
    state.analytics.slices.map((one) => [one.title, one.rows.length]),
  ]);
}
