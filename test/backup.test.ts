import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { access } from "node:fs/promises";

import {
  backUpEveryHeldSeat,
  backupFileFor,
  isABackupName,
  latestBackup,
  readBackup,
  theBackupNote,
  writeBackup,
  type BackedUpSeat,
} from "../src/backup/index.ts";
import { openSeatStore } from "../src/seats/index.ts";
import { aVaultInMemory } from "./helpers/a-vault-in-memory.ts";
import { ON_WINDOWS } from "../src/home/index.ts";

/** Whether a path is there, without caring why not. */
const there = (path: string) => access(path).then(() => true, () => false);

const A_TOKEN = "sk-ant-oat01-the-one-that-took-an-hour-to-get";
const PASSPHRASE = "a passphrase the user actually chose";

const HOLDING: BackedUpSeat[] = [
  {
    name: "ana-acme-a1b2",
    account: "ana@example.com",
    organization: { id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme" },
    multiplier: 6.25,
    sendToken: A_TOKEN,
  },
  {
    name: "bo-own-c3d4",
    account: "bo@example.com",
    organization: { id: "c3d4e5f6-0000-4000-8000-000000000003", label: "bo@example.com's Organization" },
    multiplier: 20,
    sendToken: "sk-ant-oat01-another-one",
  },
];

/** A folder of its own, so nothing here goes near a real backup. */
async function inATempFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "relay-backup-test-"));
  try {
    return await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("a backup gives back exactly the Seats and tokens that went into it", async () => {
  await inATempFolder(async (folder) => {
    const file = join(folder, "send-tokens.zip.enc");
    await writeBackup({ file, passphrase: PASSPHRASE, holding: HOLDING });

    const read = await readBackup({ file, passphrase: PASSPHRASE });

    assert.deepEqual(read.seats, HOLDING, "a backup that changes what it holds is worse than none");
    assert.match(read.savedAt, /^\d{4}-\d{2}-\d{2}T/, "it has to say when it was taken");
  });
});

/**
 * The half of an archive that decides whether a restored machine can say anything.
 *
 * A Send token pays and can say nothing about a plan. Every plan name, every
 * Multiplier and every idle Seat's usage is read from a claude.ai session, and
 * those sessions live in Claude Desktop profiles that do not travel. So an
 * archive of tokens alone restores a machine that bills correctly and reads "not
 * known" on every row, which is exactly the thing somebody carrying a backup to
 * Windows or a server is trying to avoid.
 */
test("a backup carries the Stats logins as well, and gives them back unchanged", async () => {
  await inATempFolder(async (folder) => {
    const file = join(folder, "send-tokens.zip.enc");
    const statsLogins = [
      { profile: "ana", statsLogin: "sk-ant-sid01-anas-login" },
      { profile: "bo", statsLogin: "sk-ant-sid01-bos-login" },
    ];
    await writeBackup({ file, passphrase: PASSPHRASE, holding: HOLDING, statsLogins });

    const read = await readBackup({ file, passphrase: PASSPHRASE });
    assert.deepEqual(read.statsLogins, statsLogins);
    assert.deepEqual(read.seats, HOLDING, "carrying the logins must not disturb the Seats");

    // They are inside the cipher like everything else. A Stats login can read an
    // account's plan and its spending, so a copy beside the archive would be a
    // credential in a plain file.
    const raw = await readFile(file);
    assert.equal(raw.includes(Buffer.from("anas-login")), false);
  });
});

/**
 * Older archives, and machines where every profile was signed out.
 *
 * Neither is damaged, so neither may be refused. The reader asks for the Seats and
 * treats the logins as absent, because losing the second half costs the plan names
 * and not the ability to pay.
 */
test("an archive with no Stats logins in it still opens, and says it has none", async () => {
  await inATempFolder(async (folder) => {
    const file = join(folder, "send-tokens.zip.enc");
    await writeBackup({ file, passphrase: PASSPHRASE, holding: HOLDING });

    const read = await readBackup({ file, passphrase: PASSPHRASE });
    assert.equal(read.statsLogins, undefined);
    assert.equal(read.seats.length, HOLDING.length);
  });
});

/**
 * The whole point of locking it. This file holds credentials that each pay for a
 * year, so a reader who finds it must find nothing they can use.
 */
test("the file on disk carries no token anybody can read, and only its owner can open it", async () => {
  await inATempFolder(async (folder) => {
    const file = join(folder, "send-tokens.zip.enc");
    await writeBackup({ file, passphrase: PASSPHRASE, holding: HOLDING });

    const raw = await readFile(file, "latin1");
    assert.doesNotMatch(raw, /sk-ant/, "the tokens are sitting there in the clear");
    assert.doesNotMatch(raw, /acme/i, "even who the Seats belong to is nobody else's business");

    /**
     * Windows has no such mode. `stat` reports 0o666 for every file there whatever
     * was asked for, so asserting it would be a test that passes for the wrong
     * reason on one machine and says nothing on the other. What stands in its
     * place on Windows is the passphrase: the archive is unreadable without it,
     * which is asserted above and holds on both.
     */
    if (!ON_WINDOWS) {
      const mode = (await stat(file)).mode & 0o777;
      assert.equal(mode, 0o600, `anyone on this machine can read it: mode ${mode.toString(8)}`);
    }
  });
});

test("the wrong passphrase does not open a backup, and says so rather than giving back nonsense", async () => {
  await inATempFolder(async (folder) => {
    const file = join(folder, "send-tokens.zip.enc");
    await writeBackup({ file, passphrase: PASSPHRASE, holding: HOLDING });

    await assert.rejects(
      () => readBackup({ file, passphrase: "not the passphrase at all" }),
      /would not open|passphrase was wrong/,
    );
  });
});

test("a backup refuses to be taken of nothing, or under a passphrase that is not one", async () => {
  await inATempFolder(async (folder) => {
    const file = join(folder, "send-tokens.zip.enc");

    await assert.rejects(() => writeBackup({ file, passphrase: PASSPHRASE, holding: [] }), /no Seats/);
    await assert.rejects(() => writeBackup({ file, passphrase: "short", holding: HOLDING }), /too short/);
  });
});

/**
 * The bug this pins was the worst kind: a safety net that could not see its own
 * catch.
 *
 * The command wrote `send-tokens-<date>.zip.enc`. The reader counted only names
 * ending `.backup`. So `relay` would tell a user who had just taken a backup that
 * they had none, and the only way to discover that is to spend the hour of
 * signing in first. Every Send token on the machine was lost on 2026-08-22 for
 * want of a backup, and this is the warning built so it could not happen twice.
 */
test("a backup the command writes is a backup the reader finds", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-backup-naming-"));
  try {
    assert.equal(await latestBackup(folder), null, "nothing yet");

    const file = backupFileFor(new Date("2026-08-22T09:00:00Z"), folder);
    await writeBackup({
      file,
      passphrase: "a-passphrase-long-enough",
      holding: [
        {
          name: "ana-acme-a1b2",
          account: "ana@example.com",
          organization: { id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme" },
          multiplier: 6.25,
          sendToken: "sk-ant-oat01-a-token",
        },
      ],
    });

    const found = await latestBackup(folder);
    assert.ok(found, "the reader must find what the command just wrote");
    assert.equal(found.file, file);
    assert.equal(found.on, "2026-08-22", "and date it from its own name");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a backup taken before today's naming is still recognised", () => {
  // Every backup taken before this was fixed carries the older ending. A reader
  // that stopped seeing them would be the same bug pointing the other way.
  assert.equal(isABackupName("send-tokens-2026-08-22.zip.enc"), true);
  assert.equal(isABackupName("send-tokens-2026-08-22.backup"), true);
  assert.equal(isABackupName("READ-ME-FIRST.md"), false);
  assert.equal(isABackupName("notes.txt"), false);
});

test("the newest backup wins, so a restore does not need to know the date", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-backup-newest-"));
  try {
    const holding = [
      {
        name: "ana-acme-a1b2",
        account: "ana@example.com",
        organization: { id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme" },
        multiplier: 6.25 as const,
        sendToken: "sk-ant-oat01-a-token",
      },
    ];
    for (const day of ["2026-08-20T09:00:00Z", "2026-08-22T09:00:00Z", "2026-08-21T09:00:00Z"]) {
      await writeBackup({ file: backupFileFor(new Date(day), folder), passphrase: "a-passphrase-long-enough", holding });
    }

    const found = await latestBackup(folder);
    assert.equal(found?.on, "2026-08-22", "the newest, whatever order they were written in");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

/**
 * One implementation, because two callers need exactly this: the command a person
 * runs and the sitting, which takes a backup after every Seat it fills. A sitting
 * that fills Seats and does not back them up is the hole that cost every Send
 * token on 2026-08-22, so it has to be able to do it rather than print a reminder.
 */
test("backing up every held Seat writes the archive and the note beside it", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-backup-all-"));
  try {
    const seats = openSeatStore({ file: join(folder, "seats.json"), vault: aVaultInMemory() });
    await seats.add(
      {
        name: "bo-own-c3d4",
        account: "bo@example.com",
        organization: { id: "c3d4e5f6-0000-4000-8000-000000000003", label: "own" },
        multiplier: 20,
      },
      "sk-ant-oat01-only-a-test-ever-sees-this",
    );

    const taken = await backUpEveryHeldSeat({ seats, passphrase: "a-long-enough-one", folder });

    assert.equal(taken.held, 1);
    assert.equal(taken.withoutATokenYet, 0);
    assert.equal(await there(join(folder, "READ-ME-FIRST.md")), true);

    const back = await readBackup({ file: taken.file, passphrase: "a-long-enough-one" });
    assert.deepEqual(
      back.seats.map((one) => one.name),
      ["bo-own-c3d4"],
    );
    assert.equal(back.seats[0]?.sendToken, "sk-ant-oat01-only-a-test-ever-sees-this");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("nothing to back up is refused rather than written as an empty archive", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-backup-none-"));
  try {
    const seats = openSeatStore({ file: join(folder, "seats.json"), vault: aVaultInMemory() });
    await assert.rejects(
      backUpEveryHeldSeat({ seats, passphrase: "a-long-enough-one", folder }),
      /nothing to back up/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("the note beside the archive names that archive, and says not to delete it", () => {
  const note = theBackupNote("/somewhere/send-tokens-2026-08-23.zip.enc");
  assert.match(note, /send-tokens-2026-08-23\.zip\.enc/);
  assert.match(note, /Do not delete anything in this folder/);
  assert.match(note, /relay back-up-seats --restore/);
});
