import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { announcementInWords, fillOneSeat, howItWent, mayCarryOnLater, walkTheWorklist } from "../src/sitting/index.ts";
import type { BrowserProfile } from "../src/browser/index.ts";
import { A_TOKEN, anEntry, aSittingWhere, paidBySomebodyElse, verified } from "./helpers/a-sitting.ts";

const IN_THE_RIGHT_ONE: BrowserProfile = { directory: "Profile 41", label: "Z-Claude-bo", account: null };

// ---- what is said before anything runs -------------------------------------

test("a Seat is announced with its account, its Organization and the profile to have in front", () => {
  const lines = announcementInWords({
    seat: anEntry().seat,
    position: "3 of 15",
    profile: IN_THE_RIGHT_ONE,
  });

  assert.deepEqual(lines, [
    "-- 3 of 15 --  bo-acme-c3d4",
    "   Account          bo@example.com",
    "   Organization     Acme  (c3d4e5f6-0000-4000-8000-000000000003)",
    "   Chrome profile   Z-Claude-bo  (Profile 41)  <- have this one in front",
  ]);
});

test("no profile named says to put the right one in front yourself", () => {
  const lines = announcementInWords({ seat: anEntry().seat, position: "1 of 1", profile: null });
  assert.match(lines[3] ?? "", /put the right one in front yourself/);
});

// ---- filling one Seat ------------------------------------------------------

test("a Seat is minted, proved, kept and backed up, with the Send token never typed", async () => {
  const sitting = await aSittingWhere({ profiles: [IN_THE_RIGHT_ONE] });
  try {
    const outcome = await fillOneSeat(sitting.needs, anEntry(), "1 of 1");

    assert.equal(outcome.kind, "filled");
    assert.equal(await sitting.seats.sendTokenFor("bo-acme-c3d4"), A_TOKEN);
    assert.deepEqual(sitting.it.probed, [{ token: A_TOKEN, seat: "bo-acme-c3d4" }]);
    assert.equal(sitting.it.backups, 1);
    // Read before the mint and after it. Two readings or it proves nothing.
    assert.equal(sitting.it.cliLoginReads, 2);
    // The link is printed as a way back, never opened by us: `claude` opens it.
    assert.match(sitting.it.said.join("\n"), /https:\/\/claude\.ai\/oauth\/authorize/);
  } finally {
    await sitting.away();
  }
});

test("the token never appears in anything said to the person", async () => {
  const sitting = await aSittingWhere({ profiles: [IN_THE_RIGHT_ONE] });
  try {
    await fillOneSeat(sitting.needs, anEntry(), "1 of 1");
    for (const line of [...sitting.it.said, ...sitting.it.complaints]) {
      assert.ok(!line.includes(A_TOKEN), `the token was said: ${line}`);
    }
  } finally {
    await sitting.away();
  }
});

test("the mint folder is removed, whatever came of the mint", async () => {
  for (const mint of [
    async () => ({ kind: "minted", token: A_TOKEN }) as const,
    async () => ({ kind: "nothing", because: "it said nothing" }) as const,
    async () => {
      throw new Error("the terminal fell over");
    },
  ]) {
    const sitting = await aSittingWhere({ mint });
    try {
      await fillOneSeat(sitting.needs, anEntry(), "1 of 1").catch(() => null);
      const folder = sitting.it.mintedIn[0];
      assert.ok(folder !== undefined);
      assert.equal(existsSync(folder), false, `${folder} was left behind`);
    } finally {
      await sitting.away();
    }
  }
});


/**
 * The likeliest mistake in a sitting, and the one the Probe exists for. A token
 * for the right account and the wrong Organization looks perfect from here.
 */
test("a token that pays for another Organization is refused and never stored", async () => {
  const sitting = await aSittingWhere({ probe: async () => paidBySomebodyElse });
  try {
    const outcome = await fillOneSeat(sitting.needs, anEntry(), "1 of 1");

    assert.equal(outcome.kind, "refused");
    await assert.rejects(sitting.seats.sendTokenFor("bo-acme-c3d4"));
    assert.equal(sitting.it.backups, 0);
    assert.match(sitting.it.complaints.join("\n"), /pays for eeeeeeee-0000-0000-0000-000000000000/);
  } finally {
    await sitting.away();
  }
});

test("a Seat that has no allowance left is still kept, and said to be spent", async () => {
  const spent = { ...verified, refused: true, because: "the-answer-was-not-a-success" as const };
  const sitting = await aSittingWhere({ probe: async () => spent });
  try {
    const outcome = await fillOneSeat(sitting.needs, anEntry(), "1 of 1");
    assert.equal(outcome.kind, "filled");
    assert.match(sitting.it.said.join("\n"), /The token is good; the Seat is spent/);
  } finally {
    await sitting.away();
  }
});

test("saying no at the announcement mints nothing at all", async () => {
  const sitting = await aSittingWhere({ readyFor: async () => false });
  try {
    assert.deepEqual(await fillOneSeat(sitting.needs, anEntry(), "1 of 1"), { kind: "stopped" });
    assert.deepEqual(sitting.it.mintedIn, []);
    assert.equal(sitting.it.cliLoginReads, 0);
  } finally {
    await sitting.away();
  }
});

test("a backup that did not happen is complained about loudly, not noted", async () => {
  const sitting = await aSittingWhere({
    backUp: async () => ({ kind: "not-backed-up", because: "the passphrases did not match" }),
  });
  try {
    await fillOneSeat(sitting.needs, anEntry(), "1 of 1");
    assert.match(sitting.it.complaints.join("\n"), /NOT BACKED UP: the passphrases did not match/);
    assert.match(sitting.it.complaints.join("\n"), /relay back-up-seats/);
  } finally {
    await sitting.away();
  }
});

// ---- the hazard ------------------------------------------------------------

/**
 * The reason this ticket was held up. `CLAUDE_CONFIG_DIR` moves every file the
 * command writes and does not move the one Keychain entry it keeps its own login
 * in, so a mint that writes there replaces the user's own login. Fifteen more
 * mints would do it fifteen more times.
 */
test("a mint that wrote to the Claude Code login stops the sitting dead", async () => {
  const sitting = await aSittingWhere({
    cliLogin: (reads) => ({ kind: "held", lastChanged: reads === 1 ? "20260822031527Z" : "20260823101500Z" }),
  });
  try {
    const report = await walkTheWorklist(sitting.needs, [
      anEntry(),
      anEntry({ name: "ivy-acme-1111", account: "ivy@example.com" }),
    ]);

    assert.deepEqual(report.filled, ["bo-acme-c3d4"]);
    assert.equal(report.stoppedBecause, "the Claude Code login was written to");
    // The second Seat was never touched.
    assert.equal(sitting.it.mintedIn.length, 1);
    assert.deepEqual(report.left, ["ivy-acme-1111"]);
    assert.equal(mayCarryOnLater(report), false);
    assert.match(sitting.it.complaints.join("\n"), /CLAUDE_CONFIG_DIR does not namespace it/);
  } finally {
    await sitting.away();
  }
});

/**
 * The token cost an interactive sign-in and throwing it away would not undo the
 * write. So it is kept and the sitting still stops.
 */
test("a token minted while the login moved is still kept, and the sitting still stops", async () => {
  const sitting = await aSittingWhere({
    cliLogin: (reads) => (reads === 1 ? { kind: "none" } : { kind: "held", lastChanged: "20260823101500Z" }),
  });
  try {
    const outcome = await fillOneSeat(sitting.needs, anEntry(), "1 of 1");
    assert.equal(outcome.kind, "the-cli-login-moved");
    assert.equal(outcome.kind === "the-cli-login-moved" && outcome.keptTheToken, true);
    assert.equal(await sitting.seats.sendTokenFor("bo-acme-c3d4"), A_TOKEN);
  } finally {
    await sitting.away();
  }
});

/**
 * Two failed readings are the same answer and would compare equal, so a flow that
 * treated silence as safety would wave a whole sitting through having proved
 * nothing. This is the case that has to fail closed.
 */
test("a login that could not be read at all stops the sitting too", async () => {
  const sitting = await aSittingWhere({
    cliLogin: () => ({ kind: "unreadable", because: "User interaction is not allowed." }),
  });
  try {
    const report = await walkTheWorklist(sitting.needs, [anEntry(), anEntry({ name: "second-1111" })]);
    assert.equal(report.stoppedBecause, "the Claude Code login was written to");
    assert.equal(sitting.it.mintedIn.length, 1);
  } finally {
    await sitting.away();
  }
});

// ---- the walk --------------------------------------------------------------

test("one flow, whether the list is one Seat or three, and it advances only on a yes", async () => {
  const asked: { theFirstOne: boolean; leftToDo: number }[] = [];
  const sitting = await aSittingWhere({
    carryOn: async (how) => {
      asked.push({ theFirstOne: how.theFirstOne, leftToDo: how.leftToDo });
      return true;
    },
  });
  try {
    const three = [anEntry(), anEntry({ name: "two-2222" }), anEntry({ name: "three-3333" })];
    const report = await walkTheWorklist(sitting.needs, three);

    assert.deepEqual(report.filled, ["bo-acme-c3d4", "two-2222", "three-3333"]);
    assert.deepEqual(report.left, []);
    assert.equal(report.stoppedBecause, null);
    // Asked after the first and the second, never after the last.
    assert.deepEqual(asked, [
      { theFirstOne: true, leftToDo: 2 },
      { theFirstOne: false, leftToDo: 1 },
    ]);
    assert.equal(sitting.it.backups, 3);
  } finally {
    await sitting.away();
  }
});

test("a sitting stopped after one Seat keeps that one and names the rest", async () => {
  const sitting = await aSittingWhere({ carryOn: async () => false });
  try {
    const report = await walkTheWorklist(sitting.needs, [anEntry(), anEntry({ name: "two-2222" })]);

    assert.deepEqual(report.filled, ["bo-acme-c3d4"]);
    assert.deepEqual(report.left, ["two-2222"]);
    assert.equal(report.stoppedBecause, "you stopped it");
    assert.equal(mayCarryOnLater(report), true);
    assert.match(howItWent(report).join("\n"), /Run this again to carry on/);
  } finally {
    await sitting.away();
  }
});

test("a Seat that was refused is still missing, rather than dropped because it was reached", async () => {
  const sitting = await aSittingWhere({
    probe: async (_token, seat) => (seat.name === "two-2222" ? paidBySomebodyElse : verified),
  });
  try {
    const report = await walkTheWorklist(sitting.needs, [anEntry(), anEntry({ name: "two-2222" })]);
    assert.deepEqual(report.filled, ["bo-acme-c3d4"]);
    assert.deepEqual(report.left, ["two-2222"]);
  } finally {
    await sitting.away();
  }
});




/**
 * The guard that had to exist, and it is required rather than optional so no
 * future caller can forget it. Minting starts a real authorization against
 * whatever account the browser is signed into, and stopping the process does not
 * take it back, so a run with nobody there must do none of it.
 */
test("with nobody at the keyboard nothing is minted, and the sitting stops after one", async () => {
  const sitting = await aSittingWhere({ somebodyIsAtTheKeyboard: false });
  try {
    const report = await walkTheWorklist(sitting.needs, [anEntry(), anEntry({ name: "two-2222" })]);

    assert.deepEqual(sitting.it.mintedIn, []);
    assert.equal(sitting.it.cliLoginReads, 0);
    assert.deepEqual(report.filled, []);
    assert.equal(report.stoppedBecause, "nobody is at the keyboard");
    // Still announced, because which account was coming is worth reading.
    assert.match(sitting.it.said.join("\n"), /bo@example\.com/);
  } finally {
    await sitting.away();
  }
});


test("a mint that produced nothing while the login moved stops the sitting too", async () => {
  const sitting = await aSittingWhere({
    mint: async () => ({ kind: "nothing", because: "it could not reach the authorization server" }),
    cliLogin: (reads) => (reads === 1 ? { kind: "held", lastChanged: "20260822031527Z" } : { kind: "none" }),
  });
  try {
    const report = await walkTheWorklist(sitting.needs, [anEntry(), anEntry({ name: "two-2222" })]);
    assert.equal(report.stoppedBecause, "the Claude Code login was written to");
    assert.equal(sitting.it.mintedIn.length, 1);
  } finally {
    await sitting.away();
  }
});

/**
 * The reading is carried rather than invented. A "could not be read" where the
 * reading was in fact taken twice and was untouched is a claim about the hazard
 * pointing the wrong way, and a page that showed it would frighten somebody for
 * no reason.
 */
test("a Seat that minted nothing hands on the reading it actually took", async () => {
  let handed: string | null = null;
  const sitting = await aSittingWhere({
    mint: async () => ({ kind: "nothing", because: "it said nothing at all" }),
    carryOn: async (how) => {
      handed = how.proof.kind;
      return false;
    },
  });
  try {
    await walkTheWorklist(sitting.needs, [anEntry(), anEntry({ name: "two-2222" })]);
    assert.equal(handed, "untouched");
  } finally {
    await sitting.away();
  }
});

/**
 * A hint and nothing more. `claude setup-token` opens the link itself, in whichever
 * profile the browser puts in front, so this says which one that should be rather
 * than deciding it. Nothing is asked and nothing is remembered.
 */
test("the Chrome profile to have in front is named, from its own name", async () => {
  const sitting = await aSittingWhere({ profiles: [IN_THE_RIGHT_ONE, { directory: "Default", label: "000 Personal", account: "someone@example.org" }] });
  try {
    await fillOneSeat(sitting.needs, anEntry(), "1 of 1");
    assert.match(sitting.it.said.join("\n"), /Chrome profile   Z-Claude-bo {2}\(Profile 41\) {2}<- have this one in front/);
  } finally {
    await sitting.away();
  }
});

test("no profiles readable says so rather than naming one", async () => {
  const sitting = await aSittingWhere({ profiles: [] });
  try {
    await fillOneSeat(sitting.needs, anEntry(), "1 of 1");
    assert.match(sitting.it.said.join("\n"), /put the right one in front yourself/);
  } finally {
    await sitting.away();
  }
});
