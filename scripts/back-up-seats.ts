/**
 * Keep a locked copy of every Seat's Send token, and put them back.
 *
 *   relay back-up-seats              take a backup
 *   relay back-up-seats --restore    put a backup back into this machine's secret store
 *   relay back-up-seats --to <file>  somewhere other than the usual place
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
 */
import { dirname, join } from "node:path";

import { backUpEveryHeldSeat, latestBackup, readBackup, WHERE_BACKUPS_GO } from "../src/backup/index.ts";
import { relayHome, whyThisHomeLooksEmpty } from "../src/home/index.ts";
import { machineVault, openSeatStore } from "../src/seats/index.ts";
import { askSecretly, stopAsking } from "../src/ask/index.ts";

const say = (line = "") => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`${line}\n`);

/** Where a backup goes by default. Named in `src/backup` and nowhere else. */
const USUAL_PLACE = WHERE_BACKUPS_GO;

const argv = process.argv.slice(2);
const restoring = argv.includes("--restore");
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

  const taken = await backUpEveryHeldSeat({ seats, passphrase, ...(asked === null ? {} : { file: asked }) });

  say();
  say(`Backed up ${taken.held} Seats to:`);
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

  say();
  say(`${put} Seats are back in this machine's secret store. Check them with:  relay collect-seats --list`);
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
