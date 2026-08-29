import { mkdir, rm } from "node:fs/promises";

import { browserProfiles, profilesWorthTrying, type BrowserProfile } from "../../browser/index.ts";
import { describeProof, readCliLogin, safeToCarryOn, whatItProves, type Proof } from "../../cli-login/index.ts";
import { mintOneToken, type MintOutcome } from "../../minting/index.ts";
import type { Seat, SeatStore } from "../../seats/index.ts";
import { mintFor, probeSendToken, provesTheSeat } from "../../send-token/index.ts";
import { describeVerdict, type Verdict } from "../../verify/index.ts";
import type { WorklistEntry } from "../../worklist/index.ts";
import { announcementInWords, type Announcement } from "./announce.ts";

/** How filling one Seat turned out. */
export type SeatOutcome =
  /** Minted, proved against the server, and in the Keychain. */
  | { readonly kind: "filled"; readonly verdict: Verdict; readonly proof: Proof }
  /** Minted and refused: the token pays for somebody else, so nothing was kept. */
  | { readonly kind: "refused"; readonly verdict: Verdict; readonly proof: Proof }
  /** No token came out of the mint at all. The reading is still carried. */
  | { readonly kind: "nothing-minted"; readonly because: string; readonly proof: Proof }
  /**
   * The `claude` command's own login was written to, which is the hazard this
   * whole flow was held up for. The sitting stops here, whatever else happened.
   */
  | { readonly kind: "the-cli-login-moved"; readonly proof: Proof; readonly keptTheToken: boolean }
  /** The person stopped, at the announcement or at a prompt. */
  | { readonly kind: "stopped" }
  /**
   * Nobody is at the keyboard, so nothing was run.
   *
   * Not a nicety. `claude setup-token` starts a real authorization against
   * whatever account the browser is signed into, and it cannot be undone by
   * stopping the process. A run with nobody there cannot authorize anything, so
   * all it can do is open a prompt in somebody's browser for no reason. This was
   * found the hard way: a test with piped stdin reached the real command.
   */
  | { readonly kind: "nobody-is-there" };

/** Everything a person is asked during a sitting, and nothing else. */
export type Asking = {
  /** Ready to start this Seat? False stops the sitting without minting. */
  readonly readyFor: (announcement: Announcement) => Promise<boolean>;
  /** Carry on to the next Seat? False ends the sitting with what is done kept. */
  readonly carryOn: (how: {
    filledSoFar: number;
    leftToDo: number;
    theFirstOne: boolean;
    proof: Proof;
  }) => Promise<boolean>;
};

/** What a sitting reaches for, all of it named so a test reaches for none of it. */
export type WhatASittingNeeds = {
  readonly seats: SeatStore;
  /**
   * Whether there is a person at the keyboard who can authorize a link.
   *
   * Required, and required on purpose. Every caller has to say so out loud,
   * because minting starts a real authorization in somebody's browser and a
   * caller that had not thought about it would default to doing that.
   */
  readonly somebodyIsAtTheKeyboard: boolean;
  /** The folder mint folders are made under. Ours, and removed on every way out. */
  readonly under: string;
  readonly ask: Asking;
  readonly say: (line?: string) => void;
  readonly complain: (line: string) => void;
  /**
   * Take a fresh backup, called after every Seat that gets filled.
   *
   * A sitting that fills Seats and does not back them up is the hole that cost
   * every Send token on this machine on 2026-08-22. So it happens after each one
   * rather than at
   * the end: a sitting can be stopped at any point, including by a crash, and the
   * one thing here that cannot be rebuilt must never be the thing that is only
   * saved later.
   */
  readonly backUp?: () => Promise<{ kind: "backed-up"; file: string } | { kind: "not-backed-up"; because: string }>;
  /**
   * Every line the child said, with any token already taken out.
   *
   * Not shown on screen: `claude` draws its banner, spinner and boxes with cursor
   * moves rather than spaces, so relayed it is a wall of run-together words. But a
   * run that stops with no token leaves nothing to look at without it, which is
   * exactly the position the first real sitting was in, so the caller keeps it.
   */
  readonly watch?: (line: string) => void;

  // The seams. Each has exactly one real implementation; the seam is for the test.
  readonly mint?: typeof mintOneToken;
  readonly probe?: typeof probeSendToken;
  readonly readTheCliLogin?: typeof readCliLogin;
  readonly readBrowserProfiles?: typeof browserProfiles;
};

/**
 * The Chrome profile this account most likely signs in on, by its name alone.
 *
 * A hint printed in the announcement and nothing else. `claude setup-token` opens
 * the link itself, in whichever profile the browser puts in front, so this is not
 * a control: it is there so the right window can be made ready before the link
 * appears. Nothing is asked and nothing is remembered, which is why a guess is
 * fine here where it would not be if it decided anything.
 */
export async function likelyProfileFor(
  needs: WhatASittingNeeds,
  account: string,
): Promise<BrowserProfile | null> {
  const profiles = await (needs.readBrowserProfiles ?? browserProfiles)({});
  return profilesWorthTrying({ account, profiles })[0] ?? null;
}

/**
 * Fill one Seat: announce it, mint it, check the CLI login did not move, prove the
 * token against the server, and keep it.
 *
 * The order is the point. The announcement comes before anything runs, so the
 * browser profile can be got ready. The CLI login is read before and after the
 * mint, so a run that wrote to the user's own login is seen rather than repeated
 * fifteen more times. And the token is proved before it is kept, because a token
 * for the right account and the wrong Organization looks perfect from here.
 */
export async function fillOneSeat(
  needs: WhatASittingNeeds,
  entry: WorklistEntry,
  position: string,
): Promise<SeatOutcome> {
  const { seat } = entry;
  const readLogin = needs.readTheCliLogin ?? readCliLogin;
  const mint = needs.mint ?? mintOneToken;
  const probe = needs.probe ?? probeSendToken;

  const profile = await likelyProfileFor(needs, seat.account);
  const announcement: Announcement = { seat, position, profile };

  needs.say();
  for (const line of announcementInWords(announcement)) needs.say(line);
  needs.say();

  if (!needs.somebodyIsAtTheKeyboard) {
    needs.complain(`   Nothing was run: minting opens a real authorization and needs somebody at the keyboard.`);
    return { kind: "nobody-is-there" };
  }

  if (!(await needs.ask.readyFor(announcement))) return { kind: "stopped" };

  const where = mintFor({ under: needs.under, seat: seat.name });
  await mkdir(where.folder, { recursive: true, mode: 0o700 });

  // Read before the mint, not before the sitting. A per-Seat reading is what makes
  // the answer about this mint rather than about the run as a whole.
  const before = await readLogin({});

  let minted: MintOutcome;
  try {
    minted = await mint({
      folder: where.folder,
      link: async (url) => {
        // `claude` has already opened this in whichever profile the browser put
        // in front. It is printed as well, because that is the only way back if
        // the wrong one took it.
        needs.say(`   Authorize it as ${seat.account}. If the wrong profile took it, open this there:`);
        needs.say();
        needs.say(`     ${url}`);
        needs.say();
      },
      ...(needs.watch === undefined ? {} : { heard: needs.watch }),
    });
  } finally {
    // Whatever happened, the folder holding whatever the mint wrote goes now.
    await rm(where.folder, { recursive: true, force: true });
  }

  const proof = whatItProves(before, await readLogin({}));

  // Said whichever way it went, because a proof nobody reads is not a proof. This
  // is the reading the ticket asked for on one Seat before a second one runs.
  needs.say(`   Your own Claude Code login: ${describeProof(proof)}`);

  // One guard for every way out from here, because there was a way out that
  // skipped it: a mint the person stopped returned before the check, so the
  // hazard the whole flow was gated on was dropped on exactly the path where the
  // reading had already been taken.
  const moved = !safeToCarryOn(proof);
  const theHazardFired = (keptTheToken: boolean): SeatOutcome => ({
    kind: "the-cli-login-moved",
    proof,
    keptTheToken,
  });

  if (minted.kind !== "minted") {
    if (moved) return theHazardFired(false);
    return { kind: "nothing-minted", because: minted.because, proof };
  }

  const verdict = await probe({ token: minted.token, seat });

  if (!provesTheSeat(verdict)) {
    if (verdict.kind === "mismatch") {
      needs.complain(
        `   Refused: that token pays for ${verdict.paidBy}, not ${seat.organization.id}. ` +
          `The Organization active in that browser was the wrong one.`,
      );
      needs.complain(`   Switch to "${seat.organization.label}" on claude.ai and run this Seat again.`);
    } else {
      needs.complain(`   Refused: ${describeVerdict(verdict)}`);
    }
    needs.complain(`   Nothing was stored.`);
    return moved ? theHazardFired(false) : { kind: "refused", verdict, proof };
  }

  // Kept even when the reading moved, and on purpose. The write to the user's own
  // login has already happened and throwing this away would not undo it, while
  // keeping it saves a sign-in that cannot be repeated cheaply. The sitting still
  // stops.
  await needs.seats.add(seat, minted.token);
  needs.say(`   Kept. ${describeVerdict(verdict)}`);
  if (verdict.refused) {
    needs.say(`   That Seat has no allowance left right now. The token is good; the Seat is spent.`);
  }

  await backUpNow(needs);

  return moved ? theHazardFired(true) : { kind: "filled", verdict, proof };
}

/** A fresh backup, and a loud complaint when there is not one. */
async function backUpNow(needs: WhatASittingNeeds): Promise<void> {
  if (needs.backUp === undefined) return;
  const backup = await needs.backUp();
  if (backup.kind === "backed-up") {
    needs.say(`   Backed up to ${backup.file}`);
    return;
  }
  needs.complain(`   NOT BACKED UP: ${backup.because}`);
  needs.complain(`   A Send token exists in the Keychain with no copy anywhere. Run:  relay back-up-seats`);
}
