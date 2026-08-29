import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildWorklist, seatNameFor, seatsFrom } from "../src/worklist/index.ts";
import type { AccountAsRead, OrganizationAsRead } from "../src/stats-login/index.ts";
import type { Seat } from "../src/seats/index.ts";

/**
 * The names are checked against literals written out by hand from the rule, not
 * recomputed by calling the rule again, so a change to the rule fails here rather
 * than agreeing with itself.
 */
test("a Seat's name is derived from the account and the Organization, and says which is which", () => {
  assert.equal(
    seatNameFor("cy@example.com", { id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme" }),
    "cy-acme-a1b2",
  );

  assert.equal(
    seatNameFor("dana.ops@example.com", { id: "b2c3d4e5-0000-4000-8000-000000000002", label: "Acme-2" }),
    "dana-ops-acme-2-b2c3",
  );
});

test("an account's own Organization is called own, rather than repeating the email back", () => {
  assert.equal(
    seatNameFor("ana@example.com", {
      id: "e5f60718-0000-4000-8000-000000000005",
      label: "ana@example.com's Organization",
    }),
    "ana-own-e5f6",
  );
});

test("the same account and Organization always give the same name, whatever else is around", () => {
  const once = seatNameFor("bo@example.com", { id: "c3d4e5f6-0000-4000-8000-000000000003", label: "Whatever" });
  const again = seatNameFor("bo@example.com", { id: "c3d4e5f6-0000-4000-8000-000000000003", label: "Whatever" });
  assert.equal(once, again);
});

/**
 * Two Organizations really do share a label here: the account `not-claude` belongs
 * to two called "Acme", and one of them is not the other. A name built from
 * the account and the label alone would be the same for both.
 */
test("two Organizations with the same label under one account get different names", () => {
  const one = seatNameFor("fin-user@example.com", {
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    label: "Acme",
  });
  const other = seatNameFor("fin-user@example.com", {
    id: "07182930-0000-4000-8000-000000000007",
    label: "Acme",
  });

  assert.notEqual(one, other);
});

test("a name carries nothing that would need quoting or escaping anywhere it is typed", () => {
  const name = seatNameFor("eli.max@example.com", {
    id: "d4e5f607-0000-4000-8000-000000000004",
    label: "Max‘s Individual Org",
  });

  assert.match(name, /^[a-z0-9-]+$/, `"${name}" has to be typeable as one word on a command line`);
});

/** Shaped exactly as `readAccounts` reports it, so this test speaks its language. */
function anAccount(account: string, organizations: OrganizationAsRead[]): AccountAsRead {
  return { profile: account.split("@")[0] ?? account, account, organizations };
}

function anOrganization(over: Partial<OrganizationAsRead> & { id: string; label: string }): OrganizationAsRead {
  return { multiplier: 6.25, cannotPay: null, usage: null, ...over };
}

test("an Organization that cannot pay yields no Seat, and the flow says which and why", () => {
  const { wanted, dropped } = seatsFrom([
    anAccount("eli.max@example.com", [
      anOrganization({ id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme" }),
      anOrganization({ id: "d4e5f607-0000-4000-8000-000000000004", label: "Eli's Org", cannotPay: "api-only" }),
      anOrganization({
        id: "18293041-0000-4000-8000-000000000008",
        label: "eli.max@example.com's Organization",
        multiplier: 0,
        cannotPay: "free",
      }),
    ]),
  ]);

  assert.deepEqual(
    wanted.map((seat) => seat.name),
    ["eli-max-acme-a1b2"],
  );
  assert.deepEqual(
    dropped.map((one) => one.because).sort(),
    ["api-only", "free"],
  );
});

/**
 * Ordered by the Worklist itself and not by whoever handed it the Seats, because
 * a Worklist read back from an edited file arrives in whatever order that file
 * happens to be in.
 */
test("the Seats of one account arrive worth the most first", () => {
  const { wanted } = seatsFrom([
    anAccount("bo@example.com", [
      anOrganization({ id: "b2c3d4e5-0000-4000-8000-000000000002", label: "Acme-2", multiplier: 1.25 }),
      anOrganization({
        id: "c3d4e5f6-0000-4000-8000-000000000003",
        label: "bo@example.com's Organization",
        multiplier: 20,
      }),
      anOrganization({ id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme", multiplier: 6.25 }),
    ]),
  ]);

  const worklist = buildWorklist({ wanted, held: [] });

  assert.deepEqual(
    worklist.entries.map((entry) => entry.seat.multiplier),
    [20, 6.25, 1.25],
  );
});

/**
 * Filling a Seat costs a sign-in as its account, and the sign-in is the slow
 * part. Sorting by Multiplier alone scatters one account's Seats down the list,
 * so a sitting signs in and out of the same account several times over.
 */
test("a sitting never returns to an account it has already finished with", () => {
  const { wanted } = seatsFrom([
    anAccount("bo@example.com", [
      anOrganization({ id: "c3d4e5f6-0000-4000-8000-000000000003", label: "Own", multiplier: 20 }),
      anOrganization({ id: "b2c3d4e5-0000-4000-8000-000000000002", label: "Acme-2", multiplier: 1.25 }),
    ]),
    anAccount("ana@example.com", [
      anOrganization({ id: "e5f60718-0000-4000-8000-000000000005", label: "Own", multiplier: 20 }),
      anOrganization({ id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme", multiplier: 6.25 }),
    ]),
  ]);

  const order = buildWorklist({ wanted, held: [] }).entries.map((entry) => entry.seat.account);

  const seen = new Set<string>();
  let last = "";
  for (const account of order) {
    if (account !== last) {
      assert.equal(seen.has(account), false, `${account} is signed into twice: ${order.join(", ")}`);
      seen.add(account);
      last = account;
    }
  }

  // The account holding the best Seat is still the one to start with, so
  // stopping halfway still leaves the Seats that matter filled.
  assert.equal(order[0], "ana@example.com", order.join(", "));
});

test("the Worklist says which Seats are filled, and holds Seats it does not know about apart", () => {
  const { wanted } = seatsFrom([
    anAccount("ana@example.com", [
      anOrganization({ id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme", multiplier: 6.25 }),
      anOrganization({ id: "b2c3d4e5-0000-4000-8000-000000000002", label: "Acme-2", multiplier: 1.25 }),
    ]),
  ]);

  const worklist = buildWorklist({
    wanted,
    held: [
      { ...(wanted[0] as Seat), hasSendToken: true },
      {
        name: "parked",
        account: "unknown",
        organization: { id: "a1b2c3d4-0000-4000-8000-000000000001", label: "unnamed" },
        multiplier: 1,
        hasSendToken: true,
      },
    ],
  });

  assert.deepEqual(
    worklist.entries.map((entry) => [entry.seat.name, entry.filled]),
    [
      ["ana-acme-a1b2", true],
      ["ana-acme-2-b2c3", false],
    ],
  );
  assert.deepEqual(worklist.missing.map((entry) => entry.seat.name), ["ana-acme-2-b2c3"]);
  // Held, but nothing on the Worklist claims it. A Send token proves an
  // Organization and never an account, so nothing here may guess which Seat it is.
  assert.deepEqual(worklist.strays.map((seat) => seat.name), ["parked"]);
  // Carried whole, because settling one needs the Organization it thinks it is in.
  assert.equal(worklist.strays[0]?.organization.id, "a1b2c3d4-0000-4000-8000-000000000001");
});

test("a Seat listed without its Send token counts as missing, not as filled", () => {
  const { wanted } = seatsFrom([
    anAccount("hana@example.com", [anOrganization({ id: "29304152-0000-4000-8000-000000000009", label: "Own" })]),
  ]);

  const worklist = buildWorklist({ wanted, held: [{ ...(wanted[0] as Seat), hasSendToken: false }] });

  assert.equal(worklist.entries[0]?.filled, false);
  assert.equal(worklist.strays.length, 0, "it is on the Worklist, so it is not a stray");
});

test("two Seats that would share a name stop the Worklist rather than quietly becoming one", () => {
  const same = { id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme" };

  assert.throws(
    () =>
      buildWorklist({
        wanted: [
          { name: "clash", account: "one@example.com", organization: same, multiplier: 1 },
          { name: "clash", account: "two@example.com", organization: same, multiplier: 1 },
        ],
        held: [],
      }),
    /clash/,
  );
});
