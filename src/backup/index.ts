/**
 * A copy of every Seat's Send token, locked, kept off this machine's Keychain.
 *
 * This is the one place in this program that writes a Send token to a file, and
 * it is a deliberate exception rather than an oversight. Filling every Seat is an
 * hour of signing in and out of accounts by hand, and the Keychain entries that
 * hold the result can be removed by one wrong command. Losing them costs that
 * hour again; keeping a locked copy costs nothing.
 *
 * The archive is encrypted with a passphrase the user gives, is written so only
 * they can read it, and never lands inside this repository.
 */
export type { Backup, BackedUpSeat } from "./internal/archive.ts";
/**
 * Backing up every held Seat, and the note beside the archive.
 *
 * On the interface because two callers need exactly this and neither may have its
 * own version: the command a person runs, and the sitting, which takes one after
 * every Seat it fills.
 */
export type { Taken } from "./internal/everything.ts";
export { backUpEveryHeldSeat, theBackupNote } from "./internal/everything.ts";
export {
  latestBackup,
  readBackup,
  writeBackup,
  backupFileFor,
  isABackupName,
  WHERE_BACKUPS_GO,
} from "./internal/archive.ts";
