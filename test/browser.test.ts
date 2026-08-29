import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { browserProfiles, profilesWorthTrying, type BrowserProfile } from "../src/browser/index.ts";

/**
 * The shape Chrome really writes, cut down from this machine's own file on
 * 2026-08-23. The profiles that matter are the ones whose address is empty: those
 * are signed into claude.ai with an email address, so the browser has no Google
 * account for them and records the address as an empty string. Over half the
 * profiles on a real machine read like that, which is the whole reason the mapping
 * is asked rather than worked out.
 */
const AS_CHROME_WRITES_IT = {
  profile: {
    info_cache: {
      Default: { name: "000 Personal", user_name: "kai@example.net" },
      "Profile 1": { name: "000 Acme", user_name: "kai.work@example.com" },
      // Measured on this machine: a profile signed into claude.ai with an email
      // address carries its address as an empty string rather than not at all.
      // Reading that as an address would make all of those look identified.
      "Profile 40": { name: "Z-Claude-dana.ops", user_name: "" },
      "Profile 41": { name: "Z-Claude-max", user_name: "  " },
      "Profile 42": { name: "Z-Claude-claude" },
    },
  },
  some_other_thing: { the_browser_keeps: true },
};

async function aListOfProfiles(content: unknown): Promise<{ file: string; away: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), "relay-browser-"));
  const file = join(folder, "Local State");
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return { file, away: () => rm(folder, { recursive: true, force: true }) };
}

test("every profile is read, with the name the browser knows it by and the name the user reads", async () => {
  const { file, away } = await aListOfProfiles(AS_CHROME_WRITES_IT);
  try {
    assert.deepEqual(await browserProfiles({ listedIn: file }), [
      { directory: "Default", label: "000 Personal", account: "kai@example.net" },
      { directory: "Profile 1", label: "000 Acme", account: "kai.work@example.com" },
      { directory: "Profile 40", label: "Z-Claude-dana.ops", account: null },
      { directory: "Profile 41", label: "Z-Claude-max", account: null },
      { directory: "Profile 42", label: "Z-Claude-claude", account: null },
    ]);
  } finally {
    await away();
  }
});

test("no browser on the machine is no profiles, not an error", async () => {
  assert.deepEqual(await browserProfiles({ listedIn: join(tmpdir(), "no-such-local-state-at-all") }), []);
});

test("a list that is not readable JSON is no profiles rather than a crash mid sitting", async () => {
  const { file, away } = await aListOfProfiles("{ this is not json");
  try {
    assert.deepEqual(await browserProfiles({ listedIn: file }), []);
  } finally {
    await away();
  }
});

test("a file far too big to be a list of profiles is refused rather than read", async () => {
  const { file, away } = await aListOfProfiles("x".repeat(11 * 1024 * 1024));
  try {
    await assert.rejects(browserProfiles({ listedIn: file }), /far too big/);
  } finally {
    await away();
  }
});

// ---- which profile, and never a guess --------------------------------------

const profiles: BrowserProfile[] = [
  { directory: "Default", label: "000 Personal", account: "kai@example.net" },
  { directory: "Profile 1", label: "000 Acme", account: "kai.work@example.com" },
  { directory: "Profile 40", label: "Z-Claude-dana.ops", account: null },
  { directory: "Profile 41", label: "Z-Claude-max", account: null },
];

/**
 * The likeliest first, and it is a hint: the sitting prints it as the window to
 * have in front, because `claude` opens the link itself. Nothing depends on it
 * being right, which is why a resemblance between a label and an account is
 * allowed to count here.
 */
test("the likeliest profile for an account comes first, and none is left out", () => {
  const order = profilesWorthTrying({ account: "dana.ops@example.com", profiles });
  assert.equal(order.length, profiles.length);
  assert.equal(order[0]?.directory, "Profile 40");
});
