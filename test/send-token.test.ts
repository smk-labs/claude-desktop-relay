import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { looksLikeASendToken, mintFor, probeSendToken, provesTheSeat } from "../src/send-token/index.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";
import type { Seat } from "../src/seats/index.ts";
import { forgetAuthorities } from "./helpers/authorities.ts";

const HOST = "api.anthropic.com";
const ACME = "a1b2c3d4-0000-4000-8000-000000000001";
const SOMEBODY_ELSE = "b2c3d4e5-0000-4000-8000-000000000002";
const A_TOKEN = "sk-ant-oat01-pretend-this-was-just-minted";

after(forgetAuthorities);

/** A Seat, so the tests hand the Probe the same thing every real caller does. */
function aSeat(name: string, organizationId: string): Seat {
  return {
    name,
    account: `${name}@example.com`,
    organization: { id: organizationId, label: "Acme" },
    multiplier: 6.25,
  };
}

/** Drive a real Probe at a local server holding our own certificate. */
async function probeAgainst(upstream: FakeUpstream, seat: Seat, token = A_TOKEN) {
  return probeSendToken({
    token,
    seat,
    origin: `https://127.0.0.1:${upstream.port}`,
    servername: HOST,
    trust: [upstream.authority],
  });
}

/** What one raw header arrived as, or null. */
function headerIn(raw: readonly string[], name: string): string | null {
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if ((raw[i] as string).toLowerCase() === name) return raw[i + 1] as string;
  }
  return null;
}

test("a Probe accepts a token when the server names the Seat's own Organization", async () => {
  const upstream = await startFakeUpstream(HOST);
  try {
    upstream.reply = { status: 200, headers: { "anthropic-organization-id": ACME }, parts: ["{}"] };

    const verdict = await probeAgainst(upstream, aSeat("ana-acme-a1b2", ACME));

    assert.equal(verdict.kind, "verified");
    assert.equal(verdict.paidBy, ACME);
    assert.equal(verdict.seat, "ana-acme-a1b2");
  } finally {
    await upstream.close();
  }
});

/**
 * The mistake this whole flow exists to catch. A Send token binds to whichever
 * Organization was active in the browser at the time, so minting for the right
 * account and the wrong Organization is the likeliest thing to go wrong in a
 * sitting, and nothing but the server's own answer can tell.
 */
test("a Probe refuses a token minted against the wrong Organization, and says which paid", async () => {
  const upstream = await startFakeUpstream(HOST);
  try {
    upstream.reply = { status: 200, headers: { "anthropic-organization-id": SOMEBODY_ELSE }, parts: ["{}"] };

    const verdict = await probeAgainst(upstream, aSeat("ana-acme-a1b2", ACME));

    assert.equal(verdict.kind, "mismatch");
    assert.equal(verdict.paidBy, SOMEBODY_ELSE);
    assert.equal(verdict.expected, ACME);
  } finally {
    await upstream.close();
  }
});

/**
 * ADR 0005. A request without the Claude Code system prompt is refused for every
 * premium model with a message that reads like a spent allowance, so a Probe that
 * left it off would report Seats as exhausted that are untouched.
 */
test("every Probe carries the Claude Code system prompt, or it proves nothing", async () => {
  const upstream = await startFakeUpstream(HOST);
  try {
    upstream.reply = { status: 200, headers: { "anthropic-organization-id": ACME }, parts: ["{}"] };
    await probeAgainst(upstream, aSeat("a-seat", ACME));

    const sent = upstream.seen[0];
    assert.equal(sent?.method, "POST");
    assert.equal(sent?.url, "/v1/messages");
    assert.match(sent?.body ?? "", /You are Claude Code/);
  } finally {
    await upstream.close();
  }
});

test("a Probe presents the Send token the way the server accepts one, and nothing else", async () => {
  const upstream = await startFakeUpstream(HOST);
  try {
    upstream.reply = { status: 200, headers: { "anthropic-organization-id": ACME }, parts: ["{}"] };
    await probeAgainst(upstream, aSeat("a-seat", ACME));

    const raw = upstream.seen[0]?.rawHeaders ?? [];
    assert.equal(headerIn(raw, "authorization"), `Bearer ${A_TOKEN}`);
    assert.equal(headerIn(raw, "anthropic-beta"), "oauth-2025-04-20");
    assert.equal(headerIn(raw, "anthropic-version"), "2023-06-01");
    assert.equal(headerIn(raw, "x-api-key"), null, "a competing credential could decide who pays");
  } finally {
    await upstream.close();
  }
});

test("a server that refuses the token is unproved with a reason, not an accepted Seat", async () => {
  const upstream = await startFakeUpstream(HOST);
  try {
    upstream.reply = { status: 401, parts: ['{"error":"nope"}'] };

    const verdict = await probeAgainst(upstream, aSeat("a-seat", ACME));

    assert.equal(verdict.kind, "unverified");
    assert.equal(verdict.refused, true);
    assert.equal(verdict.status, 401);
  } finally {
    await upstream.close();
  }
});

test("a server that cannot be reached at all is unproved, and never throws at the flow", async () => {
  const verdict = await probeSendToken({
    token: A_TOKEN,
    seat: aSeat("a-seat", ACME),
    // Nothing is listening here, which is what a Probe sent with the network
    // down looks like. A sitting must not end because one Probe could not go out.
    origin: "https://127.0.0.1:1",
    servername: HOST,
  });

  assert.equal(verdict.kind, "unverified");
  assert.equal(verdict.status, 0);
});

test("nothing a Probe reports back carries the Send token", async () => {
  const upstream = await startFakeUpstream(HOST);
  try {
    upstream.reply = { status: 200, headers: { "anthropic-organization-id": ACME }, parts: ["{}"] };
    const verdict = await probeAgainst(upstream, aSeat("a-seat", ACME));

    assert.doesNotMatch(JSON.stringify(verdict), /sk-ant/);
  } finally {
    await upstream.close();
  }
});

test("minting happens under a folder of ours, so the machine's own Claude Code login is untouched", () => {
  // With a space in it on purpose, and built with this machine's own separator,
  // because the claim below is that the folder survives being pasted into a shell.
  // Under the user's own home, which is where this program's home really is,
  // and with a space in it on purpose. Not the temporary folder: Windows gives
  // that one a short name with a tilde in it, and a tilde is the one character
  // this test exists to say must not be in the line.
  const under = join(homedir(), "a home of ours");
  const mint = mintFor({ under, seat: "ana-acme-a1b2" });

  assert.match(mint.command, /CLAUDE_CONFIG_DIR/);
  assert.match(mint.command, /claude setup-token/);
  assert.ok(
    mint.command.includes(`"${mint.folder}"`),
    `a folder with a space in it has to survive being pasted into a shell: ${mint.command}`,
  );
  assert.ok(mint.folder.startsWith(under + sep), "everything of ours lives under our own folder");
  assert.doesNotMatch(mint.command, /~/, "a tilde would land in a different place depending on who reads it");
});

test("a Send token is told apart from the other credentials that could be pasted by mistake", () => {
  assert.equal(looksLikeASendToken("sk-ant-oat01-abcdefghijklmnop"), true);
  assert.equal(looksLikeASendToken("  sk-ant-oat01-abcdefghijklmnop\n"), true, "pasted text carries whitespace");
  // A Stats login can read and never sends, so accepting one here would store a
  // credential that can never pay and only fail at the next real request.
  assert.equal(looksLikeASendToken("sk-ant-sid01-abcdefghijklmnop"), false);
  assert.equal(looksLikeASendToken("sk-ant-api03-abcdefghijklmnop"), false);
  assert.equal(looksLikeASendToken(""), false);
  assert.equal(looksLikeASendToken("sk-ant-oat01-"), false, "a prefix with nothing after it is not a token");
});

/**
 * ADR 0005, applied to accepting a token rather than to judging traffic.
 *
 * A Seat that is out of allowance right now still answers with its own
 * Organization, and that answer is exactly the thing being checked: whether this
 * token pays for the Seat being filled. Reading the refusal as "this token is no
 * good" would refuse a perfectly correct token and send the user round the whole
 * mint again, and would report a working Seat as needing one.
 */
test("a token is proved by the Organization the server names, even when that request was declined", async () => {
  const upstream = await startFakeUpstream(HOST);
  try {
    upstream.reply = { status: 429, headers: { "anthropic-organization-id": ACME }, parts: ["{}"] };

    const verdict = await probeAgainst(upstream, aSeat("ana-acme-a1b2", ACME));

    assert.equal(verdict.refused, true);
    assert.equal(verdict.paidBy, ACME);
    assert.equal(provesTheSeat(verdict), true, "the server named this Seat's own Organization");
  } finally {
    await upstream.close();
  }
});

test("a token is not proved when the server names somebody else, or names nobody at all", async () => {
  const upstream = await startFakeUpstream(HOST);
  try {
    upstream.reply = { status: 429, headers: { "anthropic-organization-id": SOMEBODY_ELSE }, parts: ["{}"] };
    assert.equal(
      provesTheSeat(await probeAgainst(upstream, aSeat("a-seat", ACME))),
      false,
      "a refusal from the wrong Organization is still the wrong Organization",
    );

    // A dead or revoked token: the server declines and names nobody, so there is
    // nothing to check against and the Seat cannot be called filled.
    upstream.reply = { status: 401, parts: ["{}"] };
    assert.equal(provesTheSeat(await probeAgainst(upstream, aSeat("a-seat", ACME))), false);
  } finally {
    await upstream.close();
  }
});
