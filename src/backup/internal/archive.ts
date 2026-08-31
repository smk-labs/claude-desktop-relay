import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { Seat } from "../../seats/index.ts";
import { fileFromZip, zipOneFile } from "../../zip/index.ts";

/** One Seat with the credential that makes it able to pay. */
export type BackedUpSeat = Seat & { readonly sendToken: string };

/**
 * Where a backup goes, and the one place that says so.
 *
 * Beside the other credential backups this machine already keeps, and well
 * outside this repository, so no `git add .` can ever sweep one up.
 */
export const WHERE_BACKUPS_GO = join(homedir(), ".claude-legacy-backup", "send-tokens");

/**
 * What a backup is called, and the one place that decides.
 *
 * Both halves of this module used to name the file separately: the command wrote
 * `send-tokens-<date>.zip.enc` and the reader counted only names ending
 * `.backup`, so a real backup was invisible to the very warning that exists to
 * insist on one. Nobody would have found that out until after the hour of
 * signing in, because the only way to see it is to take a backup and be told you
 * have none.
 *
 * So the name lives here, once, and both halves ask. `.zip.enc` is still
 * recognised: it is what every backup taken before today is called, and a reader
 * that stopped seeing them would be repeating the same bug pointing the other
 * way.
 */
const ENDS_WITH = ".zip.enc";
const ALSO_RECOGNISED = [".backup"];

/** Where today's backup of `holding` should be written, inside `folder`. */
export function backupFileFor(on: Date, folder: string = WHERE_BACKUPS_GO): string {
  const day = on.toISOString().slice(0, 10);
  return join(folder, `send-tokens-${day}${ENDS_WITH}`);
}

/** Whether a file name is one of ours. Used by the reader, so the two agree. */
export function isABackupName(name: string): boolean {
  return name.endsWith(ENDS_WITH) || ALSO_RECOGNISED.some((end) => name.endsWith(end));
}

/**
 * The most recent backup, or null when there is none.
 *
 * Read by anything that is about to say "you have Send tokens": on 2026-08-22
 * every one of them was lost to one wrong command with no backup anywhere, and the
 * rule to take one lived in a document rather than in the program. Nothing here
 * opens the archive; the answer is only whether one exists and when.
 */
export async function latestBackup(folder: string = WHERE_BACKUPS_GO): Promise<{ file: string; on: string } | null> {
  const found = await readdir(folder).catch(() => [] as string[]);
  const archives = found.filter(isABackupName).sort();
  const newest = archives[archives.length - 1];
  if (newest === undefined) return null;

  const on = /(\d{4}-\d\d-\d\d)/.exec(newest)?.[1] ?? "an unknown day";
  return { file: join(folder, newest), on };
}

/** What a backup holds, and when it was taken. */
/** One Stats login in an archive: the profile it was read from, and the login. */
export type BackedUpStatsLogin = { readonly profile: string; readonly statsLogin: string };

export type Backup = {
  readonly savedAt: string;
  readonly seats: readonly BackedUpSeat[];
  /**
   * The Stats logins, and why they are optional.
   *
   * An archive written before this existed has no such field, and one written on
   * a machine where every profile was signed out has none to write. Neither is a
   * damaged archive, so the reader asks only for `seats` and treats this as empty
   * when it is not there. A Send token pays; a Stats login only reads. Losing the
   * second half of an archive costs the plan names and the idle usage on the new
   * machine, not the ability to pay.
   */
  readonly statsLogins?: readonly BackedUpStatsLogin[];
};

/** The name of the archive inside, and of the file inside that. */
const INSIDE = "seats-and-send-tokens.json";

/**
 * How the archive is locked, and every number in it.
 *
 * `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt`, byte for byte, done here
 * rather than by running that command. Three reasons, in order of weight. An
 * archive taken on one machine has to open on another, and doing it here is what
 * makes the two one thing rather than two implementations that happen to agree.
 * macOS ships `openssl`, `zip` and `unzip`; Windows ships none of the three, so a
 * backup command that shells out works on one machine and fails on the next. And
 * the passphrase never leaves this process now, where before it crossed a pipe.
 *
 * The iteration count is high on purpose: this is typed by hand a few times a
 * year, so a slow derivation costs the user nothing and costs anyone guessing a
 * great deal.
 *
 * The header is `openssl`'s own: the eight bytes `Salted__`, then the salt, then
 * the ciphertext. Key and initialisation vector are the first 48 bytes out of the
 * derivation, in that order. Proved against a real archive written by the macOS
 * side on 2026-08-25, which this opened and which opens what this writes.
 */
const ITERATIONS = 600_000;
const SALT_BYTES = 8;
const MAGIC = Buffer.from("Salted__", "utf8");

function keyAndIv(passphrase: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const both = pbkdf2Sync(passphrase, salt, ITERATIONS, 48, "sha256");
  return { key: both.subarray(0, 32), iv: both.subarray(32, 48) };
}

/** Lock these bytes under this passphrase, in the form `openssl enc` writes. */
export function lockArchive(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const { key, iv } = keyAndIv(passphrase, salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([MAGIC, salt, cipher.update(plain), cipher.final()]);
}

/**
 * Open them again.
 *
 * A wrong passphrase fails here rather than producing something that looks like
 * an answer: the padding almost never verifies, and whatever survives that is not
 * a zip and is refused by the reader.
 */
export function unlockArchive(locked: Buffer, passphrase: string): Buffer {
  if (!locked.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("that file does not begin the way a locked archive does, so it is not one of ours.");
  }
  const salt = locked.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const { key, iv } = keyAndIv(passphrase, salt);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(locked.subarray(MAGIC.length + SALT_BYTES)), decipher.final()]);
}

/**
 * Write every Seat and its Send token into one encrypted archive.
 *
 * This is the one place in this program that puts a Send token in a file, and it
 * is deliberate: filling a whole set of Seats is an hour of signing in and out that
 * nobody wants to repeat because a Keychain entry was removed by accident. The
 * archive is encrypted, is written owner-readable only, and never lands anywhere
 * inside this repository.
 */
export async function writeBackup(options: {
  file: string;
  passphrase: string;
  holding: readonly BackedUpSeat[];
  statsLogins?: readonly BackedUpStatsLogin[];
}): Promise<void> {
  if (options.passphrase.length < 8) {
    throw new Error("that passphrase is too short to be worth having. Use at least eight characters.");
  }
  if (options.holding.length === 0) {
    throw new Error("there are no Seats with Send tokens to back up, so nothing was written.");
  }

  await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });

  const backup: Backup = {
    savedAt: new Date().toISOString(),
    seats: options.holding,
    // Left out entirely when there are none, so an archive taken on a machine with
    // no readable profile is the same shape as one taken before this existed.
    ...(options.statsLogins && options.statsLogins.length > 0 ? { statsLogins: options.statsLogins } : {}),
  };
  const inside = Buffer.from(JSON.stringify(backup, null, 2) + "\n", "utf8");
  const locked = lockArchive(zipOneFile(INSIDE, inside), options.passphrase);

  /**
   * Written beside the real name and moved into place, never straight over it.
   *
   * Writing in place means the moment between opening the file and the last byte
   * is a moment in which the only copy of every Send token is half a file. A
   * sitting takes a fresh backup after every Seat, so that moment is entered once
   * per Seat filled, many times in an hour, and an interruption in any of them
   * would leave an
   * archive that still looks like one and cannot be opened.
   *
   * Owner only before it takes the real name, so it is never readable by anyone
   * else even for an instant. Windows has no such mode and quietly ignores it;
   * there the passphrase is the whole of the archive's protection, which is the
   * reason it has one.
   */
  const nearly = options.file + ".part";
  try {
    await writeFile(nearly, locked, { mode: 0o600 });
    await chmod(nearly, 0o600).catch(() => {});
    await rename(nearly, options.file);
  } catch (error) {
    await rm(nearly, { force: true });
    throw error;
  }
}

/**
 * Read a backup back, given its passphrase.
 *
 * A wrong passphrase fails here rather than producing something that looks like
 * an answer: what comes out of the cipher is not a zip, and the unzip refuses it.
 */
export async function readBackup(options: { file: string; passphrase: string }): Promise<Backup> {
  const locked = await readFile(options.file);

  let zipped: Buffer;
  try {
    zipped = unlockArchive(locked, options.passphrase);
  } catch {
    throw new Error(
      basename(options.file) +
        " would not open. The usual reason is the wrong passphrase; " +
        "there is no way to tell that from a damaged file, and no way to recover either.",
    );
  }

  let inside: Buffer;
  try {
    inside = fileFromZip(zipped, INSIDE);
  } catch {
    throw new Error(basename(options.file) + " opened but holds no archive, so the passphrase was wrong.");
  }

  const held = JSON.parse(inside.toString("utf8")) as Backup;
  if (!Array.isArray(held.seats)) throw new Error(basename(options.file) + " holds no Seats.");
  return held;
}
