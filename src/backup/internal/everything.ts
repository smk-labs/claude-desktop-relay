import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SeatStore } from "../../seats/index.ts";
import { backupFileFor, WHERE_BACKUPS_GO, writeBackup, type BackedUpSeat } from "./archive.ts";

/**
 * The plain note that sits beside the archive.
 *
 * Outside the encryption on purpose. A rule nobody can read until they have
 * already solved the problem is not a rule, and the person who finds this folder
 * may be looking at it precisely because the Keychain entries have gone.
 */
export function theBackupNote(file: string): string {
  return `# The Send tokens for claude-desktop-relay

Do not delete anything in this folder.

## What is here

\`${file.split("/").pop()}\` is an encrypted copy of every Seat's Send token: the
credentials that let each of your Claude accounts pay for Claude Code sessions.
Each one took a sign-in by hand and each one lasts about a year. They are locked
with a passphrase you chose. Nobody can read them without it, and nobody can
recover them if you forget it.

## Where the real ones live

In this Mac's Keychain, under the service name \`claude-desktop-relay\`, one entry
per Seat. Not in any file. \`~/.claude-desktop-relay/seats.json\` lists the Seats
but deliberately holds no credential, so backing that folder up saves nothing.

## If they are gone

They are removed by \`relay uninstall\`, by deleting the Keychain entries
by hand, or by a Keychain reset. Put them back with:

    relay back-up-seats --restore

from the claude-desktop-relay repository. It asks for the passphrase, then writes
every Seat and its token back into the Keychain.

## Keeping it current

Take a fresh backup after every sitting that fills a Seat:

    relay back-up-seats
`;
}

/** What a backup came to: where it went, and how many Seats it holds. */
export type Taken = { readonly file: string; readonly held: number; readonly withoutATokenYet: number };

/**
 * Back up every Seat that holds a Send token, and leave the note beside it.
 *
 * One implementation, because two callers need it: the command a person runs by
 * hand, and the sitting, which takes one after every Seat it fills. A sitting that
 * fills Seats and does not back them up is the hole that cost every Send token on
 * this machine on 2026-08-22, so the sitting must be able to do this itself rather
 * than print a
 * reminder and hope.
 */
export async function backUpEveryHeldSeat(options: {
  seats: SeatStore;
  passphrase: string;
  /** Where it goes. Named by this module, so writer and reader cannot drift. */
  file?: string;
  folder?: string;
  on?: Date;
}): Promise<Taken> {
  const listed = await options.seats.list();
  const withTokens = listed.filter((seat) => seat.hasSendToken);
  if (withTokens.length === 0) throw new Error("no Seat has a Send token yet, so there is nothing to back up");

  const holding: BackedUpSeat[] = [];
  for (const seat of withTokens) {
    holding.push({
      name: seat.name,
      account: seat.account,
      organization: seat.organization,
      multiplier: seat.multiplier,
      sendToken: await options.seats.sendTokenFor(seat.name),
    });
  }

  const file = options.file ?? backupFileFor(options.on ?? new Date(), options.folder ?? WHERE_BACKUPS_GO);
  await writeBackup({ file, passphrase: options.passphrase, holding });

  const note = join(dirname(file), "READ-ME-FIRST.md");
  await mkdir(dirname(note), { recursive: true, mode: 0o700 });
  await writeFile(note, theBackupNote(file), { mode: 0o600 });

  return { file, held: holding.length, withoutATokenYet: listed.length - withTokens.length };
}
