import { strict as assert } from "node:assert";
import { test } from "node:test";

import { pageState, type WhatThePageShows } from "../src/page/index.ts";
import type { ListedSeat } from "../src/seats/index.ts";
import type { SeatUsage } from "../src/usage/index.ts";

/**
 * Every screen the page can draw, as a table. The moment and the time zone are
 * arguments, so these read the same in Tehran and in a runner set to UTC.
 */
const NOON = Date.UTC(2026, 7, 23, 12, 0, 0) / 1000;
const ZONE = "UTC";

const seat = (over: Partial<ListedSeat> & { name: string }): ListedSeat => ({
  account: `${over.name}@example.com`,
  organization: { id: "a41f9c2e", label: over.name },
  multiplier: 20,
  hasSendToken: true,
  ...over,
});

const known = (utilization: number, resetsIn: number | null) => ({
  utilization,
  resetsAt: resetsIn === null ? null : NOON + resetsIn,
  readAt: NOON - 30,
  readVia: "exchange" as const,
  ageSeconds: 30,
  hasReset: false,
});

const usage = (name: string, five: number | null, week: number | null, over: Partial<SeatUsage> = {}): SeatUsage => ({
  seat: name,
  fiveHour: five === null ? null : known(five, 4332),
  sevenDay: week === null ? null : known(week, 2 * 86400 + 6 * 3600),
  cooldowns: {},
  ...over,
});

const working = { findings: [{ what: "the store", ok: true, saying: "it is there" }], working: true, service: { installed: true, running: true, pid: 1 } };

const base = (over: Partial<WhatThePageShows> = {}): WhatThePageShows => ({
  choice: { mode: "manual", payer: "Alpha" },
  seats: [seat({ name: "Alpha" }), seat({ name: "Beta", multiplier: 6.25 })],
  usage: [usage("Alpha", 0.63, 0.41), usage("Beta", 0.1, 0.2)],
  verdict: null,
  standing: null,
  examination: working,
  windowRunning: true,
  windowAccount: "me@example.com",
  backedUpOn: null,
  history: [],
  perProjectAndSeat: [],
  log: [],
  statsLogins: { alive: 6, of: 8 },
  machine: [{ key: "Relay", value: "listening on 127.0.0.1:8978" }],
  readAt: NOON - 47,
  port: 8978,
  at: NOON,
  timeZone: ZONE,
  ...over,
});

test("the masthead counts the Seats, the accounts and the Multipliers", () => {
  const state = pageState(base());
  assert.equal(state.subtitle, "2 Seats · 2 accounts · 26.25x combined");
  assert.equal(state.read, "read 47 s ago");
  assert.equal(state.account, "me@example.com");
});

test("the Paying now panel names the Seat, and spells its units out", () => {
  const state = pageState(base());
  assert.equal(state.paying.kind, "seat");
  assert.equal(state.paying.kind === "seat" && state.paying.name, "Alpha");
  assert.equal(state.paying.kind === "seat" && state.paying.plan, "20x");
  // The account and nothing else: the Organization's UUID is thirty-six characters
  // nobody reads, and the Seat's own name already says which Organization it is.
  assert.equal(state.paying.kind === "seat" && state.paying.sub, "Alpha@example.com");
  const meters = state.paying.kind === "seat" ? state.paying.meters : [];
  assert.deepEqual(
    meters.map((one) => [one.label, one.when, one.percent]),
    [
      // Claude's own words for the two windows, and both answer "how much longer"
      // rather than naming a day and a time.
      ["Session", "Resets in 1 hr 12 min", 63],
      ["Weekly", "Resets in 2 d 6 hr", 41],
    ],
  );
});

test("the list says the same figures in its own shorter words", () => {
  const state = pageState(base());
  const alpha = state.groups.flatMap((group) => group.seats).find((one) => one.name === "Alpha");
  assert.equal(alpha?.resets, "in 2 d 6 h");
  assert.deepEqual(
    alpha?.meters.map((one) => one.when),
    ["resets in 1 hr 12 min", "resets in 2 d 6 hr"],
  );
  assert.deepEqual(alpha?.tag, { text: "paying", tone: "on" });
  assert.equal(alpha?.cord, "on");
});

test("a meter turns amber past three quarters and red once it is nearly gone", () => {
  const state = pageState(base({ usage: [usage("Alpha", 0.8, 0.99), usage("Beta", 0.1, 0.2)] }));
  const alpha = state.groups.flatMap((group) => group.seats).find((one) => one.name === "Alpha");
  assert.equal(alpha?.five.level, "warn");
  assert.equal(alpha?.week.level, "full");
});

test("a Seat with nothing measured reads unknown, never zero", () => {
  const state = pageState(base({ usage: [usage("Beta", 0.1, 0.2)] }));
  const alpha = state.groups.flatMap((group) => group.seats).find((one) => one.name === "Alpha");
  assert.equal(alpha?.week.percent, null);
  assert.equal(alpha?.five.percent, null);
  assert.equal(alpha?.resets, "unknown");
});

test("three groups, and a spent Seat leaves the ranking rather than sitting at its foot", () => {
  const state = pageState(
    base({
      seats: [seat({ name: "Alpha" }), seat({ name: "Beta" }), seat({ name: "Gamma" })],
      usage: [usage("Alpha", 0.63, 0.41), usage("Beta", 0, 0), usage("Gamma", 0.2, 0.99)],
    }),
  );
  assert.deepEqual(
    state.groups.map((group) => [group.label, group.count, group.seats.map((one) => one.name)]),
    [
      ["Available now", 1, ["Alpha"]],
      ["Untouched this week", 1, ["Beta"]],
      ["Nothing left", 1, ["Gamma"]],
    ],
  );
  const gamma = state.groups[2]?.seats[0];
  assert.deepEqual(gamma?.tag, { text: "spent", tone: "off" });
  assert.equal(gamma?.note, "Not a candidate until the week resets. The Seat is healthy, only empty.");
});

test("a Seat with no Send token cannot be a candidate, and says why", () => {
  const state = pageState(base({ seats: [seat({ name: "Alpha" }), seat({ name: "Beta", hasSendToken: false })] }));
  const beta = state.groups.flatMap((group) => group.seats).find((one) => one.name === "Beta");
  assert.equal(beta?.group, "spent");
  assert.deepEqual(beta?.tag, { text: "no Send token", tone: "off" });
});

test("a Refusal holds a Seat out, and the row says for how much longer", () => {
  const state = pageState(
    base({
      usage: [usage("Alpha", 0.63, 0.41), usage("Beta", 0.1, 0.2, { cooldowns: { "claude-opus-5": NOON + 1560 } })],
      history: [
        { at: NOON - 240, seat: "Beta", organizationId: null, model: "claude-opus-5", status: 429, refused: true, tokens: null, utilization: { fiveHour: null, sevenDay: null }, project: null, session: null },
      ],
    }),
  );
  const beta = state.groups.flatMap((group) => group.seats).find((one) => one.name === "Beta");
  assert.equal(beta?.cord, "broken");
  assert.deepEqual(beta?.tag, { text: "refused 4 m ago", tone: "broken" });
  assert.match(beta?.note ?? "", /^Refused on claude-opus-5 at 11:56, so it is held out of Auto for that model for 26 m more\./);
  assert.match(beta?.note ?? "", /A Refusal is evidence about one request, never proof a Seat is spent\.$/);
});

test("no Seats at all replaces the page with what to type", () => {
  const state = pageState(base({ seats: [], usage: [] }));
  assert.equal(state.empty?.heading, "No Seats collected yet");
  assert.equal(state.empty?.command, "relay collect-seats");
  assert.equal(state.groups.length, 0);
});

test("nothing measured anywhere raises a banner and ranks by plan size", () => {
  const state = pageState(base({ usage: [], statsLogins: { alive: 0, of: 8 } }));
  assert.equal(state.rankedByPlanSize, true);
  assert.equal(state.groups[0]?.label, "Ranked by plan size");
  const banner = state.banners.find((one) => one.tone === "strain");
  assert.equal(banner?.heading, "Usage is unknown for 2 of 2 Seats.");
  assert.match(banner?.body ?? "", /^every Stats login has expired/);
  assert.match(banner?.foot ?? "", /^Re-read them with relay refresh\.$/);
});

test("a broken mechanism never lets the page claim who is paying", () => {
  const state = pageState(
    base({
      examination: { ...working, working: false, findings: [{ what: "the store", ok: false, saying: "The store went from format 3 to format 4." }] },
    }),
  );
  const banner = state.banners[0];
  assert.equal(banner?.tone, "critical");
  assert.equal(banner?.heading, "Nothing is being swapped.");
  assert.match(banner?.body ?? "", /paid for by the Window account\. The store went from format 3 to format 4\.$/);
  assert.equal(banner?.command, "relay doctor");
  assert.equal(state.mechanism, "not working");
});

test("every Seat spent hands the panel to the Window account, with the nearest reset", () => {
  const state = pageState(
    base({
      choice: { mode: "auto", payer: null },
      standing: null,
      usage: [usage("Alpha", 0.2, 0.99), usage("Beta", 0.2, 0.995)],
    }),
  );
  assert.equal(state.paying.kind, "window");
  assert.equal(state.paying.kind === "window" && state.paying.heading, "The Window account is paying");
  assert.match(state.paying.kind === "window" ? state.paying.sub : "", /no Seat has room/);
  assert.deepEqual(
    state.paying.kind === "window" ? state.paying.figures.map((one) => [one.label, one.value]) : [],
    [
      ["Seats with room", "0 of 2"],
      ["Nearest reset", "1 h 12 m"],
      ["Then", "1 h 12 m"],
    ],
  );
});

test("Off says it is Off rather than pretending nothing has room", () => {
  const state = pageState(base({ choice: { mode: "off", payer: "Alpha" } }));
  assert.equal(state.mode, "off");
  assert.match(state.paying.kind === "window" ? state.paying.sub : "", /· Off, so nothing is being swapped/);
  assert.deepEqual(state.paying.kind === "window" ? state.paying.figures : null, []);
});

test("Auto names the Seat it settled on, not the one that was picked by hand", () => {
  const state = pageState(base({ choice: { mode: "auto", payer: "Alpha" }, standing: { seat: "Beta", because: "it-had-the-most-room", at: NOON - 5 } }));
  assert.equal(state.paying.kind === "seat" && state.paying.name, "Beta");
});

test("the switch suggestions leave out the Seat already paying, best value first", () => {
  const state = pageState(
    base({
      seats: [seat({ name: "Alpha" }), seat({ name: "Beta" }), seat({ name: "Gamma", multiplier: 1.25 })],
      usage: [usage("Alpha", 0.63, 0.41), usage("Beta", 0.1, 0.12), usage("Gamma", 0.1, 0.06)],
    }),
  );
  assert.deepEqual(
    state.picks.map((one) => [one.name, one.percent, one.primary]),
    [
      ["Beta", 12, true],
      ["Gamma", 6, false],
    ],
  );
});

test("the analytics view costs each bucket at its own rate, never one total split four ways", () => {
  const tokens = { input: 1_000_000, output: 1_000_000, cacheWritten: 0, cacheRead: 0 };
  const state = pageState(
    base({
      history: [{ at: NOON - 3600, seat: "Alpha", organizationId: null, model: "claude-sonnet-4-5", status: 200, refused: false, tokens, utilization: { fiveHour: null, sevenDay: null }, project: "relay", session: "s" }],
      perProjectAndSeat: [{ of: "relay · Alpha", exchanges: 1, refusals: 0, input: 1_000_000, output: 1_000_000, cacheWritten: 0, cacheRead: 0, wouldHaveCost: 18, unpriced: 0 }],
    }),
  );
  assert.equal(state.analytics.when, "last 7 days, to 23 Aug 12:00");
  const [input, output] = state.analytics.stats;
  assert.equal(input?.label, "Input");
  assert.equal(input?.value, "1.00M");
  assert.notEqual(input?.foot, output?.foot);
  assert.deepEqual(state.analytics.spend, [{ project: "relay", seat: "Alpha", tokens: "2.0M", cost: "$18.00" }]);
  assert.equal(state.analytics.nothing, null);
});

test("an empty history says so rather than showing a row of zeroes with no explanation", () => {
  const state = pageState(base());
  assert.equal(state.analytics.nothing, "Nothing was paid for by a Seat in the last 7 days.");
});

test("held Send tokens with no backup are said on the page, not only in a document", () => {
  assert.match(pageState(base()).backup ?? "", /^None of the 2 Send tokens is backed up\./);
  assert.equal(pageState(base({ backedUpOn: "2026-08-22" })).backup, "2 Send tokens, last backed up 2026-08-22.");
});

test("the log is stamped in the reader's own zone", () => {
  const state = pageState(base({ log: [{ at: NOON + 131, event: "switched", text: "Auto chose Alpha" }] }));
  assert.deepEqual(state.log, [{ time: "12:02:11", event: "switched", text: "Auto chose Alpha", tone: "switch" }]);
});

test("the analytics view slices by Seat, by model, by project, and crosses two of them", () => {
  const tokens = { input: 100, output: 50, cacheWritten: 10, cacheRead: 900 };
  const row = (over: Partial<{ seat: string; model: string; project: string; refused: boolean }>) => ({
    at: NOON - 3600,
    seat: over.seat ?? "Alpha",
    organizationId: null,
    model: over.model ?? "claude-opus-5",
    status: over.refused === true ? 429 : 200,
    refused: over.refused ?? false,
    tokens,
    utilization: { fiveHour: null, sevenDay: null },
    project: over.project ?? "relay",
    session: "s",
  });

  const state = pageState(
    base({
      history: [row({}), row({ seat: "Beta", model: "claude-sonnet-4-5", project: "readable" }), row({ refused: true })],
    }),
  );

  assert.deepEqual(
    state.analytics.slices.map((one) => [one.title, one.rows.map((each) => each.of)]),
    [
      ["By Seat", ["Alpha", "Beta"]],
      ["By model", ["claude-opus-5", "claude-sonnet-4-5"]],
      ["By project", ["relay", "readable"]],
      ["By project, on which Seat", ["relay · Alpha", "readable · Beta"]],
    ],
  );
  const alpha = state.analytics.slices[0]?.rows[0];
  assert.equal(alpha?.calls, "2", "the count behind a figure is what makes it arguable");
  assert.equal(alpha?.refused, "1");
  assert.notEqual(alpha?.output, alpha?.cache, "output and cache are never merged into one number");
});

test("the period is chosen, and the price table says when it was published", () => {
  const older = { at: NOON - 10 * 86400, seat: "Alpha", organizationId: null, model: "claude-opus-5", status: 200, refused: false, tokens: { input: 1, output: 1, cacheWritten: 0, cacheRead: 0 }, utilization: { fiveHour: null, sevenDay: null }, project: "relay", session: "s" };
  assert.equal(pageState(base({ history: [older] })).analytics.nothing, "Nothing was paid for by a Seat in the last 7 days.");
  const month = pageState(base({ history: [older], period: "month" }));
  assert.equal(month.analytics.nothing, null);
  assert.equal(month.analytics.when, "last 30 days, to 23 Aug 12:00");
  assert.match(month.analytics.prices, /published 2026-06\. They are not what you paid/);
});

/**
 * ADR 0014 left two Claude Desktop profiles on this machine and only one relayed,
 * so a menu or a page that never names which one is being described leaves the
 * reader guessing which Window the figures belong to. The tray borrows that line
 * from the machine rows rather than being told it twice.
 */
test("the tray names the profile it is relaying, and never guesses it", async () => {
  const { trayMenu, RELAYING_ROW } = await import("../src/page/index.ts");

  const saying = "~/.claude-relayed/desktop \u00b7 every Code session in it";
  const withRow = pageState(
    base({ machine: [{ key: "Relay", value: "listening on 127.0.0.1:8978" }, { key: RELAYING_ROW, value: saying }] }),
  );
  assert.equal(trayMenu(withRow).relaying, saying);

  // Looked up by the one exported name, so renaming the row cannot leave the menu
  // silently showing nothing.
  assert.equal(RELAYING_ROW, "Relaying");

  // No such row, and it says nothing rather than inventing a folder.
  assert.equal(trayMenu(pageState(base({ machine: [] }))).relaying, null);
});

/**
 * On with nothing chosen yet is not Off, and it is not everything spent.
 *
 * Measured on the real thing 2026-08-24, after the machine slept: the command line
 * said "nothing has asked yet, so nothing has been chosen", which was right, while
 * the menu bar said "Relay is off" and the page said "no Seat has room" directly
 * above its own figure saying nearly every Seat had room. Three surfaces, three
 * different answers, one of them self-contradictory.
 */
test("Auto with nothing chosen yet says so, and never claims the Window account is paying", async () => {
  const { trayMenu } = await import("../src/page/index.ts");
  // Auto, and no payer settled, which is every moment between a restart and the
  // next request.
  const state = pageState(base({ choice: { mode: "auto", payer: null } }));

  assert.equal(state.paying.kind, "window");
  assert.equal(state.paying.kind === "window" && state.paying.waitingToChoose, true);
  assert.match(state.paying.kind === "window" ? state.paying.heading : "", /has not chosen yet/);
  assert.doesNotMatch(
    state.paying.kind === "window" ? state.paying.sub : "",
    /no Seat has room/,
    "it must not claim nothing can serve while Seats have room",
  );

  // The menu bar reads the same document, so it cannot disagree.
  const menu = trayMenu(state);
  assert.equal(menu.icon, "on", "the relay is on: the mode says so and Seats have room");
  assert.match(menu.saying, /on, and has not chosen a Seat yet/);
  assert.doesNotMatch(menu.payingSaying, /Window account/, "nothing is being paid from the Window account");
});

test("everything spent still says the Window account is paying, and is told apart from waiting", async () => {
  const { trayMenu } = await import("../src/page/index.ts");
  // Both Seats spent for the week, so there is genuinely nothing that can serve.
  const state = pageState(base({ choice: { mode: "auto", payer: null }, usage: [usage("Alpha", 0.1, 1), usage("Beta", 0.1, 1)] }));

  assert.equal(state.paying.kind === "window" && state.paying.waitingToChoose, false);
  assert.match(state.paying.kind === "window" ? state.paying.sub : "", /no Seat has room/);
  assert.equal(trayMenu(state).icon, "off");
});

test("Off says Off, whatever the Seats have left", async () => {
  const { trayMenu } = await import("../src/page/index.ts");
  const state = pageState(base({ choice: { mode: "off", payer: null } }));
  assert.equal(state.paying.kind === "window" && state.paying.waitingToChoose, false);
  assert.equal(trayMenu(state).icon, "off");
  assert.match(trayMenu(state).saying, /Relay is off/);
});

/**
 * The table says "Best value first" over it, so it has to be.
 *
 * It used to be sorted by Multiplier and then alphabetically, which reads as a
 * ranking and is not one: on the real machine a Seat with 7% of its week gone sat
 * above one with 13% but below one with 47%, purely because of its name. The table
 * then disagreed with the six suggestions drawn above it and with what Auto did.
 */
test("Every Seat is ordered the way the Chooser ranks, not by name", () => {
  const state = pageState(
    base({
      seats: [
        seat({ name: "Zulu", multiplier: 20 }),
        seat({ name: "Alpha", multiplier: 20 }),
        seat({ name: "Mike", multiplier: 20 }),
      ],
      // Zulu has the most of its week left, Alpha the least, and the names run the
      // other way, so name order and value order cannot be confused.
      usage: [usage("Zulu", 0.1, 0.05), usage("Alpha", 0.1, 0.8), usage("Mike", 0.1, 0.4)],
      choice: { mode: "auto", payer: null },
    }),
  );

  const order = state.groups.flatMap((group) => group.seats).map((one) => one.name);
  assert.deepEqual(order, ["Zulu", "Mike", "Alpha"], `alphabetical would be Alpha, Mike, Zulu: got ${order.join(", ")}`);

  // And the table agrees with the suggestions above it, which is the whole point.
  const suggested = state.picks.map((one) => one.name);
  assert.deepEqual(suggested.slice(0, 2), ["Zulu", "Mike"], `the suggestions say ${suggested.join(", ")}`);
});

/**
 * A chip only when there is something to say.
 *
 * Every card used to carry one and most of them read "five hours untouched", which
 * is a line spent saying nothing. The one thing worth the space is a weekly window
 * about to turn over, because what is left on that Seat is about to be lost.
 */
test("a Seat with nothing urgent about it carries no chip at all", () => {
  const state = pageState(base({ choice: { mode: "auto", payer: null } }));
  const quiet = state.picks.filter((one) => one.chip !== null);
  assert.deepEqual(quiet, [], `these said something when they had nothing to say: ${quiet.map((o) => o.chip).join(", ")}`);
});

test("a weekly window about to turn over is amber inside fifteen hours and red inside five", () => {
  const chipAt = (hours: number): { chip: string | null; tone: string | null } => {
    const state = pageState(
      base({
        seats: [seat({ name: "Alpha", multiplier: 20 })],
        // The helper takes seconds from now, which is what the chip is about.
        usage: [usage("Alpha", null, 0.4, { sevenDay: known(0.4, Math.round(hours * 3600)) })],
        choice: { mode: "auto", payer: null },
      }),
    );
    const pick = state.picks[0];
    return { chip: pick?.chip ?? null, tone: pick?.chipTone ?? null };
  };

  assert.equal(chipAt(20).chip, null, "twenty hours away is not news");
  assert.equal(chipAt(16).chip, null, "sixteen hours away is not news");

  assert.equal(chipAt(14).tone, "warn", "inside fifteen hours it is amber");
  assert.equal(chipAt(6).tone, "warn", "still amber at six");
  assert.match(chipAt(14).chip ?? "", /^resets in /, "and it says how long, not when");

  assert.equal(chipAt(4).tone, "urgent", "inside five hours it is red");
  assert.equal(chipAt(0.5).tone, "urgent", "and still red at the end");
});

/** Claude's own words, so two screens about one subscription do not use two vocabularies. */
test("the windows are called Session and Weekly, and every reset says how long, never when", () => {
  const state = pageState(base());
  const alpha = state.groups.flatMap((group) => group.seats).find((one) => one.name === "Alpha");
  assert.deepEqual(alpha?.meters.map((one) => one.label), ["Session", "Weekly"]);
  for (const meter of alpha?.meters ?? []) {
    assert.doesNotMatch(meter.when, /\d{1,2}:\d{2}/, `"${meter.when}" is a clock reading, not a duration`);
  }
});
