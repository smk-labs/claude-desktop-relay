import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLI_LOGIN_SERVICE,
  cliLoginAccount,
  describeProof,
  lastChangedIn,
  readCliLoginFromKeychain,
  readCliLoginFromFile,
  safeToCarryOn,
  whatItProves,
  type AskSecurity,
  type CliLoginReading,
} from "../src/cli-login/index.ts";

/**
 * A real attribute dump, taken from this machine on 2026-08-23 with
 * `security find-generic-password -s "Claude Code-credentials" -a "$USER"`, so the
 * reader is held against the shape `security` actually prints rather than against
 * a shape invented to suit it.
 */
const AS_PRINTED = `keychain: "/Users/me/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="Claude Code-credentials"
    0x00000008 <blob>=<NULL>
    "acct"<blob>="me"
    "cdat"<timedate>=0x32303236303532333038323432365A00  "20260523082426Z\\000"
    "crtr"<uint32>=<NULL>
    "desc"<blob>=<NULL>
    "mdat"<timedate>=0x32303236303832323033313532375A00  "20260822031527Z\\000"
    "svce"<blob>="Claude Code-credentials"
    "type"<uint32>=<NULL>
`;

const answering = (answer: { code: number; out?: string; err?: string }): AskSecurity => async () => ({
  code: answer.code,
  out: answer.out ?? "",
  err: answer.err ?? "",
});

test("the date comes off a real attribute dump, from the text and not the hex", () => {
  assert.equal(lastChangedIn(AS_PRINTED), "20260822031527Z");
});

test("an entry with no date at all is not read as some default date", () => {
  assert.equal(lastChangedIn(`attributes:\n    "mdat"<timedate>=<NULL>\n`), null);
});

test("the entry is asked for by the service the CLI uses and the OS user, and never for the secret", async () => {
  let asked: readonly string[] = [];
  await readCliLoginFromKeychain({
    ask: async (args) => {
      asked = args;
      return { code: 0, out: AS_PRINTED, err: "" };
    },
  });

  assert.deepEqual(asked, ["find-generic-password", "-s", CLI_LOGIN_SERVICE, "-a", cliLoginAccount()]);
  // -w and -g are the two flags that would print the credential itself.
  assert.ok(!asked.includes("-w"));
  assert.ok(!asked.includes("-g"));
});

test("a held entry reads as held, with the date the Keychain gave", async () => {
  const reading = await readCliLoginFromKeychain({ ask: answering({ code: 0, out: AS_PRINTED }), account: "me" });
  assert.deepEqual(reading, { kind: "held", lastChanged: "20260822031527Z" });
});

test("no such entry is 44, and is a machine with nothing to lose rather than a failure", async () => {
  assert.deepEqual(await readCliLoginFromKeychain({ ask: answering({ code: 44, err: "The specified item could not be found in the keychain." }) }), {
    kind: "none",
  });
});

test("a failure that is not 44 is unreadable, because it answered nothing", async () => {
  const reading = await readCliLoginFromKeychain({ ask: answering({ code: 1, err: "User interaction is not allowed." }) });
  assert.deepEqual(reading, { kind: "unreadable", because: "User interaction is not allowed." });
});

test("an entry that prints without a date is unreadable, not untouched", async () => {
  const reading = await readCliLoginFromKeychain({ ask: answering({ code: 0, out: `attributes:\n    "acct"<blob>="me"\n` }) });
  assert.equal(reading.kind, "unreadable");
});

/**
 * `security` prints the decoded text only when the value has a printable
 * rendering. Without it the reader once ran on across the newline, ate the next
 * attribute's opening quote, and returned "svce" as the date: a wrong string
 * rather than nothing, which then compared equal to itself and read as untouched.
 */
test("a date printed as hex with no text beside it gives no date, rather than the next line's value", () => {
  const onlyHex = `attributes:
    "acct"<blob>="me"
    "mdat"<timedate>=0x32303236303832323033313532375A00
    "svce"<blob>="Claude Code-credentials"
`;
  assert.equal(lastChangedIn(onlyHex), null);
});

test("a keychain that is itself missing is unreadable, never an entry that is not there", async () => {
  const reading = await readCliLoginFromKeychain({
    ask: answering({ code: 1, err: "security: The specified keychain could not be found." }),
  });
  assert.equal(reading.kind, "unreadable");
});

test("the entry's own words are checked, so a duplicate somewhere else is not proved instead", async () => {
  const somebodyElses = AS_PRINTED.replace('"acct"<blob>="me"', '"acct"<blob>="someone-else"');
  const reading = await readCliLoginFromKeychain({ ask: answering({ code: 0, out: somebodyElses }), account: "me" });
  assert.equal(reading.kind, "unreadable");
  assert.match(reading.kind === "unreadable" ? reading.because : "", /not the entry that was asked for/);
});

test("an entry under another service is refused too, however well dated it is", async () => {
  const otherService = AS_PRINTED.replaceAll('"svce"<blob>="Claude Code-credentials"', '"svce"<blob>="something-else"');
  const reading = await readCliLoginFromKeychain({ ask: answering({ code: 0, out: otherService }), account: "me" });
  assert.equal(reading.kind, "unreadable");
});

/**
 * A locked keychain puts up an unlock dialog and waits for the person. Skipping
 * `-w` avoids the permission prompt and not that one, so the reading has a
 * ceiling and reports hitting it rather than leaving the flow with nothing on the
 * screen for ever.
 */
test("a Keychain that never answers is unreadable within seconds, not a wait with no end", async () => {
  const reading = await readCliLoginFromKeychain({
    ask: async () => ({ code: -1, out: "", err: "the Keychain did not answer within 5 seconds" }),
  });
  assert.deepEqual(reading, { kind: "unreadable", because: "the Keychain did not answer within 5 seconds" });
});

// ---- what a pair of readings proves ----------------------------------------

const held = (at: string): CliLoginReading => ({ kind: "held", lastChanged: at });
const none: CliLoginReading = { kind: "none" };
const unreadable: CliLoginReading = { kind: "unreadable", because: "the Keychain would not say" };

test("the same date before and after proves the CLI login was not written to", () => {
  const proof = whatItProves(held("20260822031527Z"), held("20260822031527Z"));
  assert.deepEqual(proof, { kind: "untouched" });
  assert.equal(safeToCarryOn(proof), true);
});

test("a later date is the hazard firing, and carrying on is refused", () => {
  const proof = whatItProves(held("20260822031527Z"), held("20260823101500Z"));
  assert.deepEqual(proof, { kind: "written", was: "20260822031527Z", now: "20260823101500Z" });
  assert.equal(safeToCarryOn(proof), false);
  assert.match(describeProof(proof), /was written to/);
});

test("an entry appearing where there was none is the hazard too", () => {
  const proof = whatItProves(none, held("20260823101500Z"));
  assert.deepEqual(proof, { kind: "created", now: "20260823101500Z" });
  assert.equal(safeToCarryOn(proof), false);
});

test("an entry that has gone is the hazard, and says the login is gone rather than unchanged", () => {
  const proof = whatItProves(held("20260822031527Z"), none);
  assert.deepEqual(proof, { kind: "vanished", was: "20260822031527Z" });
  assert.equal(safeToCarryOn(proof), false);
});

test("no entry either side is untouched: there is nothing on this machine to lose", () => {
  assert.deepEqual(whatItProves(none, none), { kind: "untouched" });
});

/**
 * The one that matters. Two failed readings are identical strings, so a reader
 * that compared them would call it untouched and wave a whole sitting of sign-ins
 * through having proved nothing at all.
 */
test("a reading that failed proves nothing, either side, and never reads as untouched", () => {
  for (const [before, after] of [
    [unreadable, held("20260822031527Z")],
    [held("20260822031527Z"), unreadable],
    [unreadable, unreadable],
  ] as const) {
    const proof = whatItProves(before, after);
    assert.equal(proof.kind, "cannot-say");
    assert.equal(safeToCarryOn(proof), false);
    assert.match(describeProof(proof), /could not be read/);
  }
});
