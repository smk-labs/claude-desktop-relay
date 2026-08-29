/**
 * The health check, and the one thing it must never do: claim the mechanism is
 * working because our own files look right.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { examineLinux, judgeTheStore, judgeTheWindow } from "../internal/examine.ts";
import { linuxStatusLines } from "../internal/say-status.ts";

/** A port nothing is on. Chosen high and odd so a real service is unlikely. */
const NOBODY_IS_ON = 47311;

test("nothing listening is a failure that names the port and what to type", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-examine-"));
  const ca = join(folder, "ca.crt");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\n");

  const found = await examineLinux({
    port: NOBODY_IS_ON,
    caCertificate: ca,
    seatsWithTokens: 3,
    desktopFolder: join(folder, "no-such-window"),
  });

  assert.equal(found.working, false);
  const relay = found.findings.find((one) => one.what === "the relay");
  assert.equal(relay?.ok, false);
  assert.match(relay?.saying ?? "", new RegExp(`${NOBODY_IS_ON}`));

  // No Window on that folder, and it says so rather than passing silently.
  assert.equal(found.windowPid, null);
  assert.equal(found.findings.find((one) => one.what === "the Window")?.ok, false);
});

test("a missing certificate and no Seats are each their own finding", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-examine-"));
  const found = await examineLinux({
    port: NOBODY_IS_ON,
    caCertificate: join(folder, "ca.crt"),
    seatsWithTokens: 0,
    desktopFolder: folder,
  });

  assert.equal(found.findings.find((one) => one.what === "the certificate")?.ok, false);
  assert.equal(found.findings.find((one) => one.what === "the Seats")?.ok, false);
});

test("a broken mechanism is never reported as a Seat that is paying", () => {
  const broken = {
    findings: [{ what: "the relay", ok: false, saying: "nothing is listening" }],
    working: false,
    windowPid: null,
  };

  const lines = linuxStatusLines({
    choice: { mode: "manual", payer: "dana-acme" },
    seats: [],
    usage: [],
    verdict: null,
    standing: null,
    examination: broken,
    at: 1_800_000_000,
  });

  assert.match(lines[0] ?? "", /not known/);
  assert.ok(!lines.join("\n").includes("Paying: dana-acme"), "it claimed a Seat was paying anyway");
});

test("off says the Window account is paying, and says why", () => {
  const lines = linuxStatusLines({
    choice: { mode: "off", payer: "dana-acme" },
    seats: [],
    usage: [],
    verdict: null,
    standing: null,
    examination: { findings: [{ what: "the relay", ok: true, saying: "listening" }], working: true, windowPid: 1 },
    at: 1_800_000_000,
  });

  assert.match(lines[0] ?? "", /Paying: the Window account, because the relay is off/);
});


const WANTED = { https_proxy: "http://127.0.0.1:8978", NODE_EXTRA_CA_CERTS: "/home/me/ca.crt" };
const A_STORE = "/home/me/desktop-trial/profile/ccd-environment-config.json";

test("a store that could not be opened is not a store with the wrong things in it", () => {
  const finding = judgeTheStore({ file: A_STORE, there: true, held: null, wanted: WANTED });

  assert.equal(finding.ok, true, "an unreadable store was called broken");
  assert.match(finding.saying, /could not be opened from here/);
  assert.ok(!/missing/.test(finding.saying), "it named variables as missing when it had not read them");
});

test("a store missing one variable names that one", () => {
  const finding = judgeTheStore({
    file: A_STORE,
    there: true,
    held: { https_proxy: "http://127.0.0.1:8978" },
    wanted: WANTED,
  });

  assert.equal(finding.ok, false);
  assert.match(finding.saying, /missing NODE_EXTRA_CA_CERTS/);
});

test("a store with everything in it is what makes any launch relayed", () => {
  const finding = judgeTheStore({ file: A_STORE, there: true, held: { ...WANTED }, wanted: WANTED });

  assert.equal(finding.ok, true);
  assert.match(finding.saying, /every Code session comes to us/);
});

/**
 * The one a person actually hits: the store is right, and the Window in front of
 * them was opened before it was written, so it read nothing. Nothing on disk says
 * so; only the two timestamps do.
 */
test("a Window older than the store is told to restart, not called fine", () => {
  const finding = judgeTheWindow({ pid: 4242, startedAt: 1_000, storeWrittenAt: 2_000 });

  assert.equal(finding.ok, false);
  assert.match(finding.saying, /started before the store was written/);
  assert.match(finding.saying, /open it again/);
});

test("a Window opened after the store is fine, and no Window at all says how to start one", () => {
  assert.equal(judgeTheWindow({ pid: 7, startedAt: 3_000, storeWrittenAt: 2_000 }).ok, true);

  const none = judgeTheWindow({ pid: null, startedAt: null, storeWrittenAt: 2_000 });
  assert.equal(none.ok, false);
  assert.match(none.saying, /no Claude Desktop is running/);
});

/**
 * The line a person actually reads on every screen here, and the one that was
 * wrong for two days: `7d 1%` put a duration where a window's name belonged and
 * never said whether the share was spent or left.
 */
const A_WEEK = 7 * 24 * 3600;
const NOW = 1_800_000_000;

const aReading = (utilization: number, resetsIn: number, ageSeconds = 30) => ({
  utilization,
  resetsAt: NOW + resetsIn,
  readVia: "exchange" as const,
  readAt: NOW - ageSeconds,
  ageSeconds,
  hasReset: false,
});

test("room says which window, how much is spent, and when it comes back", async () => {
  const { roomBrief, roomSpelled } = await import("../../src/control/index.ts");

  const usage = {
    seat: "bo-acme-a1b2",
    sevenDay: aReading(0.01, A_WEEK - 16 * 3600),
    fiveHour: aReading(0.08, 2 * 3600 + 6 * 60),
    cooldowns: {},
  };

  const brief = roomBrief(usage, NOW);
  // Session first, then the week: one order across all three trays, both command
  // lines and the page.
  assert.match(brief, /^s 8% · in 2h 6m {3}w 1% · in 6d 8h$/, `brief was "${brief}"`);
  // The old wording must not come back by accident anywhere.
  assert.ok(!/7d/.test(brief), "the week is still being called 7d");

  const spelled = roomSpelled(usage, NOW);
  assert.match(spelled, /Week: 1% spent, resets in 6d 8h/);
  assert.match(spelled, /Session: 8% spent, resets in 2h 6m/);
});

test("a window that has turned over is fresh, not zero", async () => {
  const { roomBrief } = await import("../../src/control/index.ts");

  const brief = roomBrief(
    {
      seat: "s",
      sevenDay: { ...aReading(0, A_WEEK), hasReset: true },
      fiveHour: aReading(0.5, 600),
      cooldowns: {},
    },
    NOW,
  );

  assert.match(brief, /^s 50% · in 10m {3}w fresh$/, `brief was "${brief}"`);
});

test("an old reading says so, a recent one does not, and nothing known says that", async () => {
  const { roomBrief } = await import("../../src/control/index.ts");

  const old = roomBrief(
    { seat: "s", sevenDay: aReading(0.4, A_WEEK, 3 * 3600), fiveHour: null, cooldowns: {} },
    NOW,
  );
  assert.match(old, /read 3h ago$/);

  const fresh = roomBrief({ seat: "s", sevenDay: aReading(0.4, A_WEEK, 20), fiveHour: null, cooldowns: {} }, NOW);
  assert.ok(!/ago/.test(fresh), `a fresh reading carried an age: "${fresh}"`);

  assert.equal(roomBrief(undefined, NOW), "no reading yet");
});

/**
 * Which Seats are worth a request. The rule that matters is the first one: a Seat
 * nothing is known about is the one the list has nothing to say about, and the
 * worst one to be quiet about.
 */
test("a Seat never read is stale, an old one is, a fresh one is not, and one with no token is never asked", async () => {
  const { whichAreStale } = await import("../../src/usage/index.ts");

  const stale = whichAreStale({
    seats: [
      { name: "never-read", hasSendToken: true },
      { name: "old", hasSendToken: true },
      { name: "fresh", hasSendToken: true },
      { name: "no-token", hasSendToken: false },
    ],
    usage: [
      { seat: "old", sevenDay: aReading(0.4, A_WEEK, 3600), fiveHour: null, cooldowns: {} },
      { seat: "fresh", sevenDay: aReading(0.4, A_WEEK, 30), fiveHour: null, cooldowns: {} },
      { seat: "no-token", sevenDay: aReading(0.4, A_WEEK, 9999), fiveHour: null, cooldowns: {} },
    ],
    olderThan: 25 * 60,
  });

  assert.deepEqual([...stale].sort(), ["never-read", "old"]);
});
