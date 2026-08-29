import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAccounts } from "../src/stats-login/index.ts";
import { changesBetween, describeChange, bringUpToDate, seatsFrom } from "../src/worklist/index.ts";
import { openSeatStore, type Seat } from "../src/seats/index.ts";
import { aBootstrapAnswer, aFolderOfLogins } from "./helpers/a-folder-of-logins.ts";

const ACME = "a1b2c3d4-0000-4000-8000-000000000001";
const OWN = "f6071829-0000-4000-8000-000000000006";

/** One answer from `/api/organizations/<id>/usage`, shaped as claude.ai answers it. */
function aUsageAnswer(fiveHourPercent: number, sevenDayPercent: number) {
  return {
    five_hour: { utilization: fiveHourPercent, resets_at: "2026-08-22T08:09:59.525042+00:00" },
    seven_day: { utilization: sevenDayPercent, resets_at: "2026-08-28T12:59:59.525060+00:00" },
    limits: [],
  };
}

const TEAM_AND_OWN = [
  { uuid: ACME, name: "Acme", rate_limit_tier: "default_raven", raven_type: "team", seat_tier: "team_tier_1", capabilities: ["chat"] },
  { uuid: OWN, name: "Own 20x", rate_limit_tier: "default_claude_max_20x", capabilities: ["chat"] },
  { uuid: "41526a7b-0000-0000-0000-000000000000", name: "Free one", rate_limit_tier: "default_claude_ai", capabilities: ["chat"] },
];

test("what a Seat has spent is read from the account's own login, marked as read there, and on the same scale as a reply", async () => {
  const logins = await aFolderOfLogins({ ana: "sk-ant-sid01-anas-login" });
  try {
    const askedFor: string[] = [];
    const read = await readAccounts({
      folder: logins.folder,
      keyFor: async () => logins.key,
      ask: async () => aBootstrapAnswer("ana@example.com", TEAM_AND_OWN),
      alsoWhatWasSpent: true,
      askUsage: async (_login, organizationId) => {
        askedFor.push(organizationId);
        return aUsageAnswer(14, 15);
      },
    });

    const organizations = read.accounts[0]?.organizations ?? [];

    // The free Organization yields no Seat, so its spending is never asked for.
    assert.deepEqual(askedFor, [ACME, OWN], "spending is asked for once per Seat, and only for Seats");

    const acme = organizations.find((one) => one.id === ACME);
    assert.equal(acme?.usage?.readVia, "stats-login", "a figure read here says so, so it is never taken for a reply's");
    // claude.ai states a percentage; a reply header states a share. One scale.
    assert.equal(acme?.usage?.fiveHour?.utilization, 0.14);
    assert.equal(acme?.usage?.sevenDay?.utilization, 0.15);
    assert.equal(acme?.usage?.fiveHour?.resetsAt, Math.trunc(Date.parse("2026-08-22T08:09:59.525042+00:00") / 1000));

    assert.equal(organizations.find((one) => one.cannotPay === "free")?.usage, null);
  } finally {
    await logins.close();
  }
});

test("an Organization whose spending cannot be read still yields its Seat, with the spending unknown", async () => {
  const logins = await aFolderOfLogins({ ana: "sk-ant-sid01-anas-login" });
  try {
    const read = await readAccounts({
      folder: logins.folder,
      keyFor: async () => logins.key,
      ask: async () => aBootstrapAnswer("ana@example.com", TEAM_AND_OWN),
      alsoWhatWasSpent: true,
      askUsage: async (_login, organizationId) => {
        if (organizationId === ACME) throw new Error("claude.ai answered 403");
        return aUsageAnswer(2, 3);
      },
    });

    assert.deepEqual(read.unread, [], "one Organization refusing is not a login that could not be read");
    const organizations = read.accounts[0]?.organizations ?? [];
    assert.equal(organizations.find((one) => one.id === ACME)?.usage, null, "unknown, not zero");
    assert.equal(organizations.find((one) => one.id === OWN)?.usage?.fiveHour?.utilization, 0.02);
  } finally {
    await logins.close();
  }
});

test("an answer that names neither window reads as unknown rather than as nothing spent", async () => {
  const logins = await aFolderOfLogins({ ana: "sk-ant-sid01-anas-login" });
  try {
    const read = await readAccounts({
      folder: logins.folder,
      keyFor: async () => logins.key,
      ask: async () => aBootstrapAnswer("ana@example.com", TEAM_AND_OWN),
      alsoWhatWasSpent: true,
      askUsage: async () => ({ five_hour: null, seven_day: null, limits: [] }),
    });
    assert.equal(read.accounts[0]?.organizations[0]?.usage, null);
  } finally {
    await logins.close();
  }
});

/**
 * The one rule that keeps a read path a read path.
 *
 * A Stats login can read and never sends (ADR 0002), and the whole of this module
 * is built on that. The proof is that nothing but the Stats login ever reaches
 * whatever asks claude.ai: if a Send token could arrive here, a bug in one branch
 * could spend a Seat while looking up what it had spent.
 */
test("nothing on the read path is ever handed a Send token", async () => {
  const logins = await aFolderOfLogins({ ana: "sk-ant-sid01-anas-login" });
  try {
    const handed: unknown[] = [];
    await readAccounts({
      folder: logins.folder,
      keyFor: async () => logins.key,
      ask: async (...given) => {
        handed.push(...given);
        return aBootstrapAnswer("ana@example.com", TEAM_AND_OWN);
      },
      alsoWhatWasSpent: true,
      askUsage: async (...given) => {
        handed.push(...given);
        return aUsageAnswer(1, 1);
      },
    });

    assert.ok(handed.length > 0, "something was asked, or this test proves nothing");
    for (const given of handed) {
      if (typeof given !== "string") continue;
      assert.ok(
        !given.startsWith("sk-ant-oat"),
        `a one-year Send token reached the read path: ${given.slice(0, 12)}…`,
      );
      assert.ok(!given.startsWith("sk-ant-api"), "an API key reached the read path");
    }
    assert.ok(
      handed.includes("sk-ant-sid01-anas-login"),
      "the only credential it asks with is the Stats login it read",
    );
  } finally {
    await logins.close();
  }
});

const heldSeat = (over: Partial<Seat> & { name: string }): Seat => ({
  account: "ana@example.com",
  organization: { id: ACME, label: "Acme" },
  multiplier: 6.25,
  ...over,
});

test("a plan change is noticed, and a Multiplier once read stays known", () => {
  const wanted = [heldSeat({ name: "ana-acme-a1b2", multiplier: 20 })];
  const held = [heldSeat({ name: "ana-acme-a1b2", multiplier: 6.25 })];

  const changes = changesBetween({ wanted, held, accountsRead: ["ana@example.com"] });
  assert.deepEqual(
    changes.map((change) => change.kind),
    ["multiplier"],
  );
  assert.match(describeChange(changes[0]!), /now 20x, where it was recorded as 6.25x/);
  assert.equal(bringUpToDate(changes[0]!)?.multiplier, 20);
});

test("a renamed Organization is a label change and never touches the id", () => {
  const changes = changesBetween({
    wanted: [heldSeat({ name: "ana-acme-a1b2", organization: { id: ACME, label: "Acme Ltd" } })],
    held: [heldSeat({ name: "ana-acme-a1b2" })],
    accountsRead: ["ana@example.com"],
  });
  assert.deepEqual(changes.map((change) => change.kind), ["label"]);
  assert.equal(bringUpToDate(changes[0]!)?.organization.id, ACME);
});

/**
 * The one that matters, and the reason `accountsRead` exists at all.
 *
 * Put the bug back — judge every held Seat rather than only the ones whose login
 * answered — and this fails, because a login that died would report every Seat of
 * that account as vanished.
 */
test("a login that could not be read leaves that account's Seats alone rather than reporting them gone", () => {
  const held = [
    heldSeat({ name: "ana-acme-a1b2" }),
    heldSeat({ name: "bo-acme-a1b2", account: "bo@example.com" }),
  ];

  const changes = changesBetween({
    wanted: [heldSeat({ name: "ana-acme-a1b2" })],
    held,
    // Only ana's login answered. Bo's is dead, and says nothing either way.
    accountsRead: ["ana@example.com"],
  });

  assert.deepEqual(changes, [], "nothing has changed, and nothing has vanished");
});

test("a Seat the owning account no longer lists is reported as vanished, never removed here", () => {
  const changes = changesBetween({
    wanted: [],
    held: [heldSeat({ name: "ana-acme-a1b2" })],
    accountsRead: ["ana@example.com"],
  });
  assert.deepEqual(changes.map((change) => change.kind), ["vanished"]);
  assert.equal(bringUpToDate(changes[0]!), null, "a vanished Seat is the user's decision, not a refresh's");
});

test("bringing a Seat up to date keeps its Send token", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-refresh-"));
  try {
    const file = join(folder, "seats.json");
    const tokens = new Map<string, string>();
    const store = openSeatStore({
      file,
      vault: {
        put: async (name, token) => void tokens.set(name, token),
        get: async (name) => tokens.get(name) ?? null,
        forget: async (name) => void tokens.delete(name),
      },
    });

    await store.add(heldSeat({ name: "ana-acme-a1b2" }), "sk-ant-oat01-a-token");
    await store.update(heldSeat({ name: "ana-acme-a1b2", multiplier: 20 }));

    const listed = await store.list();
    assert.equal(listed[0]?.multiplier, 20);
    assert.equal(listed[0]?.hasSendToken, true);
    assert.equal(await store.sendTokenFor("ana-acme-a1b2"), "sk-ant-oat01-a-token");
    assert.ok(!(await readFile(file, "utf8")).includes("sk-ant-oat01"), "no credential is ever written to the file");

    await assert.rejects(
      store.update(heldSeat({ name: "not-a-seat-here" })),
      /no Seat called "not-a-seat-here"/,
      "an unknown name is an error, not a quiet insert",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("only the Seats of accounts that were read are judged, straight out of what the logins said", () => {
  const { wanted } = seatsFrom([
    {
      profile: "ana",
      account: "ana@example.com",
      organizations: [
        { id: ACME, label: "Acme", multiplier: 6.25, cannotPay: null, usage: null },
      ],
    },
  ]);
  assert.equal(wanted.length, 1);
  assert.deepEqual(changesBetween({ wanted, held: wanted, accountsRead: ["ana@example.com"] }), []);
});
