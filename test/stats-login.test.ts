import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readAccounts } from "../src/stats-login/index.ts";
import { ON_WINDOWS } from "../src/home/index.ts";
import { aBootstrapAnswer, aFolderOfLogins } from "./helpers/a-folder-of-logins.ts";

/**
 * Every tier this user's own accounts actually report, copied from a real answer
 * on 2026-08-21, plus the two Max tiers so the whole vocabulary is covered.
 */
const EVERY_TIER = [
  { uuid: "a1b2c3d4-0000-4000-8000-000000000001", name: "Acme", rate_limit_tier: "default_raven", raven_type: "team", seat_tier: "team_tier_1", capabilities: ["chat", "raven"] },
  { uuid: "b2c3d4e5-0000-4000-8000-000000000002", name: "Acme-2", rate_limit_tier: "default_raven", raven_type: "team", seat_tier: "team_standard", capabilities: ["chat", "raven"] },
  { uuid: "f6071829-0000-4000-8000-000000000006", name: "Own 20x", rate_limit_tier: "default_claude_max_20x", capabilities: ["claude_max", "chat"] },
  { uuid: "11111111-0000-0000-0000-000000000000", name: "Own 5x", rate_limit_tier: "default_claude_max_5x", capabilities: ["claude_max", "chat"] },
  { uuid: "22222222-0000-0000-0000-000000000000", name: "A Pro one", rate_limit_tier: "default_pro", capabilities: ["chat"] },
  { uuid: "41526a7b-0000-4000-8000-00000000000a", name: "Free one", rate_limit_tier: "default_claude_ai", capabilities: ["chat"] },
  { uuid: "526a7b8c-0000-4000-8000-00000000000b", name: "NIMBUS STUDIO LTD.", rate_limit_tier: "auto_trust_tier_c", capabilities: ["api"] },
  { uuid: "d4e5f607-0000-4000-8000-000000000004", name: "Eli's Individual Org", rate_limit_tier: "auto_api_evaluation", capabilities: ["api", "api_individual"] },
  { uuid: "33333333-0000-0000-0000-000000000000", name: "Something new", rate_limit_tier: "a_tier_nobody_here_has_seen", capabilities: ["chat"] },
];

test("every Organization an account belongs to is read, with what it is worth and whether it can pay", async () => {
  const logins = await aFolderOfLogins({ ana: "sk-ant-sid01-anas-login" });
  try {
    const asked: string[] = [];
    const read = await readAccounts({
      folder: logins.folder,
      keyFor: async () => logins.key,
      ask: async (statsLogin) => {
        asked.push(statsLogin);
        return aBootstrapAnswer("ana@example.com", EVERY_TIER);
      },
    });

    assert.deepEqual(asked, ["sk-ant-sid01-anas-login"], "the Stats login it read is the one it asked with");
    assert.deepEqual(read.unread, []);

    const account = read.accounts[0];
    assert.equal(account?.account, "ana@example.com");
    assert.equal(account?.profile, "ana");

    assert.deepEqual(
      account?.organizations.map((one) => [one.label, one.multiplier, one.cannotPay]),
      [
        ["Acme", 6.25, null],
        ["Acme-2", 1.25, null],
        ["Own 20x", 20, null],
        ["Own 5x", 5, null],
        ["A Pro one", 1, null],
        // Free is not "worth nothing and still a Seat": it cannot pay at all.
        ["Free one", 0, "free"],
        ["NIMBUS STUDIO LTD.", null, "api-only"],
        ["Eli's Individual Org", null, "api-only"],
        // A tier nobody has seen still yields a Seat. Refusing to name it is
        // honest; dropping it would lose a Seat the user really owns.
        ["Something new", null, null],
      ],
    );
  } finally {
    await logins.close();
  }
});

test("a Stats login that cannot be read is reported with its reason, and the others are still read", async () => {
  const logins = await aFolderOfLogins({
    alive: "sk-ant-sid01-still-good",
    "signed-out": null,
    stale: "sk-ant-sid01-expired-months-ago",
  });
  try {
    const read = await readAccounts({
      folder: logins.folder,
      keyFor: async () => logins.key,
      ask: async (statsLogin) => {
        if (statsLogin === "sk-ant-sid01-expired-months-ago") throw new Error("claude.ai answered 403");
        return aBootstrapAnswer("gus@example.com", [
          { uuid: "a1b2c3d4-0000-4000-8000-000000000001", name: "Acme", rate_limit_tier: "default_raven", raven_type: "team", seat_tier: "team_tier_1", capabilities: ["chat", "raven"] },
        ]);
      },
    });

    assert.deepEqual(read.accounts.map((one) => one.account), ["gus@example.com"]);
    assert.deepEqual(read.unread.map((one) => one.profile).sort(), ["signed-out", "stale"]);
    assert.match(read.unread.find((one) => one.profile === "stale")?.because ?? "", /403/);
    assert.match(read.unread.find((one) => one.profile === "signed-out")?.because ?? "", /signed out/i);
  } finally {
    await logins.close();
  }
});

test("a folder with no Stats logins in it is not an error, it is an empty answer", async () => {
  const logins = await aFolderOfLogins({});
  try {
    const read = await readAccounts({ folder: logins.folder, keyFor: async () => logins.key, ask: async () => ({}) });
    assert.deepEqual(read.accounts, []);
    assert.deepEqual(read.unread, []);
  } finally {
    await logins.close();
  }
});

test("nothing that was read is ever a credential the caller could leak", async () => {
  const logins = await aFolderOfLogins({ ana: "sk-ant-sid01-anas-login" });
  try {
    const read = await readAccounts({
      folder: logins.folder,
      keyFor: async () => logins.key,
      ask: async () => aBootstrapAnswer("ana@example.com", EVERY_TIER),
    });

    assert.doesNotMatch(JSON.stringify(read), /sk-ant/, "a Stats login must never travel out of this module");
  } finally {
    await logins.close();
  }
});

/**
 * A login read out of a profile is kept, and the next run is answered from it.
 *
 * This is what makes the Windows arrangement work at all: Claude Desktop holds a
 * running profile's cookie store open exclusively, so a profile that is open
 * cannot be read where it lives. Read it once while it is closed and it is
 * answered from then on. See `src/stats-login/internal/kept.ts` and ADR 0015.
 *
 * Both halves are asserted, and the second is the one that matters: the store the
 * profile came from is taken away before the second run, so being answered can
 * only have come from what was kept.
 */
test("a login read from a profile is kept, so the next run does not need that profile at all", { skip: !ON_WINDOWS }, async () => {
  const logins = await aFolderOfLogins({ ana: "sk-ant-sid01-anas-login" });
  const keptIn = join(await mkdtemp(join(tmpdir(), "relay-kept-")), "stats-logins.json");

  try {
    const asked: string[] = [];
    const ask = async (statsLogin: string) => {
      asked.push(statsLogin);
      return aBootstrapAnswer("ana@example.com", [EVERY_TIER[2]!]);
    };

    const first = await readAccounts({ folder: logins.folder, keyFor: async () => logins.key, ask, alsoKept: true, keptIn });
    assert.equal(first.accounts.length, 1);
    assert.deepEqual(asked, ["sk-ant-sid01-anas-login"]);

    // The profile goes, exactly as an open one is out of reach. Nothing is left
    // to read but what was kept.
    await logins.close();

    const again = await readAccounts({ folder: logins.folder, keyFor: async () => logins.key, ask, alsoKept: true, keptIn });
    assert.equal(again.accounts.length, 1, "the kept login answered when the profile could not");
    assert.equal(again.accounts[0]?.account, "ana@example.com");
    assert.deepEqual(asked, ["sk-ant-sid01-anas-login", "sk-ant-sid01-anas-login"]);

    // And a run that did not ask for the kept store does not quietly reach it:
    // with the folder gone there is nothing left, and it says so about the folder
    // rather than answering out of a credential nobody asked it to open.
    await assert.rejects(
      () => readAccounts({ folder: logins.folder, keyFor: async () => logins.key, ask }),
      /there are no Stats logins to read/,
      "a run that did not ask for kept logins must not be answered from them",
    );
  } finally {
    await logins.close().catch(() => {});
    await rm(dirname(keptIn), { recursive: true, force: true });
  }
});
