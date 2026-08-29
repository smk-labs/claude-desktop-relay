/**
 * Put every Send token back, from a backup taken on the Mac.
 *
 *   relay-linux restore-seats [--from <file>]
 *
 * The passphrase is read from the terminal when there is one, and from standard
 * input when there is not, which is how it crosses an ssh connection without ever
 * being an argument or an environment variable that `ps` would show to the eight
 * other people on this machine.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { WHERE_BACKUPS_GO, isABackupName } from "../src/backup/index.ts";
import { openSeatStore } from "../src/seats/index.ts";
import { askSecretly, stopAsking } from "../src/ask/index.ts";
import { readBackup } from "../src/backup/index.ts";
import { fileVault } from "./internal/file-vault.ts";
import { linuxHome, vaultFile } from "./internal/where.ts";

const say = (line = "") => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`${line}\n`);

const argv = process.argv.slice(2);
const at = argv.indexOf("--from");
const asked = at === -1 ? null : (argv[at + 1] ?? null);

const home = linuxHome();
const seats = openSeatStore({ file: home.seatsFile, vault: fileVault(vaultFile(home)) });

/** The newest backup there is, not today's: a restore is rarely the same afternoon. */
async function newest(folder: string): Promise<string | null> {
  const found = (await readdir(folder).catch(() => [] as string[])).filter(isABackupName).sort();
  const last = found[found.length - 1];
  return last === undefined ? null : join(folder, last);
}

/** From the terminal when there is one, from standard input when there is not. */
async function passphrase(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdout.write(`Its passphrase (hidden): `);
    const answered = await askSecretly();
    say();
    return answered;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

let code = 1;
try {
  const file = asked ?? (await newest(WHERE_BACKUPS_GO));
  if (file === null) {
    complain(`There is no backup in ${WHERE_BACKUPS_GO}, and none was named with --from.`);
  } else {
    say(`Restoring from ${file}`);
    const backup = await readBackup({ file, passphrase: await passphrase() });
    say(`It holds ${backup.seats.length} Seats, taken ${backup.savedAt}.`);

    // One at a time, so an interruption leaves the Seats already put back rather
    // than an empty store.
    let put = 0;
    for (const seat of backup.seats) {
      const { sendToken, ...identity } = seat;
      await seats.add(identity, sendToken);
      put += 1;
      say(`  put back ${seat.name}`);
    }

    say();
    say(`${put} Seats are in ${vaultFile(home)}, readable only by you.`);
    say(`See them with:  relay-linux seats`);
    code = 0;
  }
} catch (error) {
  complain(error instanceof Error ? error.message : String(error));
} finally {
  stopAsking();
}

process.exitCode = code;
