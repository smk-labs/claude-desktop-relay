import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSeatStore, type Seat } from "../src/seats/index.ts";
import { aVaultInMemory } from "./helpers/a-vault-in-memory.ts";

const WORK: Seat = {
  name: "work",
  account: "me@work.example",
  organization: { id: "org-acme-1a2b", label: "Acme" },
  multiplier: 20,
};

const SIDE: Seat = {
  name: "side",
  account: "me@home.example",
  organization: { id: "org-just-me-9z8y", label: "Just me" },
  multiplier: 1.25,
};

async function aStore() {
  const folder = await mkdtemp(join(tmpdir(), "relay-seats-"));
  const file = join(folder, "seats.json");
  const vault = aVaultInMemory();
  return {
    file,
    vault,
    seats: openSeatStore({ file, vault }),
    async forget() {
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test("a Seat can be added, listed and removed", async () => {
  const { seats, forget } = await aStore();
  try {
    await seats.add(WORK, "sk-ant-oat01-work");
    await seats.add(SIDE, "sk-ant-oat01-side");

    assert.deepEqual(
      (await seats.list()).map((seat) => seat.name),
      ["work", "side"],
    );

    await seats.remove("work");
    assert.deepEqual(
      (await seats.list()).map((seat) => seat.name),
      ["side"],
    );
  } finally {
    await forget();
  }
});

test("a Send token comes back byte for byte", async () => {
  const { seats, forget } = await aStore();
  // Awkward on purpose: the value must survive whatever the vault does to it.
  const token = "sk-ant-oat01-AaZz09-_=+/ .:\t end";
  try {
    await seats.add(WORK, token);
    assert.equal(await seats.sendTokenFor("work"), token);
  } finally {
    await forget();
  }
});

test("the store file holds identity and Multiplier, and no credential", async () => {
  const { seats, file, forget } = await aStore();
  try {
    await seats.add(WORK, "sk-ant-oat01-work");

    const written = await readFile(file, "utf8");
    assert.ok(written.includes("Acme"), "the Organization label belongs in the file");
    assert.ok(written.includes("org-acme-1a2b"), "and so does the Organization id");
    assert.ok(written.includes("20"), "the Multiplier belongs in the file");
    assert.ok(!written.includes("sk-ant-oat01-work"), `the file holds a credential:\n${written}`);
    assert.ok(!written.includes("sk-ant-"), `the file holds something token shaped:\n${written}`);
  } finally {
    await forget();
  }
});

test("asking for the token of a Seat that does not exist is an error, not an empty string", async () => {
  const { seats, forget } = await aStore();
  try {
    await assert.rejects(() => seats.sendTokenFor("nobody"), /nobody/);
  } finally {
    await forget();
  }
});

test("a Seat whose token has gone missing is listed as such, not left out", async () => {
  const { seats, vault, forget } = await aStore();
  try {
    await seats.add(WORK, "sk-ant-oat01-work");
    await seats.add(SIDE, "sk-ant-oat01-side");

    // As if the user deleted it from the Keychain, or it expired and was removed.
    vault.held.delete("work");

    const listed = await seats.list();
    assert.equal(listed.length, 2, "the Seat must still be listed");
    assert.equal(listed.find((seat) => seat.name === "work")?.hasSendToken, false);
    assert.equal(listed.find((seat) => seat.name === "side")?.hasSendToken, true);

    await assert.rejects(() => seats.sendTokenFor("work"), /no Send token/);
  } finally {
    await forget();
  }
});

test("removing a Seat forgets its token as well", async () => {
  const { seats, vault, forget } = await aStore();
  try {
    await seats.add(WORK, "sk-ant-oat01-work");
    await seats.remove("work");
    assert.equal(vault.held.has("work"), false);
    assert.ok(vault.asked.includes("forget work"));
  } finally {
    await forget();
  }
});

test("a store that has never been written lists nothing rather than failing", async () => {
  const { seats, forget } = await aStore();
  try {
    assert.deepEqual(await seats.list(), []);
  } finally {
    await forget();
  }
});

test("the Seats survive being written and read again", async () => {
  const { file, vault, seats, forget } = await aStore();
  try {
    await seats.add(WORK, "sk-ant-oat01-work");

    const reopened = openSeatStore({ file, vault });
    const listed = await reopened.list();
    assert.equal(listed[0]?.organization.label, "Acme");
    assert.equal(listed[0]?.multiplier, 20);
    assert.equal(await reopened.sendTokenFor("work"), "sk-ant-oat01-work");
  } finally {
    await forget();
  }
});

test("adding a Seat twice replaces it rather than listing it twice", async () => {
  const { seats, forget } = await aStore();
  try {
    await seats.add(WORK, "sk-ant-oat01-work");
    await seats.add({ ...WORK, organization: { id: "org-acme-1a2b", label: "Acme Holdings" } }, "sk-ant-oat01-newer");

    const listed = await seats.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.organization.label, "Acme Holdings");
    assert.equal(await seats.sendTokenFor("work"), "sk-ant-oat01-newer");
  } finally {
    await forget();
  }
});
