/**
 * The three things the Linux side has of its own: where the tokens live, how a
 * backup is opened without `unzip`, and that the two halves of that still agree
 * with the macOS writer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileVault, everySeatHeldInFile } from "../internal/file-vault.ts";
import { readBackup } from "../../src/backup/index.ts";
import { fileFromZip } from "../../src/zip/index.ts";
import { openSeatStore } from "../../src/seats/index.ts";
import { writeBackup } from "../../src/backup/index.ts";

const scratch = () => mkdtemp(join(tmpdir(), "relay-linux-"));

const A_SEAT = {
  name: "dana-acme",
  account: "dana@example.com",
  organization: { id: "org-1a2b3c", label: "Acme" },
  multiplier: 20,
} as const;

/**
 * Linux only, and it says so rather than failing elsewhere.
 *
 * The claim is about Unix file permissions, which are the whole of what stands
 * between these tokens and the other people on that box. Windows reports one mode
 * for every file whatever was asked for, so run there this asserts nothing and
 * fails while nothing is wrong.
 */
test("a Send token goes in the file and comes back out, and nothing else can read it", { skip: process.platform === "win32" }, async () => {
  const folder = await scratch();
  const file = join(folder, "send-tokens.json");
  const vault = fileVault(file);

  await vault.put("dana-acme", "sk-ant-oat01-first");
  assert.equal(await vault.get("dana-acme"), "sk-ant-oat01-first");

  // Replaced, not joined: two tokens under one Seat is a Seat that pays at random.
  await vault.put("dana-acme", "sk-ant-oat01-second");
  assert.equal(await vault.get("dana-acme"), "sk-ant-oat01-second");

  assert.equal(await vault.get("never-collected"), null);

  // The whole reason this file is allowed to exist: the mode is the protection.
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, `the token file is ${mode.toString(8)} and must be 600`);

  await vault.forget("dana-acme");
  assert.equal(await vault.get("dana-acme"), null);
  // Forgetting one that was never there is not a failure.
  await vault.forget("dana-acme");
});

test("the Seat list holds no credential, the same as on macOS", async () => {
  const folder = await scratch();
  const tokens = join(folder, "send-tokens.json");
  const seats = openSeatStore({ file: join(folder, "seats.json"), vault: fileVault(tokens) });

  await seats.add(A_SEAT, "sk-ant-oat01-secret");

  const listed = await seats.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.hasSendToken, true);
  assert.equal(await seats.sendTokenFor(A_SEAT.name), "sk-ant-oat01-secret");

  const written = await readFile(join(folder, "seats.json"), "utf8");
  assert.ok(!written.includes("sk-ant-oat01-secret"), "a Send token reached seats.json");
  assert.deepEqual(await everySeatHeldInFile(tokens), [A_SEAT.name]);
});

/**
 * The guard that used to be here is gone because what it guarded is gone.
 *
 * `linux/internal/read-backup.ts` held a second copy of the cipher and of the
 * name of the file inside the archive, so that a Mac backup could be opened on a
 * box with no `unzip`. `src/backup` does the whole thing in Node now — the cipher
 * as well as the zip — so there is one reader, one writer, and nothing to keep in
 * step. A test that reads one file's constants out of another file's source is
 * the second best answer to that problem; having one implementation is the first.
 */
test("a backup written by the macOS side opens here, and a wrong passphrase does not", async (t) => {
  // The writer runs `zip`, which the Linux box does not have. That is the whole
  // reason the reader exists, so the round trip is asserted wherever `zip` is.
  const haveZip = await stat("/usr/bin/zip").then(() => true).catch(() => false);
  if (!haveZip) return t.skip("no /usr/bin/zip here, which is why the reader was written");

  const folder = await scratch();
  const file = join(folder, "send-tokens-2026-08-25.zip.enc");
  await writeBackup({
    file,
    passphrase: "a-long-enough-passphrase",
    holding: [{ ...A_SEAT, sendToken: "sk-ant-oat01-secret" }],
  });

  const read = await readBackup({ file, passphrase: "a-long-enough-passphrase" });
  assert.equal(read.seats.length, 1);
  assert.equal(read.seats[0]?.sendToken, "sk-ant-oat01-secret");
  assert.equal(read.seats[0]?.organization.id, "org-1a2b3c");

  await assert.rejects(
    () => readBackup({ file, passphrase: "not-the-passphrase" }),
    /would not open|holds no|not a zip/,
    "a wrong passphrase produced something that looked like an answer",
  );
});

test("the zip reader refuses what it cannot read instead of half-reading it", async () => {
  await assert.rejects(
    async () => fileFromZip(Buffer.from("this is not an archive at all"), "seats-and-send-tokens.json"),
    /not a zip archive/,
  );

  const folder = await scratch();
  const plain = join(folder, "plain.txt");
  await writeFile(plain, "x");
  assert.throws(() => fileFromZip(Buffer.alloc(64), "seats-and-send-tokens.json"), /not a zip archive/);
});
