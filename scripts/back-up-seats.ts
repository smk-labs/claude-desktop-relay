/**
 * Keep a locked copy of every Seat's Send token, and put them back.
 *
 *   relay back-up-seats              take a backup
 *   relay back-up-seats --restore    put a backup back into this machine's secret store
 *   relay back-up-seats --to <file>  somewhere other than the usual place
 *   relay back-up-seats --no-logins  the Send tokens only, without the Stats logins
 *
 * Why this exists. The Send tokens are in the machine's own secret store and in
 * no file of ours: the Keychain on macOS, `CryptProtectData` on Windows. That is
 * right, because a credential in a plain file is one anybody can read. But it
 * also means one wrong command removes an hour of signing in and out of every
 * account by hand, with nothing to fall back on. So this writes them to one
 * encrypted archive, under a passphrase you choose, outside this repository.
 *
 * Run it again after every sitting that fills a Seat. A backup that is missing
 * the Seats filled since is most of a backup.
 *
 * It carries the Stats logins as well, and that is what makes an archive enough
 * to move to another machine. A Send token pays and can say nothing about a plan;
 * the plan names, the Multipliers and an idle Seat's usage are all read from a
 * claude.ai session, and those sessions live in Claude Desktop profiles that do
 * not travel. Without them a restored machine pays correctly and shows a screen
 * full of "not known".
 *
 * They are a credential, so they are in the same encrypted archive under the same
 * passphrase, never beside it.
 */
import { dirname, join } from "node:path";

import { backUpEveryHeldSeat, latestBackup, readBackup, WHERE_BACKUPS_GO } from "../src/backup/index.ts";
import { relayHome, THE_USERS_DESKTOP_FOLDER, whyThisHomeLooksEmpty } from "../src/home/index.ts";
import { findProfiles } from "../src/profiles/index.ts";
import { machineVault, openSeatStore } from "../src/seats/index.ts";
import { keepStatsLogins, statsLoginsToBackUp, WHERE_THE_STATS_LOGINS_ARE } from "../src/stats-login/index.ts";
import { askSecretly, stopAsking } from "../src/ask/index.ts";

const say = (line = "") => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`${line}\n`);

/** Where a backup goes by default. Named in `src/backup` and nowhere else. */
const USUAL_PLACE = WHERE_BACKUPS_GO;

const argv = process.argv.slice(2);
const restoring = argv.includes("--restore");
const withoutLogins = argv.includes("--no-logins");
const at = argv.indexOf("--to");
const asked = at === -1 ? null : (argv[at + 1] ?? null);

const home = relayHome();
const seats = openSeatStore({ file: home.seatsFile, vault: machineVault() });

async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const answered = await askSecretly();
  say();
  return answered;
}

/**
 * Every profile whose Stats login is worth carrying.
 *
 * The same three sources `collect-seats` reads, asked in the same order: the
 * snapshot folder, and every Claude Desktop profile on this machine that somebody
 * has signed in to. A folder that is not there contributes nothing rather than
 * throwing, because a machine that never had the snapshot folder still has its
 * Windows.
 */
async function whereTheLoginsAre(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const snapshot = await readdir(WHERE_THE_STATS_LOGINS_ARE, { withFileTypes: true }).catch(() => []);
  const found = await findProfiles({ port: home.port }).catch(() => []);

  return [
    ...snapshot.filter((one) => one.isDirectory()).map((one) => join(WHERE_THE_STATS_LOGINS_ARE, one.name)),
    THE_USERS_DESKTOP_FOLDER,
    home.appSupport,
    ...found.filter((one) => one.signedIn).map((one) => one.folder),
  ].filter((one, which, all) => all.indexOf(one) === which);
}

async function takeOne(): Promise<number> {
  const listed = await seats.list();
  const withTokens = listed.filter((seat) => seat.hasSendToken);

  if (withTokens.length === 0) {
    const empty = whyThisHomeLooksEmpty(home);
    complain(`No Seat in ${home.folder} has a Send token, so there is nothing to back up.`);
    if (empty !== null) complain(empty);
    else complain(`Fill some first with:  relay collect-seats`);
    return 1;
  }

  say(`${withTokens.length} Seats have a Send token. Backing up all of them.`);
  if (withTokens.length < listed.length) {
    say(`${listed.length - withTokens.length} more are on the list with no token yet, and are not in this backup.`);
  }
  say();

  const passphrase = await ask(`Choose a passphrase for the backup (hidden): `);
  const again = await ask(`Type it again: `);
  if (passphrase !== again) {
    complain(`Those did not match, so nothing was written.`);
    return 1;
  }

  const read = withoutLogins ? { logins: [], unread: [] } : await statsLoginsToBackUp(await whereTheLoginsAre());
  if (!withoutLogins) {
    say(`${read.logins.length} Stats logins can be read on this machine, and go in the same archive.`);
    // Named rather than counted. A profile that is signed out is the ordinary
    // case and not worth a line each, but the person taking a backup to another
    // machine is exactly the person who wants to know which account will arrive
    // without its plan.
    for (const one of read.unread) say(`  no login in ${one.profile}: ${one.because}`);
    say();
  }

  const taken = await backUpEveryHeldSeat({
    seats,
    passphrase,
    ...(asked === null ? {} : { file: asked }),
    ...(read.logins.length > 0 ? { statsLogins: read.logins } : {}),
  });

  say();
  say(`Backed up ${taken.held} Seats and ${taken.statsLogins} Stats logins to:`);
  say(`  ${taken.file}`);
  say(`The rule against deleting it, and how to put it back, is beside it in:`);
  say(`  ${join(dirname(taken.file), "READ-ME-FIRST.md")}`);
  say();
  say(`Keep that passphrase somewhere you will find it. Nothing here can recover it,`);
  say(`and without it the backup is a file of noise.`);
  return 0;
}

async function putOneBack(): Promise<number> {
  /**
   * The newest backup there is, not today's.
   *
   * Defaulting to today's name meant a restore only worked on the day the backup
   * was taken, which is every day except the one you need it. A restore is wanted
   * after something went wrong, and that is rarely the same afternoon.
   */
  const newest = asked === null ? await latestBackup(USUAL_PLACE) : null;
  const file = asked ?? newest?.file ?? null;
  if (file === null) {
    complain(`There is no backup in ${USUAL_PLACE}, and none was named with --to.`);
    return 1;
  }
  say(`Restoring from ${file}`);

  const passphrase = await ask(`Its passphrase (hidden): `);
  const backup = await readBackup({ file, passphrase });

  say(`It holds ${backup.seats.length} Seats, taken ${backup.savedAt}.`);

  // Written one at a time rather than all at once, so an interruption leaves the
  // Seats already put back in place rather than an empty store.
  let put = 0;
  for (const seat of backup.seats) {
    const { sendToken, ...identity } = seat;
    await seats.add(identity, sendToken);
    put += 1;
    say(`  put back ${seat.name}`);
  }

  /**
   * The Stats logins, into the store this machine keeps them in.
   *
   * After the Seats on purpose. The Seats are what pays and the logins only read,
   * so an interruption between the two leaves a machine that works and reports
   * less, never one that reports well and cannot pay.
   */
  let logins = 0;
  if (backup.statsLogins !== undefined && backup.statsLogins.length > 0) {
    logins = await keepStatsLogins(backup.statsLogins);
    say(`  put back ${logins} Stats logins`);
  }

  say();
  say(`${put} Seats are back in this machine's secret store. Check them with:  relay collect-seats --list`);
  if (logins === 0 && (backup.statsLogins?.length ?? 0) === 0) {
    say();
    say(`This archive carries no Stats logins, so plans and idle usage will read "not known"`);
    say(`until an account is signed in to on this machine. Take a fresh backup with a newer`);
    say(`version to carry them.`);
  }
  return 0;
}

let code = 1;
try {
  code = restoring ? await putOneBack() : await takeOne();
} catch (error) {
  complain(`${error instanceof Error ? error.message : String(error)}`);
} finally {
  stopAsking();
}
process.exit(code);
