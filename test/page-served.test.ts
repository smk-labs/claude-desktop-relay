import { strict as assert } from "node:assert";
import { test } from "node:test";

import { startRelay } from "../src/relay/index.ts";
import { pageHandler, pageState, type WhatThePageShows } from "../src/page/index.ts";
import { authorityFor } from "./helpers/authorities.ts";

const OPEN_HOST = "api.anthropic.com";
const NOON = Date.UTC(2026, 7, 23, 12, 0, 0) / 1000;

const facts = (): WhatThePageShows => ({
  choice: { mode: "manual", payer: "Alpha" },
  seats: [
    { name: "Alpha", account: "alpha@example.com", organization: { id: "a41f9c2e", label: "Alpha" }, multiplier: 20, hasSendToken: true },
    { name: "Beta", account: "beta@example.com", organization: { id: "7d5e0114", label: "Beta" }, multiplier: 6.25, hasSendToken: true },
  ],
  usage: [
    { seat: "Alpha", fiveHour: { utilization: 0.63, resetsAt: NOON + 4332, readAt: NOON, readVia: "exchange", ageSeconds: 0, hasReset: false }, sevenDay: { utilization: 0.41, resetsAt: NOON + 200000, readAt: NOON, readVia: "exchange", ageSeconds: 0, hasReset: false }, cooldowns: {} },
    { seat: "Beta", fiveHour: { utilization: 0.1, resetsAt: NOON + 1000, readAt: NOON, readVia: "exchange", ageSeconds: 0, hasReset: false }, sevenDay: { utilization: 0.2, resetsAt: NOON + 300000, readAt: NOON, readVia: "exchange", ageSeconds: 0, hasReset: false }, cooldowns: {} },
  ],
  verdict: null,
  standing: null,
  examination: { findings: [], working: true, service: { installed: true, running: true, pid: 1 } },
  windowRunning: true,
  windowAccount: "me@example.com",
  backedUpOn: "2026-08-22",
  history: [],
  perProjectAndSeat: [],
  log: [{ at: NOON, event: "switched", text: "Alpha, 20x, in force now" }],
  statsLogins: { alive: 6, of: 8 },
  machine: [{ key: "Relay", value: "listening on 127.0.0.1:8978" }],
  profiles: [
    { name: "Main", folder: "/Users/x/Library/Application Support/Claude", where: "~/Library/Application Support/Claude", theUsersOwn: true, running: true, relayed: "no", signedIn: true, account: { email: "cy@example.com", organization: "Acme", uuid: "3041526a" } },
    { name: "Relayed", folder: "/Users/x/.claude-relayed/desktop", where: "~/.claude-relayed/desktop", theUsersOwn: false, running: true, relayed: "this relay", signedIn: true, account: null },
  ],
  readAt: NOON - 47,
  port: 8978,
  at: NOON,
  timeZone: "UTC",
});

async function aRelayServingThePage(
  over: Partial<{
    use: (seat: string) => Promise<void>;
    mode: (mode: "auto" | "manual" | "off") => Promise<void>;
    open: (profile: string) => Promise<void>;
  }> = {},
) {
  const authority = await authorityFor(OPEN_HOST);
  const asked: string[] = [];
  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    onPlainRequest: pageHandler({
      read: async (_asked: { every: boolean }) => facts(),
      use: over.use ?? (async (seat) => void asked.push(`use ${seat}`)),
      mode: over.mode ?? (async (mode) => void asked.push(`mode ${mode}`)),
      open: over.open ?? (async (profile) => void asked.push(`open ${profile}`)),
    }),
  });
  const at = `http://127.0.0.1:${relay.address.port}`;
  return { relay, at, asked };
}

test("the relay serves the page on its own port, with real figures in it", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    const answer = await fetch(at);
    assert.equal(answer.status, 200);
    assert.match(answer.headers.get("content-type") ?? "", /text\/html/);
    const html = await answer.text();

    assert.match(html, /<span class="wordmark">Relay<\/span>/);
    assert.match(html, /2 Seats · 2 accounts · 26.25x combined/);
    assert.match(html, /<h2>Paying now<\/h2>/);
    assert.match(html, /Resets in 1 hr 12 min/);
    assert.match(html, /<b>63%<\/b> used/);
    assert.match(html, /data-seat="Alpha"/);
    assert.match(html, /<span class="tag on">paying<\/span>/);
    assert.match(html, /<link rel="stylesheet" href="\/relay.css">/);
    // Every section the design names, in the order it names them.
    const order = ["Paying now", "Worth switching to", "Claude Desktop profiles", "Every Seat", "Analytics", "Log", "Mode"];
    let last = -1;
    for (const heading of order) {
      const found = html.indexOf(`<h2>${heading}</h2>`);
      assert.ok(found > last, `${heading} is missing or out of order`);
      last = found;
    }
  } finally {
    await relay.close();
  }
});

test("the stylesheet is served as it is, beside the page", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    const answer = await fetch(`${at}/relay.css`);
    assert.equal(answer.status, 200);
    assert.match(answer.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await answer.text(), /--mark:/);
  } finally {
    await relay.close();
  }
});

test("every answer says its own charset, including the JSON ones", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    /**
     * `application/json` is defined as UTF-8 by its own specification, so saying
     * the charset looks redundant and is not. A client that is not told falls
     * back to whatever it guesses, and Windows PowerShell's `Invoke-RestMethod`
     * guesses ISO-8859-1: the tray then drew every middle dot and every en dash
     * in the menu as two characters of rubbish. Measured 2026-08-25.
     *
     * Every route, because the one that did not say it was the one nobody had
     * looked at.
     */
    for (const path of ["/", "/relay.css", "/icon.svg", "/state", "/tray"]) {
      const answer = await fetch(`${at}${path}`);
      assert.match(
        answer.headers.get("content-type") ?? "",
        /charset=utf-8/i,
        `${path} does not say what its bytes are, so a client is left to guess`,
      );
    }

    // And the words the tray shows really do carry characters a wrong guess would
    // ruin, so this is a rule about something rather than about nothing. The menu
    // separates with a middle dot and writes an unknown figure as an en dash.
    const menu = await (await fetch(`${at}/tray`)).text();
    assert.ok(
      [...menu].some((one) => one.codePointAt(0)! > 127),
      "the tray document holds no character a wrong charset could ruin, so this proves nothing",
    );
  } finally {
    await relay.close();
  }
});

test("one document answers the page, and the page's own markup carries its keys", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    const answer = await fetch(`${at}/state`, { headers: { accept: "application/json" } });
    const document = (await answer.json()) as { structure: string; live: { key: string; text?: string }[]; log: unknown[] };

    const html = await (await fetch(at)).text();
    for (const one of document.live) {
      assert.ok(html.includes(`data-live="${one.key}"`), `nothing on the page carries ${one.key}`);
    }
    assert.equal(document.structure, JSON.parse(JSON.stringify(document.structure)));
    assert.equal(document.log.length, 1);
    assert.ok(document.live.some((one) => one.key === "read" && one.text === "read 47 s ago"));
  } finally {
    await relay.close();
  }
});

test("the shape of the page is a string the page can compare itself against", async () => {
  const one = pageState(facts());
  const other = pageState({ ...facts(), readAt: NOON - 4000 });
  const { structure } = await import("../src/page/index.ts");
  assert.equal(structure(one), structure(other), "a figure changing must not force a reload");

  const fewer = pageState({ ...facts(), seats: facts().seats.slice(0, 1) });
  assert.notEqual(structure(one), structure(fewer), "a Seat appearing or leaving must force one");
});

test("an address that is not the page says so rather than answering nothing", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    const answer = await fetch(`${at}/nowhere`);
    assert.equal(answer.status, 404);
    assert.match(await answer.text(), /there is no page at that address/);
  } finally {
    await relay.close();
  }
});

test("a relay with no page still says what it speaks", async () => {
  const authority = await authorityFor(OPEN_HOST);
  const relay = await startRelay({ openHost: OPEN_HOST, certificate: authority.leaf });
  try {
    const answer = await fetch(`http://127.0.0.1:${relay.address.port}/`).catch(() => null);
    assert.equal(answer?.status, 405);
    assert.match((await answer?.text()) ?? "", /this proxy speaks CONNECT/);
  } finally {
    await relay.close();
  }
});

test("the log keeps two levels, and every exchange is only behind the toggle", async () => {
  const { openLogPane } = await import("../src/page/index.ts");
  const pane = openLogPane({ cap: 3 });
  pane.say(1, "switched", "Alpha, in force now");
  pane.exchange(2, "exchange", "Alpha, claude-opus-5, 200");
  assert.deepEqual(pane.lines().map((one) => one.event), ["switched"]);
  assert.deepEqual(pane.lines({ every: true }).map((one) => one.event), ["switched", "exchange"]);
});

test("a page left open for a week cannot grow without bound", async () => {
  const { openLogPane } = await import("../src/page/index.ts");
  const pane = openLogPane({ cap: 3 });
  for (let n = 0; n < 10; n += 1) pane.say(n, "switched", `line ${n}`);
  assert.deepEqual(pane.lines().map((one) => one.text), ["line 7", "line 8", "line 9"]);
});

test("Use on the page is the same call the terminal makes, and it names the Seat", async () => {
  const asked: string[] = [];
  const { relay, at } = await aRelayServingThePage({ use: async (seat) => void asked.push(seat) });
  try {
    const answer = await fetch(`${at}/act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ use: "Beta" }),
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(asked, ["Beta"]);
  } finally {
    await relay.close();
  }
});

test("the Mode is set from the page, and only the three there are", async () => {
  const asked: string[] = [];
  const { relay, at } = await aRelayServingThePage({ mode: async (mode) => void asked.push(mode) });
  const send = (body: unknown) =>
    fetch(`${at}/act`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await send({ mode: "auto" })).status, 200);
    assert.equal((await send({ mode: "off" })).status, 200);
    const refused = await send({ mode: "whatever-it-wants" });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /not a Seat, a Mode or a profile/);
    assert.deepEqual(asked, ["auto", "off"]);
  } finally {
    await relay.close();
  }
});

test("a Seat that cannot pay leaves the previous choice standing, and the page says so", async () => {
  const { relay, at } = await aRelayServingThePage({
    use: async () => {
      throw new Error('there is no Seat called "Gamma"');
    },
  });
  try {
    const answer = await fetch(`${at}/act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ use: "Gamma" }),
    });
    assert.equal(answer.status, 500);
    assert.match(await answer.text(), /there is no Seat called "Gamma"/);
  } finally {
    await relay.close();
  }
});

test("a body too big to be one of ours is refused rather than held", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    const answer = await fetch(`${at}/act`, { method: "POST", body: "x".repeat(20_000) });
    assert.equal(answer.status, 500);
    assert.match(await answer.text(), /too big to be one of ours/);
  } finally {
    await relay.close();
  }
});

test("the page's buttons carry the Seat and the Mode they act on", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    const html = await (await fetch(at)).text();
    assert.match(html, /data-use="Beta"/);
    for (const mode of ["auto", "manual", "off"]) assert.match(html, new RegExp(`data-mode="${mode}"`));
    assert.match(html, /<button class="mode sel" data-mode="manual">/);
  } finally {
    await relay.close();
  }
});

test("the tray is four things: the Seat paying, the Mode, six Seats, and the way to the page", async () => {
  const { pageState, trayMenu } = await import("../src/page/index.ts");
  const menu = trayMenu(pageState(facts()));

  assert.equal(menu.icon, "on");
  assert.equal(menu.saying, "Relay is on");
  assert.equal(menu.paying?.name, "Alpha");
  assert.equal(menu.paying?.plan, "20x");
  assert.equal(menu.mode, "manual");
  assert.deepEqual(
    menu.seats.map((one) => ({ name: one.name, plan: one.plan })),
    [{ name: "Beta", plan: "6.25x" }],
  );
  assert.equal(menu.open, "http://127.0.0.1:8978/");
});

test("every row in the menu says which window, how much is spent, and when it comes back", async () => {
  const { pageState, trayMenu } = await import("../src/page/index.ts");
  const state = pageState(facts());
  const menu = trayMenu(state);

  const alpha = state.groups.flatMap((one) => one.seats).find((one) => one.name === "Alpha");
  assert.equal(alpha?.week.percent, 41, "the page draws the week as a meter");

  // The same figure in words, because a menu has no meter to draw and a bare
  // percentage never said whether it was spent or left.
  // The session first and the week second, everywhere: it is the window that stops
  // work within the hour, and one order across the three trays and the two command
  // lines is the difference between reading a menu and decoding it.
  assert.match(menu.paying?.room ?? "", /^s 63% · in /, `the row read "${menu.paying?.room}"`);
  assert.match(menu.paying?.room ?? "", /w 41% · in /, `the row read "${menu.paying?.room}"`);
  assert.match(menu.seats[0]?.room ?? "", /w 20% · in /, `the row read "${menu.seats[0]?.room}"`);

  // The tooltip is the whole summary without a click, so it spells the letters out.
  assert.match(menu.payingRoom ?? "", /^Session: 63% spent, resets in /);
  assert.match(menu.payingRoom ?? "", /Week: 41% spent, resets in /);

  // And it dates itself: every figure above is a reading from an earlier moment.
  assert.match(menu.refreshed, /^(Refreshed .+ · read |Nothing has been read yet)/, `the menu read "${menu.refreshed}"`);
});

test("the icon carries the four states, and never claims a Seat is paying while the mechanism is down", async () => {
  const { pageState, trayMenu } = await import("../src/page/index.ts");
  const broken = {
    ...facts(),
    examination: { findings: [{ what: "the store", ok: false, saying: "the store changed" }], working: false, service: { installed: true, running: true, pid: 1 } },
  };
  assert.equal(trayMenu(pageState(broken)).icon, "broken");
  assert.equal(trayMenu(pageState(broken)).saying, "Relay is broken");

  const off = { ...facts(), choice: { mode: "off" as const, payer: "Alpha" } };
  assert.equal(trayMenu(pageState(off)).icon, "off");
  assert.equal(trayMenu(pageState(off)).paying, null);

  const spending = facts();
  const strained = {
    ...spending,
    usage: spending.usage.map((one) => (one.seat === "Alpha" ? { ...one, sevenDay: { ...one.sevenDay!, utilization: 0.88 } } : one)),
  };
  assert.equal(trayMenu(pageState(strained)).icon, "strained");
});

test("the relay answers the tray's own small document, at its own address", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    const answer = await fetch(`${at}/tray`);
    assert.equal(answer.status, 200);
    const menu = (await answer.json()) as { paying: { name: string }; seats: unknown[] };
    assert.equal(menu.paying.name, "Alpha");
    assert.equal(menu.seats.length, 1);
  } finally {
    await relay.close();
  }
});

test("switching from the tray is the same call switching from the page is", async () => {
  const asked: string[] = [];
  const { relay, at } = await aRelayServingThePage({ use: async (seat) => void asked.push(seat) });
  try {
    // Byte for byte what src/tray/relay-tray.swift sends.
    await fetch(`${at}/act`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ use: "Beta" }) });
    assert.deepEqual(asked, ["Beta"]);
  } finally {
    await relay.close();
  }
});

test("the page has an icon, and the browser's default request for one is answered too", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    // Named in the head, so the browser does not have to guess.
    const html = await (await fetch(at)).text();
    assert.match(html, /<link rel="icon" href="\/icon\.svg" type="image\/svg\+xml">/);

    const icon = await fetch(`${at}/icon.svg`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type") ?? "", /image\/svg\+xml/);
    const drawn = await icon.text();
    assert.match(drawn, /<svg /, "it has to be an svg, not a page");
    // The same cord the menu bar draws, in Claude's orange, with the colours
    // resolved: a favicon is fetched on its own and has no stylesheet to read.
    assert.match(drawn, /#c96442/);
    assert.doesNotMatch(drawn, /var\(--/, "a favicon cannot resolve a css variable");

    // Browsers ask for this one whether it is named or not, so answering it is also
    // what keeps the log free of 404s for a file that exists under another name.
    const legacy = await fetch(`${at}/favicon.ico`);
    assert.equal(legacy.status, 200);
    assert.equal(await legacy.text(), drawn, "one icon, served under both names");
  } finally {
    await relay.close();
  }
});

test("the page says which profile is relayed, and opens any of them by name", async () => {
  const asked: string[] = [];
  const { relay, at } = await aRelayServingThePage({ open: async (profile) => void asked.push(profile) });
  try {
    const html = await (await fetch(at)).text();
    // Both profiles, and the one word that tells them apart. A page that showed
    // the figures without saying which Claude Desktop they are about is the
    // ambiguity this section exists to remove.
    assert.match(html, /<h2>Claude Desktop profiles<\/h2>/);
    assert.match(html, /data-open="Main"/);
    assert.match(html, /data-open="Relayed"/);
    assert.match(html, /~\/.claude-relayed\/desktop/);
    // One profile relayed and one not, said in words rather than left to a colour.
    assert.match(html, />relayed · open</);
    assert.match(html, />not relayed · open</);
    assert.match(html, />cy@example.com · Acme</);
    assert.match(html, />signed in, reading the account</);

    const answer = await fetch(`${at}/act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ open: "Relayed" }),
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(asked, ["Relayed"]);
  } finally {
    await relay.close();
  }
});

test("the menu carries the profiles too, so the menu bar can open one", async () => {
  const { relay, at } = await aRelayServingThePage();
  try {
    const menu = (await (await fetch(`${at}/tray`)).json()) as { profiles: { name: string; relayed: boolean; saying: string }[] };
    assert.deepEqual(
      menu.profiles.map((one) => [one.name, one.relayed]),
      [["Main", false], ["Relayed", true]],
    );
    assert.equal(menu.profiles[0]?.saying, "cy@example.com · Acme · not relayed · open");
    // Signed in, and the name has not come back yet. Said as our reading rather
    // than as a fact about the profile, and never as "not signed in".
    assert.equal(menu.profiles[1]?.saying, "signed in, reading the account · relayed · open");
  } finally {
    await relay.close();
  }
});
