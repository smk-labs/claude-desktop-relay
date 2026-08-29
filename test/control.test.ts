/**
 * The one control surface, driven through `runControl` rather than by spawning.
 *
 * Everything that touches this machine is behind the `Machine` seam, and every
 * moment is an argument, so the whole screen is asserted as a table. Two things
 * this file must never do, and the reason it is shaped this way: install or undo
 * anything real, and go anywhere near the machine's Keychain. The old spawn test
 * for the undo command did reach the Keychain, and passed only because this
 * machine happened to hold the token it named.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aWindowUnder, relayHome, type Home } from "../src/home/index.ts";
import { roomBrief, runControl, seatLines, statusLines, type Examination, type Machine } from "../src/control/index.ts";
import { openSeatStore, type Vault } from "../src/seats/index.ts";
import { openUsageMemory } from "../src/usage/index.ts";
import { readChoice, writeChoice } from "../src/payer/index.ts";
import { judge, openVerdictLog } from "../src/verify/index.ts";
import { LIKE_CODE } from "./helpers/a-decision.ts";
import type { Exchange } from "../src/relay/index.ts";

const NOON = 1_776_000_000;

const WORKING: Examination = {
  findings: [{ what: "the relay", ok: true, saying: "answering on 127.0.0.1:8978" }],
  working: true,
  service: { installed: true, running: true, pid: 4242 },
};

const BROKEN: Examination = {
  findings: [
    { what: "the relay", ok: false, saying: "nothing is listening on 127.0.0.1:8978" },
    { what: "the service", ok: true, saying: "running as pid 4242" },
  ],
  working: false,
  service: { installed: true, running: true, pid: 4242 },
};

/** A Machine that records what it was asked and does nothing to this one. */
function aStandIn(over: Partial<Machine> = {}) {
  const asked: string[] = [];
  const machine: Machine = {
    install: async (say) => void say("installed"),
    uninstall: async (say) => {
      asked.push("uninstall");
      say("uninstalled");
      return true;
    },
    examine: async () => WORKING,
    windowRunning: async () => false,
    open: async (where) => void asked.push(`open ${where}`),
    handOffTo: async (script, args) => {
      asked.push(`${script} ${args.join(" ")}`.trim());
      return 0;
    },
    ...over,
  };
  return { machine, asked };
}

/** Nowhere near the real Keychain: the vault is a map this test owns. */
function aVault(tokens: Readonly<Record<string, string>> = {}): Vault {
  const held = new Map(Object.entries(tokens));
  return {
    put: async (name, token) => void held.set(name, token),
    get: async (name) => held.get(name) ?? null,
    forget: async (name) => void held.delete(name),
  };
}

const A_SEAT = {
  name: "work",
  account: "one@example.com",
  organization: { id: "org-acme", label: "Acme" },
  multiplier: 20 as const,
};

async function aBench(options: { tokens?: Readonly<Record<string, string>> } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "relay-control-"));
  const home: Home = relayHome(aWindowUnder(folder));
  const seats = openSeatStore({ file: home.seatsFile, vault: aVault(options.tokens) });
  const usage = openUsageMemory({ file: home.usageFile });
  const said: string[] = [];
  const complained: string[] = [];

  return {
    home,
    seats,
    usage,
    said,
    complained,
    /** Everything printed, as one block, for a match against a whole screen. */
    screen: () => said.join("\n"),
    everything: () => [...said, ...complained].join("\n"),
    run: (machine: Machine, ...argv: string[]) =>
      runControl({
        argv,
        machine,
        home,
        seats,
        usage,
        now: () => NOON,
        out: { say: (line) => said.push(line ?? ""), complain: (line) => complained.push(line) },
      }),
    forget: () => rm(folder, { recursive: true, force: true }),
  };
}

// ---- the answer to the daily question ---------------------------------------

test("with no arguments it says which Seat is paying, how much room it has, and what to type next", async () => {
  const lines = statusLines({
    choice: { mode: "manual", payer: "work" },
    seats: [{ ...A_SEAT, hasSendToken: true }],
    usage: [
      {
        seat: "work",
        fiveHour: {
          utilization: 0.42,
          resetsAt: NOON + 3600,
          readAt: NOON - 120,
          readVia: "exchange",
          ageSeconds: 120,
          hasReset: false,
        },
        sevenDay: null,
        cooldowns: {},
      },
    ],
    verdict: null,
    examination: WORKING,
    windowRunning: true,
    backedUpOn: "2026-08-22",
    standing: null,
    at: NOON,
  }).join("\n");

  // The four things, in the order the question is asked in.
  assert.match(lines, /^Paying: work {2}\(20x, Acme\)/, "the name first, because that is the question");
  assert.match(lines, /42% spent/);
  assert.match(lines, /resets in 1h/);
  assert.match(lines, /from a reply, 2m ago/, "a figure that cannot be dated must not read as current");
  assert.match(lines, /Mechanism: live/);
  assert.match(lines, /Next:/);
  assert.match(lines, /relay off/);
  assert.match(lines, /relay use <seat>/);
});

test("a Seat nothing is known about says so, rather than reading as untouched", async () => {
  const lines = statusLines({
    choice: { mode: "manual", payer: "work" },
    seats: [{ ...A_SEAT, hasSendToken: true }],
    usage: [],
    verdict: null,
    examination: WORKING,
    windowRunning: true,
    backedUpOn: "2026-08-22",
    standing: null,
    at: NOON,
  }).join("\n");

  // A Send token cannot read usage from any endpoint, so a Seat that has not paid
  // for anything genuinely has no figure. Printing 0% would invent capacity.
  assert.match(lines, /nothing is known about what it has spent yet/);
  assert.equal(/0%/.test(lines), false, "an unknown Utilization must never be shown as zero");
});

test("nothing claims a Seat is paying while any part of the mechanism is broken", async () => {
  const lines = statusLines({
    choice: { mode: "manual", payer: "work" },
    seats: [{ ...A_SEAT, hasSendToken: true }],
    usage: [],
    verdict: null,
    examination: BROKEN,
    windowRunning: true,
    backedUpOn: "2026-08-22",
    standing: null,
    at: NOON,
  }).join("\n");

  assert.match(lines, /Paying: not known, because the mechanism is not working/);
  assert.equal(/Paying: work/.test(lines), false, "it named a Payer it cannot possibly reach");
  assert.match(lines, /NO {2}the relay: nothing is listening/, "and it names the part that is broken");
  assert.equal(/ok {2}the service/.test(lines), false, "the parts that hold are for doctor, not for this");
});

test("Off says so plainly, and offers the way back to the Seat it remembers", async () => {
  const lines = statusLines({
    choice: { mode: "off", payer: "work" },
    seats: [{ ...A_SEAT, hasSendToken: true }],
    usage: [],
    verdict: null,
    examination: WORKING,
    windowRunning: true,
    backedUpOn: "2026-08-22",
    standing: null,
    at: NOON,
  }).join("\n");

  assert.match(lines, /Paying: the Window account/);
  assert.match(lines, /relay on/);
  assert.equal(/relay off/.test(lines), false, "offering to turn off what is already off is noise");
});

test("status exits non-zero when the mechanism is broken, so one word is also the health check", async () => {
  const bench = await aBench();
  try {
    const { machine } = aStandIn({ examine: async () => BROKEN });
    assert.notEqual(await bench.run(machine), 0);

    const working = aStandIn();
    assert.equal(await bench.run(working.machine), 0);
  } finally {
    await bench.forget();
  }
});

// ---- switching, live --------------------------------------------------------

test("off and back on is live, and needs nothing restarted", async () => {
  const bench = await aBench({ tokens: { work: "sk-ant-oat01-work" } });
  try {
    await bench.seats.add(A_SEAT, "sk-ant-oat01-work");
    const { machine } = aStandIn();

    assert.equal(await bench.run(machine, "use", "work"), 0);
    assert.match(bench.screen(), /takes effect on the next request, with nothing restarted/);

    assert.equal(await bench.run(machine, "off"), 0);
    assert.match(bench.screen(), /as if this were not installed/);

    assert.equal(await bench.run(machine, "on"), 0);
    // Off remembers the pick, so turning it back on needs no name typed again.
    assert.match(bench.screen(), /Paying: work/);
  } finally {
    await bench.forget();
  }
});

test("turning it on with nothing ever picked is refused, rather than choosing for the user", async () => {
  const bench = await aBench();
  try {
    // Choosing here would be Auto mode arriving by accident, three tickets early
    // and with no ranking rule behind it.
    assert.notEqual(await bench.run(aStandIn().machine, "on"), 0);
    assert.match(bench.everything(), /no Seat has been picked yet/);
    assert.match(bench.everything(), /relay use <seat>/);
  } finally {
    await bench.forget();
  }
});

test("switching to a Seat that cannot pay is refused with the reason, and the previous choice stands", async () => {
  const bench = await aBench();
  try {
    await bench.seats.add(A_SEAT, "sk-ant-oat01-work");
    // A second Seat listed with no Send token, which is what a Seat looks like
    // between being discovered and being filled.
    await bench.seats.add({ ...A_SEAT, name: "empty" }, "sk-ant-oat01-empty");
    await bench.seats.remove("empty");
    await bench.seats.update(A_SEAT);
    const { machine } = aStandIn();

    await bench.run(machine, "use", "work");
    const before = bench.said.length;

    assert.notEqual(await bench.run(machine, "use", "nobody"), 0);
    assert.match(bench.complained.join("\n"), /no Seat called "nobody"/);
    assert.equal(bench.said.length, before, "a refusal must not also report a success");

    // Proved from disk rather than from what was printed.
    const still = await runControl({
      argv: [],
      machine,
      home: bench.home,
      seats: bench.seats,
      usage: bench.usage,
      now: () => NOON,
      out: { say: (line) => bench.said.push(line ?? ""), complain: () => {} },
    });
    assert.equal(still, 0);
    assert.match(bench.screen(), /Paying: work/, "the previous choice did not stand");
  } finally {
    await bench.forget();
  }
});

test("a Seat with no Send token is refused as a Payer, and says what to do about it", async () => {
  const bench = await aBench();
  try {
    // Written straight to the file, which is exactly how a Seat arrives from a
    // Worklist that discovered it before it was filled.
    await bench.seats.add(A_SEAT, "sk-ant-oat01-work");
    const withoutToken = openSeatStore({ file: bench.home.seatsFile, vault: aVault() });

    const code = await runControl({
      argv: ["use", "work"],
      machine: aStandIn().machine,
      home: bench.home,
      seats: withoutToken,
      usage: bench.usage,
      now: () => NOON,
      out: { say: (line) => bench.said.push(line ?? ""), complain: (line) => bench.complained.push(line) },
    });

    assert.notEqual(code, 0);
    assert.match(bench.complained.join("\n"), /has no Send token/);
    assert.match(bench.complained.join("\n"), /The Payer has not been changed/);
  } finally {
    await bench.forget();
  }
});

// ---- every subcommand fails loudly ------------------------------------------

function anExchange(over: Partial<Exchange> = {}): Exchange {
  return {
    method: "POST",
    path: "/v1/messages",
    status: 200,
    refused: false,
    swapped: true,
    chargedTo: { seat: "work", organizationId: "org-acme" },
    paidBy: "org-acme",
    about: LIKE_CODE,
    utilization: { fiveHour: null, sevenDay: null },
    overage: { status: null, disabledReason: null },
    resets: { fiveHour: null, sevenDay: null },
    replyHeaders: {},
    ...over,
  };
}

test("the verdict carries its own exit code, so a mismatch fails a script", async () => {
  const bench = await aBench();
  try {
    const { machine } = aStandIn();
    const log = openVerdictLog({ file: bench.home.verdictFile });

    assert.notEqual(await bench.run(machine, "verdict"), 0, "nothing judged is not a success");

    await log.record(judge(anExchange()));
    assert.equal(await bench.run(machine, "verdict"), 0);
    assert.match(bench.screen(), /^verified: /m);

    await log.record(judge(anExchange({ paidBy: "org-somebody-else" })));
    assert.notEqual(await bench.run(machine, "verdict"), 0);
    assert.match(bench.screen(), /mismatch: /);
  } finally {
    await bench.forget();
  }
});

test("doctor names every part, the ones that hold as well, and fails when one does not", async () => {
  const bench = await aBench();
  try {
    assert.notEqual(await bench.run(aStandIn({ examine: async () => BROKEN }).machine, "doctor"), 0);
    assert.match(bench.screen(), /NO {2}the relay:/);
    assert.match(bench.screen(), /ok {2}the service:/, "doctor is the one place the good news belongs");
    assert.match(bench.complained.join("\n"), /nothing here can tell you which Seat is paying/);
  } finally {
    await bench.forget();
  }
});

test("a command that does not exist exits non-zero and prints everything that does", async () => {
  const bench = await aBench();
  try {
    assert.notEqual(await bench.run(aStandIn().machine, "explod"), 0);
    assert.match(bench.complained.join("\n"), /there is no "relay explod"/);
    assert.match(bench.screen(), /relay use <seat>/);
    assert.match(bench.screen(), /relay collect-seats/);
  } finally {
    await bench.forget();
  }
});

test("use with no Seat named is refused rather than treated as a request to list them", async () => {
  const bench = await aBench();
  try {
    assert.notEqual(await bench.run(aStandIn().machine, "use"), 0);
    assert.match(bench.complained.join("\n"), /which Seat\?/);
  } finally {
    await bench.forget();
  }
});

// ---- the one thing that cannot be rebuilt -----------------------------------

test("undoing refuses to forget Send tokens unless it was told to, and touches nothing", async () => {
  const bench = await aBench();
  try {
    await bench.seats.add(A_SEAT, "sk-ant-oat01-work");
    const { machine, asked } = aStandIn();

    const refused = await bench.run(machine, "uninstall");
    assert.notEqual(refused, 0, "it must not proceed");
    assert.match(bench.screen(), /STOP/);
    assert.match(bench.screen(), /back-up-seats/, "it has to say where the backup is taken");
    assert.match(bench.complained.join("\n"), /Nothing has been changed/);
    // The proof: the machine was never asked to do anything at all.
    assert.deepEqual(asked, [], "it said it changed nothing and then changed something");

    const meantIt = await bench.run(machine, "uninstall", "--and-forget-the-tokens");
    assert.equal(meantIt, 0);
    assert.deepEqual(asked, ["uninstall"]);
  } finally {
    await bench.forget();
  }
});

// ---- one door --------------------------------------------------------------

test("the long flows keep their own arguments, handed to their own process unchanged", async () => {
  const bench = await aBench();
  try {
    const { machine, asked } = aStandIn();

    assert.equal(await bench.run(machine, "collect-seats", "--list", "--no-check"), 0);
    assert.equal(await bench.run(machine, "back-up-seats", "--restore"), 0);
    assert.equal(await bench.run(machine, "serve", "9999"), 0);

    // Passed through rather than understood here. One door, and not one place
    // pretending to know four other command lines.
    assert.deepEqual(asked, [
      "collect-seats.ts --list --no-check",
      "back-up-seats.ts --restore",
      "serve.ts 9999",
    ]);
  } finally {
    await bench.forget();
  }
});

test("a flow that fails takes its exit code with it", async () => {
  const bench = await aBench();
  try {
    const { machine } = aStandIn({ handOffTo: async () => 7 });
    assert.equal(await bench.run(machine, "check"), 7, "a proof that failed must not read as a success");
  } finally {
    await bench.forget();
  }
});

test("every command in the list is either answered here or handed to a process that exists", async () => {
  const { COMMANDS } = await import("../src/control/index.ts");
  const bench = await aBench();
  try {
    for (const command of COMMANDS) {
      if (command.handsOff === undefined) continue;
      // A name in the table pointing at a script that is not there would only
      // show up the day somebody typed it.
      const { access } = await import("node:fs/promises");
      const script = join(import.meta.dirname, "..", "scripts", command.handsOff);
      await access(script);
    }
  } finally {
    await bench.forget();
  }
});

// ---- the two things the review caught --------------------------------------

/**
 * How long a window has left is counted from now, never from when it was read.
 *
 * A reading taken an hour ago whose window had two hours left has one hour left.
 * Saying two is how a Seat looks like capacity it no longer has, which is the
 * exact decision this screen exists to inform. Change `at` back to `readAt` in
 * `internal/room.ts` and this fails on the number.
 */
test("how long is left is counted from now, not from when the figure was read", async () => {
  const lines = statusLines({
    choice: { mode: "manual", payer: "work" },
    seats: [{ ...A_SEAT, hasSendToken: true }],
    usage: [
      {
        seat: "work",
        fiveHour: {
          utilization: 0.5,
          // Read an hour ago, when the window had two hours left.
          readAt: NOON - 3600,
          resetsAt: NOON + 3600,
          readVia: "exchange",
          ageSeconds: 3600,
          hasReset: false,
        },
        sevenDay: null,
        cooldowns: {},
      },
    ],
    verdict: null,
    examination: WORKING,
    windowRunning: true,
    backedUpOn: "2026-08-22",
    standing: null,
    at: NOON,
  }).join("\n");

  assert.match(lines, /resets in 1h/);
  assert.equal(/resets in 2h/.test(lines), false, "it counted from the reading rather than from now");
});

test("a Seat list that could not be read stops the undo, rather than reading as no tokens", async () => {
  const bench = await aBench();
  try {
    const { machine, asked } = aStandIn();
    // A vault that will not answer is what a locked Keychain looks like from
    // here, and it used to take the guard off at exactly the wrong moment.
    const unreadable = openSeatStore({
      file: bench.home.seatsFile,
      vault: {
        put: async () => {},
        get: async () => {
          throw new Error("the Keychain would not answer");
        },
        forget: async () => {},
      },
    });
    await bench.seats.add(A_SEAT, "sk-ant-oat01-work");

    const stopped = await runControl({
      argv: ["uninstall"],
      machine,
      home: bench.home,
      seats: unreadable,
      usage: bench.usage,
      now: () => NOON,
      out: { say: (line) => bench.said.push(line ?? ""), complain: (line) => bench.complained.push(line) },
    });

    assert.notEqual(stopped, 0);
    assert.match(bench.complained.join("\n"), /the Seats could not be read/);
    assert.match(bench.complained.join("\n"), /Nothing has been changed/);
    assert.deepEqual(asked, [], "it went ahead on a list it could not read");
  } finally {
    await bench.forget();
  }
});

test("a stale reading in the short list says how old it is; a fresh one does not", async () => {
  const stale = roomBrief(
    {
      seat: "work",
      fiveHour: { utilization: 0.5, resetsAt: null, readAt: NOON - 7200, readVia: "stats-login", ageSeconds: 7200, hasReset: false },
      sevenDay: null,
      cooldowns: {},
    },
    NOON,
  );
  assert.match(stale, /^s 50%  read 2h ago$/, "the window is named, the share is spent, the age is labelled");

  const fresh = roomBrief(
    {
      seat: "work",
      fiveHour: { utilization: 0.5, resetsAt: null, readAt: NOON - 30, readVia: "exchange", ageSeconds: 30, hasReset: false },
      sevenDay: null,
      cooldowns: {},
    },
    NOON,
  );
  assert.equal(fresh, "s 50%", "an age on every line of a full list is noise");
});

test("the brief says when each window comes back, counted from now rather than from the reading", () => {
  const brief = roomBrief(
    {
      seat: "work",
      fiveHour: { utilization: 0.08, resetsAt: NOON + 2 * 3600, readAt: NOON - 60, readVia: "exchange", ageSeconds: 60, hasReset: false },
      sevenDay: { utilization: 0.01, resetsAt: NOON + 6 * 86_400, readAt: NOON - 60, readVia: "exchange", ageSeconds: 60, hasReset: false },
      cooldowns: {},
    },
    NOON,
  );

  // The session first, because it is the window that stops work within the hour,
  // and then the week. One order in every surface: the three trays, both command
  // lines and the page.
  assert.match(brief, /^s 8% · in 2h/, `the session came out as "${brief}"`);
  assert.match(brief, /w 1% · in 6d/, `the week came out as "${brief}"`);
  assert.equal(/7d|5h/.test(brief), false, "a duration where a window's name belongs is what this replaced");
});

test("asking for help by flag gets help, not a status", async () => {
  const bench = await aBench();
  try {
    for (const flag of ["--help", "-h"]) {
      bench.said.length = 0;
      assert.equal(await bench.run(aStandIn().machine, flag), 0);
      assert.match(bench.screen(), /relay use <seat>/);
      assert.equal(/Mechanism:/.test(bench.screen()), false, `"${flag}" gave a status`);
    }
  } finally {
    await bench.forget();
  }
});

/**
 * The tests that were missing, and what that cost.
 *
 * On 2026-08-22 `relay prove --tear-down` called the undo directly, which called
 * "forget everything under our service name", which took every one of the user's
 * Send tokens. Each one is an interactive sign-in as its own account, there was no
 * backup, and there was nothing to recover. The refusal existed; it lived in the
 * surface, and that path went round it.
 *
 * The repair is not a better guard. Forgetting a Send token is now something only
 * the surface can do, and the `Machine` has no way to reach the Keychain at all,
 * so there is no second path to go round anything. These two pin the behaviour;
 * `test/no-wildcard-forget.test.ts` pins the absence.
 */
test("undoing forgets exactly the Seats this relay held, and says which", async () => {
  const bench = await aBench();
  try {
    await bench.seats.add(A_SEAT, "sk-ant-oat01-work");
    await bench.seats.add({ ...A_SEAT, name: "side" }, "sk-ant-oat01-side");

    assert.equal(await bench.run(aStandIn().machine, "uninstall", "--and-forget-the-tokens"), 0);
    assert.match(bench.screen(), /forgot 2 Send tokens: /);

    // Gone from the vault this test owns, which is the only claim worth making.
    assert.deepEqual(await bench.seats.list(), []);
  } finally {
    await bench.forget();
  }
});

test("an undo with no Seats of its own forgets no Send tokens at all", async () => {
  const bench = await aBench();
  try {
    // This is a Proving Window's relay: it borrows the Seats rather than owning
    // them, so its own store lists none and tearing it down must cost nothing.
    assert.equal(await bench.run(aStandIn().machine, "uninstall"), 0);
    assert.match(bench.screen(), /no Send tokens were held by this relay/);
  } finally {
    await bench.forget();
  }
});

test("Send tokens that are not backed up anywhere are said so, on the screen a person reads daily", async () => {
  // The rule to take a backup lived in a document, and on 2026-08-22 every Send
  // token was lost with nothing to restore from. A rule nobody is reminded of is
  // a wish, so the program is the thing that reminds.
  const lines = statusLines({
    choice: { mode: "manual", payer: "work" },
    seats: [{ ...A_SEAT, hasSendToken: true }],
    usage: [],
    verdict: null,
    examination: WORKING,
    windowRunning: true,
    backedUpOn: null,
    standing: null,
    at: NOON,
  }).join("\n");

  assert.match(lines, /1 Send tokens are held and none of them is backed up/);
  assert.match(lines, /relay back-up-seats/);
});

test("nothing is said about backups when there is nothing to lose", async () => {
  const lines = statusLines({
    choice: { mode: "off", payer: null },
    seats: [{ ...A_SEAT, hasSendToken: false }],
    usage: [],
    verdict: null,
    examination: WORKING,
    windowRunning: true,
    backedUpOn: null,
    standing: null,
    at: NOON,
  }).join("\n");

  assert.equal(/backed up/.test(lines), false, "a warning that is always on is noise");
});

test("the Seat list says when the tokens were last backed up, and when they never were", () => {
  const seats = [{ ...A_SEAT, hasSendToken: true }];
  assert.match(
    seatLines({ choice: { mode: "off", payer: null }, seats, usage: [], backedUpOn: null, at: NOON }).join("\n"),
    /None of the 1 Send tokens is backed up/,
  );
  assert.match(
    seatLines({ choice: { mode: "off", payer: null }, seats, usage: [], backedUpOn: "2026-08-20", at: NOON }).join("\n"),
    /last backed up 2026-08-20/,
  );
});

// ---- Auto, from the outside --------------------------------------------------

test("turning Auto on says what it will do, and keeps the pick it had", async () => {
  const bench = await aBench();
  try {
    await bench.seats.add(A_SEAT, "sk-ant-oat01-work");
    const { machine } = aStandIn();

    await bench.run(machine, "use", "work");
    assert.equal(await bench.run(machine, "auto"), 0);
    assert.match(bench.screen(), /weighed again on every request/);
    // A switch is in force at once, including inside conversations already
    // running. Saying what that costs is the difference between a surprise and a
    // decision, and it is said after the fact rather than made into a gate.
    assert.match(bench.screen(), /in force at once/);
    assert.match(bench.screen(), /re-cached/);

    // The pick survives, so `relay on` still has something to go back to.
    assert.deepEqual(await readChoice(bench.home.choiceFile), { mode: "auto", payer: "work" });
  } finally {
    await bench.forget();
  }
});

test("in Auto the status names the one Seat that is paying", () => {
  const lines = statusLines({
    choice: { mode: "auto", payer: null },
    seats: [{ ...A_SEAT, hasSendToken: true }, { ...A_SEAT, name: "side", hasSendToken: true }],
    usage: [
      {
        seat: "work",
        fiveHour: { utilization: 0.2, resetsAt: NOON + 1800, readAt: NOON, readVia: "exchange", ageSeconds: 0, hasReset: false },
        sevenDay: null,
        cooldowns: {},
      },
    ],
    verdict: null,
    examination: WORKING,
    windowRunning: true,
    backedUpOn: "2026-08-22",
    // One value for the machine. The Payer no longer waits for a conversation, so
    // there is one answer to "who is paying" rather than one per session.
    standing: { seat: "work", because: "it-had-the-most-room", at: NOON },
    at: NOON,
  }).join("\n");

  assert.match(lines, /Paying: whichever Seat has the most room/);
  assert.match(lines, /^ {2}work$/m);
  assert.match(lines, /20% spent/, "the room of the Seat actually paying, not of a Seat in general");
  assert.equal(/relay auto/.test(lines), false, "offering to turn on what is already on is noise");
});

test("in Auto with nothing asked yet, the status says so rather than naming a Seat", () => {
  const lines = statusLines({
    choice: { mode: "auto", payer: "work" },
    seats: [{ ...A_SEAT, hasSendToken: true }],
    usage: [],
    verdict: null,
    examination: WORKING,
    windowRunning: true,
    backedUpOn: "2026-08-22",
    standing: null,
    at: NOON,
  }).join("\n");

  // Naming the Seat that would probably win would be a claim about who is paying
  // for work nobody has started.
  assert.match(lines, /nothing has asked yet, so nothing has been chosen/);
  assert.equal(/Paying: work/.test(lines), false);
});
