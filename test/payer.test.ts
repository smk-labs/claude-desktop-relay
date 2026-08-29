import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openPayer, pickPayer, readChoice, turnOff, UNTOUCHED } from "../src/payer/index.ts";
import { openSeatStore, type Seat, type SeatStore } from "../src/seats/index.ts";
import { startRelay } from "../src/relay/index.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";
import { requestThrough } from "./helpers/through-the-relay.ts";
import { aVaultInMemory, type VaultInMemory } from "./helpers/a-vault-in-memory.ts";

/** A request with no body to read. The Payer's answer about who pays is the same. */
const NO_BODY = { method: "POST", path: "/v1/messages", body: null } as const;

const OPEN_HOST = "api.anthropic.com";
const CALLER = "Bearer sk-ant-oat01-the-window-account";

after(forgetAuthorities);

const WORK: Seat = { name: "work", account: "me@work", organization: { id: "org-acme", label: "Acme" }, multiplier: 20 };
const SIDE: Seat = { name: "side", account: "me@home", organization: { id: "org-home", label: "Home" }, multiplier: 1.25 };

type Bench = {
  choiceFile: string;
  seats: SeatStore;
  vault: VaultInMemory;
  forget: () => Promise<void>;
};

async function aBench(): Promise<Bench> {
  const folder = await mkdtemp(join(tmpdir(), "relay-payer-"));
  const vault = aVaultInMemory();
  const seats = openSeatStore({ file: join(folder, "seats.json"), vault });
  await seats.add(WORK, "sk-ant-oat01-work");
  await seats.add(SIDE, "sk-ant-oat01-side");

  return {
    choiceFile: join(folder, "choice.json"),
    seats,
    vault,
    forget: () => rm(folder, { recursive: true, force: true }),
  };
}

/** What arrived at the upstream under one header name. */
function arrived(upstream: FakeUpstream, index: number, name: string): string | undefined {
  const raw = upstream.seen[index]?.rawHeaders ?? [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]?.toLowerCase() === name) return raw[i + 1];
  return undefined;
}

test("nothing picked yet means Off, so installing this changes nothing", async () => {
  const bench = await aBench();
  try {
    assert.deepEqual(await readChoice(bench.choiceFile), UNTOUCHED);
    assert.equal((await openPayer({ file: bench.choiceFile, seats: bench.seats }).decide(NO_BODY)).charge, null);
  } finally {
    await bench.forget();
  }
});

test("the Mode and the Payer can be read at any time", async () => {
  const bench = await aBench();
  try {
    const payer = openPayer({ file: bench.choiceFile, seats: bench.seats });
    assert.deepEqual(await payer.now(), { mode: "off", payer: null });

    await pickPayer({ file: bench.choiceFile, among: await bench.seats.list(), name: "side" });
    assert.deepEqual(await payer.now(), { mode: "manual", payer: "side" });

    await turnOff(bench.choiceFile);
    assert.deepEqual(await payer.now(), { mode: "off", payer: "side" }, "Off remembers the pick without using it");
  } finally {
    await bench.forget();
  }
});

test("the choice survives a restart, because it is read from disk and never remembered", async () => {
  const bench = await aBench();
  try {
    await pickPayer({ file: bench.choiceFile, among: await bench.seats.list(), name: "work" });

    // A second Payer, as a restarted relay would build.
    const afterRestart = openPayer({ file: bench.choiceFile, seats: bench.seats });
    const { charge } = await afterRestart.decide(NO_BODY);
    assert.equal(charge?.token, "sk-ant-oat01-work");
    assert.equal(charge?.seat, "work");
    assert.equal(charge?.organizationId, "org-acme");
  } finally {
    await bench.forget();
  }
});

test("picking a Seat with no Send token is refused with a reason, and the previous choice stands", async () => {
  const bench = await aBench();
  try {
    await pickPayer({ file: bench.choiceFile, among: await bench.seats.list(), name: "work" });
    bench.vault.held.delete("side");

    const listed = await bench.seats.list();
    await assert.rejects(
      () => pickPayer({ file: bench.choiceFile, among: listed, name: "side" }),
      /no Send token/,
    );

    assert.deepEqual(await readChoice(bench.choiceFile), { mode: "manual", payer: "work" }, "the old choice stands");
  } finally {
    await bench.forget();
  }
});

test("picking a Seat that does not exist is refused and names what there is", async () => {
  const bench = await aBench();
  try {
    const listed = await bench.seats.list();
    await assert.rejects(
      () => pickPayer({ file: bench.choiceFile, among: listed, name: "nobody" }),
      /work, side/,
    );
    assert.deepEqual(await readChoice(bench.choiceFile), UNTOUCHED);
  } finally {
    await bench.forget();
  }
});

test("setting the Payer takes effect on the next request, with nothing restarted", async () => {
  const bench = await aBench();
  const upstream = await startFakeUpstream(OPEN_HOST);
  const authority = await authorityFor(OPEN_HOST);
  const payer = openPayer({ file: bench.choiceFile, seats: bench.seats });

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    chargeFor: (request) => payer.decide(request),
  });

  const ask = () =>
    requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      headers: [["Authorization", CALLER]],
      body: "{}",
    });

  try {
    // Off: the caller's own credential, untouched. This is what makes Off the
    // same as not having installed the relay.
    await ask();
    assert.equal(arrived(upstream, 0, "authorization"), CALLER);

    await pickPayer({ file: bench.choiceFile, among: await bench.seats.list(), name: "work" });
    await ask();
    assert.equal(arrived(upstream, 1, "authorization"), "Bearer sk-ant-oat01-work");

    await pickPayer({ file: bench.choiceFile, among: await bench.seats.list(), name: "side" });
    await ask();
    assert.equal(arrived(upstream, 2, "authorization"), "Bearer sk-ant-oat01-side");

    // Off again, and the Window account pays once more.
    await turnOff(bench.choiceFile);
    await ask();
    assert.equal(arrived(upstream, 3, "authorization"), CALLER);
  } finally {
    await relay.close();
    await upstream.close();
    await bench.forget();
  }
});

test("in Off mode nothing else about the request changes either", async () => {
  const bench = await aBench();
  const upstream = await startFakeUpstream(OPEN_HOST);
  const authority = await authorityFor(OPEN_HOST);
  const payer = openPayer({ file: bench.choiceFile, seats: bench.seats });

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    chargeFor: (request) => payer.decide(request),
  });

  try {
    await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      headers: [
        ["Authorization", CALLER],
        ["x-api-key", "the-caller-put-this-here"],
        ["anthropic-beta", "oauth-2025-04-20"],
      ],
      body: "{}",
    });

    assert.equal(arrived(upstream, 0, "authorization"), CALLER);
    assert.equal(arrived(upstream, 0, "x-api-key"), "the-caller-put-this-here", "Off must not remove anything either");
    assert.equal(arrived(upstream, 0, "anthropic-beta"), "oauth-2025-04-20");
  } finally {
    await relay.close();
    await upstream.close();
    await bench.forget();
  }
});

test("a Payer that cannot be read says so, rather than reading as Off", async () => {
  const bench = await aBench();
  const problems: string[] = [];
  try {
    // A file that exists and is not JSON. This used to read as Off, so requests
    // went quietly to the Window account with nothing anywhere saying why.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(bench.choiceFile, "{ this is not json");

    const payer = openPayer({
      file: bench.choiceFile,
      seats: bench.seats,
      onProblem: (summary) => problems.push(summary),
    });

    assert.equal((await payer.decide(NO_BODY)).charge, null, "it must still fall back to the Window account");
    assert.equal(problems.length, 1, "but it must not do so silently");
    assert.match(problems[0] ?? "", /could not read who should pay/);
  } finally {
    await bench.forget();
  }
});
