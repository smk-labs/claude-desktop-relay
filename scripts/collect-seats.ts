/**
 * Fill every Seat you own with its own Send token, one sitting, one Seat at a
 * time, with nothing pasted by hand.
 *
 *   relay collect-seats
 *
 * It shows the whole Worklist before it asks for anything, names every Seat for
 * you, and then walks the missing ones in order. For each one it says which account
 * and which Organization are coming and which browser profile the link needs, runs
 * `claude setup-token` itself under a config folder of that Seat's own, opens the
 * link in the right profile, collects the token off that run, proves it against the
 * server, and puts it in the Keychain. You authorize the link. That is the whole of
 * your part.
 *
 * The token is proved before it is kept because `claude setup-token` binds to
 * whichever Organization was active in the browser, and a token for the right
 * account and the wrong Organization looks perfect from here.
 *
 * Stop whenever you like. Nothing is remembered between runs except which browser
 * profile each account uses: which Seats are filled is worked out from the Keychain
 * each time, so running it again picks up exactly where you left off.
 *
 * One Seat rather than all of them:
 *
 *   relay collect-seats <seat>
 *   relay add-seat <seat>            the same thing under the name people look for
 *
 * A Seat your Stats logins cannot see is added by putting it in the Worklist file
 * this prints the path of, then running this again. There is deliberately no way
 * to hand a Send token in by typing it: a token that was not minted here was not
 * proved here either.
 *
 *   --list                    show the Worklist and stop
 *   --only <seat>             the same as naming it, for when it reads better
 *   --fresh                   discover the Seats again, replacing the saved Worklist
 *   --logins <folder>         where the old Stats logins are
 *   --import-logins <folder>  read a folder of files holding a sessionKey, and keep them
 *   --no-check                do not Probe the Seats that are already filled
 *   --remint <seat>           fill a Seat that already has a working token
 *   --adopt <held>=<seat>     attach a Seat that was added before this flow existed
 */
import { appendFileSync, rmSync } from "node:fs";

import { askOutLoud, askSecretly, stopAsking } from "../src/ask/index.ts";
import { backUpEveryHeldSeat } from "../src/backup/index.ts";
import { relayHome } from "../src/home/index.ts";
import { readJsonFile, writeJsonFile } from "../src/json-file/index.ts";
import { readChoice, writeChoice } from "../src/payer/index.ts";
import { machineVault, openSeatStore, type ListedSeat, type Seat } from "../src/seats/index.ts";
import { probeSendToken, provesTheSeat, whereMintingHappens } from "../src/send-token/index.ts";
import {
  howItWent,
  walkTheWorklist,
  whatIsAboutToHappen,
  type Asking,
  type WhatASittingNeeds,
} from "../src/sitting/index.ts";
import {
  importStatsLogins,
  readAccounts,
  WHERE_STATS_LOGINS_ARE_KEPT,
  WHERE_THE_STATS_LOGINS_ARE,
} from "../src/stats-login/index.ts";
import { describeVerdict, type Verdict } from "../src/verify/index.ts";
import { buildWorklist, seatsFrom, type Dropped, type WorklistEntry } from "../src/worklist/index.ts";

const say = (line = "") => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`${line}\n`);

// ---- what was asked for -----------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
function valueOf(name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

const onlyList = flag("--list");
const fresh = flag("--fresh");
const check = !flag("--no-check");
const remint = valueOf("--remint");
const adopt = valueOf("--adopt");
/**
 * Every argument that is neither a flag nor a flag's value.
 *
 * Worked out rather than taken from the front, because a name sitting after a
 * flag was silently dropped: `relay add-seat --no-check some-seat` asked for one
 * Seat and started a sitting over all fifteen, with only the per-Seat question
 * between the user and an authorization on the wrong account.
 */
const TAKES_A_VALUE = ["--only", "--logins", "--import-logins", "--remint", "--adopt"];
const loose = argv.filter((word, at) => {
  if (word.startsWith("-")) return false;
  const before = argv[at - 1];
  return before === undefined || !TAKES_A_VALUE.includes(before);
});

/**
 * One Seat rather than all of them.
 *
 * A bare name counts, because `relay add-seat <seat>` is this same flow under the
 * name people look for and hands its arguments straight through. One flow for one
 * Seat and for a sitting that fills every one is the whole point: two would drift.
 */
const only = valueOf("--only") ?? loose[0] ?? null;
const loginsFolder = valueOf("--logins") ?? WHERE_THE_STATS_LOGINS_ARE;
const importLoginsFrom = valueOf("--import-logins");

if (loose.length > 1) {
  complain(`Only one Seat can be named at a time, and ${loose.length} were: ${loose.join(", ")}`);
  process.exit(1);
}

/**
 * Reading a folder of Stats logins and keeping them, which is a whole run of its
 * own.
 *
 * It exists because on Windows a Stats login cannot be read out of a profile that
 * is open, and the profiles are open almost always. Read only: nothing is written
 * back to that folder and nothing is removed from it. See ADR 0015 and
 * `src/stats-login/internal/kept.ts`.
 */
if (importLoginsFrom !== null) {
  const kept = await importStatsLogins(importLoginsFrom);
  if (kept.length === 0) {
    complain(`Nothing in ${importLoginsFrom} held a claude.ai session, so nothing was kept.`);
    process.exit(1);
  }
  say(`Kept ${kept.length} Stats logins: ${kept.map((one) => one.profile).join(", ")}`);
  say(`They are in ${WHERE_STATS_LOGINS_ARE_KEPT}, each one locked to this Windows account.`);
  say(`Now:  relay collect-seats --fresh`);
  process.exit(0);
}

/** Whether there is anybody at the keyboard to answer a question. */
const canAsk = process.stdin.isTTY === true;

const home = relayHome();
const seats = openSeatStore({ file: home.seatsFile, vault: machineVault() });

/** What the last mint said, for when one stops with nothing to show. */
const mintLog = `${home.folder}/mint.log`;

/**
 * Everything under here is throwaway state that `claude setup-token` wrote while
 * minting, and one of the things it wrote is a credential. So it goes on the way
 * out, and it goes on every way out.
 *
 * Registered on `exit` and done synchronously, which is the only kind of work
 * that runs there. A `finally` is not enough: pressing Ctrl-C ends the process
 * through a signal, the `finally` never runs, and what would be left behind is
 * the folder holding the token the user just minted. That is exactly the case
 * the ticket asks about, and it is the one a `finally` misses.
 */
process.on("exit", () => {
  rmSync(whereMintingHappens(home.folder), { recursive: true, force: true });
});

// ---- the Worklist -----------------------------------------------------------

/**
 * The Worklist as it was discovered.
 *
 * What was skipped is saved beside what was kept, so a resumed sitting still says
 * "these Organizations cannot pay" rather than going quiet about it from the
 * second run on. A user who cannot see what was left out cannot check the work.
 */
type Saved = {
  readonly discoveredAt: string;
  readonly seats: readonly Seat[];
  readonly dropped?: readonly Dropped[];
  readonly guessed?: readonly string[];
};

type Owned = { wanted: readonly Seat[]; dropped: readonly Dropped[]; guessed: readonly string[] };

/**
 * The Seats the user owns: from the saved Worklist when there is one, so an
 * edited file is honoured, and from their own logins when there is not.
 */
async function whatIsOwned(): Promise<Owned> {
  const saved = await readJsonFile<Saved>(home.worklistFile);

  if (!fresh && saved !== null && Array.isArray(saved.seats)) {
    say(`Worklist read from ${home.worklistFile}, as discovered ${saved.discoveredAt}.`);
    say(`Edit that file and run this again to change it, or pass --fresh to discover it anew.`);
    say();
    return { wanted: saved.seats, dropped: saved.dropped ?? [], guessed: saved.guessed ?? [] };
  }

  say(`Reading your own Stats logins in ${loginsFolder}...`);
  const read = await readAccounts({ folder: loginsFolder, alsoKept: true });
  const { wanted, dropped, guessed } = seatsFrom(read.accounts);

  for (const one of read.unread) complain(`  could not read the Stats login "${one.profile}": ${one.because}`);

  await writeJsonFile(home.worklistFile, {
    discoveredAt: new Date().toISOString(),
    seats: wanted,
    dropped,
    guessed,
  } satisfies Saved);
  say(`Found ${wanted.length} Seats across ${read.accounts.length} accounts. Worklist saved to ${home.worklistFile}.`);
  say();

  return { wanted, dropped, guessed };
}

// ---- showing it -------------------------------------------------------------

/** A screenful of these is read at once, so the columns line up or they cannot be scanned. */
const NAME = 30;
const WORTH = 6;
const STANDING = 9;
const ACCOUNT = 26;
const pad = (text: string, width: number) => text.padEnd(width);

/** One Seat as a line of the Worklist, in columns that line up. */
function row(seat: Seat, standing: string, note: string): string {
  return (
    `  ${pad(seat.name, NAME)}  ${pad(`${seat.multiplier}x`, WORTH)}  ${pad(standing, STANDING)}  ` +
    `${pad(seat.account, ACCOUNT)}  ${seat.organization.label}${note}`
  );
}

/**
 * What a filled Seat's Send token turned out to be worth, in words that claim no
 * more than the evidence.
 *
 * "refused" rather than "expired": the server declining a token and naming
 * nobody is consistent with an expired token, a revoked one and several other
 * things, and saying which would be a guess dressed as a fact.
 */
type Standing = "ready" | "wrong org" | "refused" | "not checked";

function standingFrom(verdict: Verdict): Standing {
  // A refusal that names this Seat's own Organization still proves the token, so
  // an out-of-allowance Seat reads as ready rather than as one to mint again.
  if (provesTheSeat(verdict)) return "ready";
  if (verdict.kind === "mismatch") return "wrong org";
  // Only an answer from the server demotes a Seat. A Probe that never went out
  // says nothing about the token, and treating that as a dead one would send the
  // user off to re-mint every working Seat because their network blinked.
  return verdict.refused ? "refused" : "not checked";
}

async function standingOf(entry: WorklistEntry): Promise<{ standing: Standing; verdict: Verdict | null }> {
  if (!check) return { standing: "not checked", verdict: null };
  const token = await seats.sendTokenFor(entry.seat.name).catch(() => null);
  if (token === null) return { standing: "refused", verdict: null };

  const verdict = await probeSendToken({ token, seat: entry.seat });
  return { standing: standingFrom(verdict), verdict };
}

// ---- adopting a Seat that predates this flow --------------------------------

/**
 * Attach a Send token that is already in the Keychain to the Seat it belongs to.
 *
 * A Send token proves which Organization it pays for and can say nothing about
 * which account minted it (ADR 0002), and five of this user's Seats sit in one
 * Organization, so which Seat a held token belongs to is the user's to say. The
 * Organization is still checked against the server before anything moves.
 */
async function adoptOne(held: string, into: WorklistEntry): Promise<boolean> {
  const token = await seats.sendTokenFor(held).catch((error: unknown) => {
    complain(`${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (token === null) return false;

  const verdict = await probeSendToken({ token, seat: into.seat });

  if (!provesTheSeat(verdict)) {
    complain(`Refused: ${describeVerdict(verdict)}`);
    complain(`Nothing was changed. The Seat "${held}" is still there, exactly as it was.`);
    return false;
  }

  // Added before the old one is removed, so an interruption between the two
  // leaves the token in the Keychain twice rather than not at all.
  await seats.add(into.seat, token);
  await seats.remove(held);

  const choice = await readChoice(home.choiceFile);
  if (choice.payer === held) {
    await writeChoice(home.choiceFile, { mode: choice.mode, payer: into.seat.name });
    say(`The Payer was "${held}", so it now names "${into.seat.name}". Nothing needs restarting.`);
  }

  say(`"${held}" is now the Seat "${into.seat.name}". ${describeVerdict(verdict)}`);
  return true;
}

/**
 * Work out which Seat a held token that predates this flow belongs to, and attach
 * it.
 *
 * The Probe settles the Organization, which is all the server can say. Which
 * account minted it is the one thing no credential can reveal (ADR 0002), and
 * several Seats here sit in the same Organization, so that half is asked rather
 * than guessed. Guessing it would name a working token after the wrong Seat, and
 * the Seat it was really for would then read as filled forever.
 */
async function settleStray(stray: ListedSeat, entries: readonly WorklistEntry[]): Promise<boolean> {
  say();
  say(`The Seat "${stray.name}" is held but is on no Worklist entry.`);

  const token = await seats.sendTokenFor(stray.name).catch(() => null);
  if (token === null) {
    say(`  It has no Send token, so there is nothing to attach. Remove it if you like.`);
    return false;
  }

  // Probed against the Organization the held Seat says it is in, so the answer
  // is a real Verdict on that Seat as it stands, and `paidBy` is what the
  // shortlist below is drawn from either way.
  const verdict = await probeSendToken({ token, seat: stray });
  if (verdict.paidBy === null) {
    say(`  Its token could not be proved: ${describeVerdict(verdict)}`);
    return false;
  }

  const candidates = entries.filter((entry) => entry.seat.organization.id === verdict.paidBy);
  say(`  The server says it pays for ${verdict.paidBy} (${candidates[0]?.seat.organization.label ?? "unknown"}).`);

  if (candidates.length === 0) {
    say(`  No Seat you own sits in that Organization, so it is nothing on this Worklist.`);
    return false;
  }

  if (onlyList || !canAsk) {
    say(`  ${candidates.length} of your Seats sit there. Attach it with:`);
    for (const one of candidates) {
      say(`    relay collect-seats --adopt ${stray.name}=${one.seat.name}`);
    }
    return false;
  }

  say(`  ${candidates.length} of your Seats sit there. A token cannot say which account minted it, so:`);
  for (const [at, one] of candidates.entries()) {
    say(`    ${at + 1}  ${pad(one.seat.name, NAME)}  ${one.seat.account}`);
  }
  process.stdout.write(`  Which one is it? Its number, or Enter to leave it alone: `);
  const picked = Number((await askOutLoud()).trim());

  const into = candidates[picked - 1];
  if (into === undefined) {
    say(`  Left alone.`);
    return false;
  }

  return adoptOne(stray.name, into);
}

// ---- what a person is asked -------------------------------------------------

async function yesTo(question: string): Promise<boolean> {
  process.stdout.write(`${question} [Enter to go on, or "s" to stop] `);
  const answered = (await askOutLoud()).trim().toLowerCase();
  return answered !== "s" && answered !== "stop" && answered !== "n" && answered !== "no";
}

const asking: Asking = {
  async readyFor(announcement) {
    if (!canAsk) return true;
    return yesTo(`   ${whatIsAboutToHappen(announcement)}. Ready?`);
  },

  async carryOn({ filledSoFar, leftToDo, theFirstOne }) {
    if (!canAsk) return true;
    say();
    if (theFirstOne) {
      say(`   That was the first one. The reading above is the check this flow was held up for:`);
      say(`   it says whether minting wrote to your own Claude Code login. Read it before going on.`);
    }
    return yesTo(`   ${filledSoFar} filled, ${leftToDo} to go. Carry on?`);
  },
};

// ---- backing up -------------------------------------------------------------

/**
 * A fresh backup after every Seat, under one passphrase asked once.
 *
 * After every Seat rather than at the end, because the Send tokens are the one
 * thing here that cannot be rebuilt and a sitting can stop at any moment. The
 * passphrase is held for this run only and never written anywhere.
 */
let passphrase: string | null = null;
let backingUpIsOff = false;

async function backUp(): Promise<{ kind: "backed-up"; file: string } | { kind: "not-backed-up"; because: string }> {
  if (backingUpIsOff) return { kind: "not-backed-up", because: "you chose not to back up this sitting" };

  if (passphrase === null) {
    if (!canAsk) return { kind: "not-backed-up", because: "nobody is at the keyboard to choose a passphrase" };
    say();
    say(`   A Send token exists now, so it gets backed up before anything else happens.`);
    process.stdout.write(`   Choose a passphrase for the backup (hidden, or Enter to skip): `);
    const chosen = (await askSecretly()).trim();
    say();
    if (chosen === "") {
      backingUpIsOff = true;
      return { kind: "not-backed-up", because: "no passphrase was given, so nothing was written" };
    }
    // Checked here rather than only where it is used. The archive refuses
    // anything under eight characters, and a short one that was held on to meant
    // every remaining Seat in the sitting failed to back up with no second
    // chance to type a longer one.
    if (chosen.length < 8) {
      return { kind: "not-backed-up", because: "that passphrase is under eight characters, so it was not kept" };
    }
    process.stdout.write(`   Type it again: `);
    const again = (await askSecretly()).trim();
    say();
    if (again !== chosen) return { kind: "not-backed-up", because: "those two did not match" };
    passphrase = chosen;
  }

  try {
    const taken = await backUpEveryHeldSeat({ seats, passphrase });
    return { kind: "backed-up", file: taken.file };
  } catch (error) {
    // Forgotten, so the next Seat asks again. A passphrase the archive would not
    // take must not be the one every remaining Seat is tried with.
    passphrase = null;
    return { kind: "not-backed-up", because: error instanceof Error ? error.message : String(error) };
  }
}

// ---- the sitting ------------------------------------------------------------

async function run(): Promise<number> {
  const { wanted, dropped, guessed } = await whatIsOwned();
  let worklist = buildWorklist({ wanted, held: await seats.list() });

  if (adopt !== null) {
    const [heldName, seatName] = adopt.split("=");
    const into = worklist.entries.find((entry) => entry.seat.name === seatName);
    if (heldName === undefined || into === undefined) {
      complain(`--adopt takes <held seat>=<worklist seat>, and both names have to exist.`);
      return 1;
    }
    return (await adoptOne(heldName, into)) ? 0 : 1;
  }

  for (const named of [remint, only]) {
    if (named !== null && !worklist.entries.some((entry) => entry.seat.name === named)) {
      complain(`There is no Seat called "${named}" on the Worklist.`);
      return 1;
    }
  }

  // Settled before anything is shown, so the Worklist below is the truth rather
  // than a picture taken a moment before it changed.
  let settledOne = false;
  for (const stray of worklist.strays) {
    if (await settleStray(stray, worklist.entries)) settledOne = true;
  }
  if (settledOne) {
    say();
    worklist = buildWorklist({ wanted, held: await seats.list() });
  }

  say();
  say(`Your Seats, worth the most first. ${worklist.entries.length} in all.`);
  say();

  const stillMissing: WorklistEntry[] = [];
  const wrong: WorklistEntry[] = [];

  for (const entry of worklist.entries) {
    const { seat } = entry;

    if (!entry.filled) {
      stillMissing.push(entry);
      say(row(seat, "missing", ""));
      continue;
    }

    const { standing, verdict } = await standingOf(entry);
    const note =
      verdict === null
        ? ""
        : verdict.paidBy === null
          ? `  the server answered ${verdict.status}`
          : `  the server says ${verdict.paidBy} pays`;
    say(row(seat, standing, note));

    // A Seat whose token the server refuses, or says pays for somebody else, is
    // broken, so it goes on the list to mint again whether or not it was named.
    // It used to be set aside instead, which meant the very command printed for
    // it, `--remint <that Seat>`, re-minted every other Seat and not that one.
    if (standing === "wrong org" || standing === "refused") {
      stillMissing.push(entry);
      if (standing === "wrong org") wrong.push(entry);
      continue;
    }

    // A working token is only replaced when it was asked for by name, so a second
    // pass over a sitting cannot quietly throw one away.
    if (remint === seat.name) stillMissing.push(entry);
  }

  say();
  if (dropped.length > 0) {
    const free = dropped.filter((one) => one.because === "free").length;
    say(`Skipped ${dropped.length} Organizations that cannot pay: ${free} free, ${dropped.length - free} API only.`);
  }
  if (guessed.length > 0) {
    say(
      `${guessed.length} Seats are shown as 1x because claude.ai named a plan this does not recognise, ` +
        `so that number is a guess and not a reading: ${guessed.join(", ")}`,
    );
  }
  for (const entry of wrong) {
    complain(
      `The Seat "${entry.seat.name}" holds a token that pays for a different Organization, ` +
        `so it is on the list below to mint again.`,
    );
  }

  say(`${worklist.entries.length - stillMissing.length} filled, ${stillMissing.length} to go.`);

  // One Seat and a whole sitting are the same flow, so this is a shorter list and
  // nothing else. Two flows for one job is how the two stop agreeing.
  const toDo = only === null ? stillMissing : stillMissing.filter((entry) => entry.seat.name === only);

  if (toDo.length === 0) {
    say(only === null ? `Nothing left to do. Choose who pays with:  relay use <seat>` : `"${only}" already has a working token. Use --remint to replace it.`);
    return 0;
  }
  if (onlyList) {
    say(`Run this again without --list to fill them.`);
    return 0;
  }

  say();
  say(`Now the missing ones, in order. Say "s" at any question to stop and keep what is done.`);

  const needs: WhatASittingNeeds = {
    seats,
    // Minting opens a real authorization in a browser, and nobody who is not
    // there can authorize one. A run with no terminal says what it would have
    // done and does none of it.
    somebodyIsAtTheKeyboard: canAsk,
    // Kept in a file rather than shown, because a mint that produced no token
    // leaves nothing to look at otherwise. Every token is already taken out of
    // these lines before they get here.
    watch: (line) => appendFileSync(mintLog, `${line}\n`, { mode: 0o600 }),
    under: home.folder,
    ask: asking,
    say,
    complain,
    backUp,
  };

  const report = await walkTheWorklist(needs, toDo);

  say();
  for (const line of howItWent(report)) say(line);
  return report.stoppedBecause === "the Claude Code login was written to" ? 1 : 0;
}

let code = 1;
try {
  code = await run();
} catch (error) {
  complain(`${error instanceof Error ? error.message : String(error)}`);
} finally {
  stopAsking();
}
process.exit(code);
