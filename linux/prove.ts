/**
 * Prove the swap on this machine, from the server's own answer.
 *
 *   node linux/prove.ts            every Seat, then the negative controls
 *   node linux/prove.ts <seat>...  only those Seats
 *
 * Real requests to the real upstream, through the relay that is actually running,
 * using the same client the test suite drives the relay with. Nothing here reads
 * our own logs to decide whether it worked: the claim is settled by
 * `anthropic-organization-id` on the reply, which is the only thing that cannot
 * be wrong about who paid. The relay's own verdict is read afterwards, and only
 * to check that it agrees.
 *
 * The caller's own credential is deliberately a dummy. A test that sends a real
 * token and gets a real answer proves nothing about the swap, because the answer
 * is the same whether the relay replaced the credential or passed it through. A
 * dummy makes the two outcomes different: swapped means 200 and a named
 * Organization, not swapped means 401.
 */
import { readFile } from "node:fs/promises";

import { requestThrough } from "../test/helpers/through-the-relay.ts";
import { openSeatStore } from "../src/seats/index.ts";
import { openVerdictLog } from "../src/verify/index.ts";
import { readChoice, turnOff, writeChoice } from "../src/payer/index.ts";
import { fileVault } from "./internal/file-vault.ts";
import { linuxHome, vaultFile } from "./internal/where.ts";

const OPEN_HOST = "api.anthropic.com";
const NOT_A_REAL_TOKEN = "sk-ant-oat01-this-credential-is-deliberately-worthless";
/** Every wait has a ceiling. A request that hangs is a failure, not a longer test. */
const AT_MOST_MS = 90_000;

const home = linuxHome();
const seats = openSeatStore({ file: home.seatsFile, vault: fileVault(vaultFile(home)) });
const say = (line = "") => process.stdout.write(`${line}\n`);

/** A body shaped exactly like a Code session's, which is the only shape that proves anything. */
const aCodeRequest = (session: string) =>
  JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1,
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    metadata: { user_id: JSON.stringify({ session_id: session }) },
    messages: [{ role: "user", content: "hi" }],
  });

async function ask(options: { token: string; session: string }) {
  return requestThrough({
    relay: { host: "127.0.0.1", port: home.port },
    host: OPEN_HOST,
    port: 443,
    trust: await readFile(`${home.certificateFolder}/ca.crt`, "utf8"),
    path: "/v1/messages",
    method: "POST",
    headers: [
      ["content-type", "application/json"],
      ["anthropic-version", "2023-06-01"],
      ["anthropic-beta", "oauth-2025-04-20"],
      ["authorization", `Bearer ${options.token}`],
    ],
    body: aCodeRequest(options.session),
    hangUpAfterMs: AT_MOST_MS,
  });
}

const one = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const wanted = process.argv.slice(2);
const listed = (await seats.list()).filter((seat) => seat.hasSendToken);
const chosen = wanted.length === 0 ? listed : listed.filter((seat) => wanted.includes(seat.name));
const before = await readChoice(home.choiceFile);

let right = 0;
let wrong = 0;

say(`Through the relay on 127.0.0.1:${home.port}, ${chosen.length} Seats, one real request each.`);
say(`The caller's own credential is worthless every time, so a 200 can only be the relay's.`);
say();

for (const seat of chosen) {
  // In force now: the relay reads the choice again for every request it swaps.
  await writeChoice(home.choiceFile, { mode: "manual", payer: seat.name });

  const answer = await ask({ token: NOT_A_REAL_TOKEN, session: `prove-${seat.name}` }).catch((error: unknown) => ({
    status: 0,
    headers: {} as Record<string, string | undefined>,
    body: error instanceof Error ? error.message : String(error),
  }));

  const paidBy = one(answer.headers, "anthropic-organization-id") ?? null;
  /**
   * The swap is proved by the Organization, not by the status.
   *
   * A Seat with nothing left answers 429, and it answers it *as that Seat*: the
   * Organization header is there and it is the right one. Calling that a failed
   * swap would be reading a spent allowance as a broken mechanism, which is the
   * one confusion this whole program exists to prevent. So the question asked
   * here is only ever "did the Organization we chose answer", and a Refusal from
   * the right Organization is said out loud as what it is.
   */
  const swapped = paidBy !== null && paidBy === seat.organization.id;
  const spent = swapped && answer.status === 429;
  if (swapped) right += 1;
  else wrong += 1;

  const room = [
    one(answer.headers, "anthropic-ratelimit-unified-5h-utilization"),
    one(answer.headers, "anthropic-ratelimit-unified-7d-utilization"),
  ];

  say(
    `${swapped ? (spent ? "spent" : "paid ") : "WRONG"}  ${seat.name.padEnd(30)} ${String(answer.status).padEnd(4)} ` +
      `server says ${paidBy ?? "nobody"}${swapped ? "" : `, we chose ${seat.organization.id}`}` +
      (room[0] === undefined ? "" : `   5h ${room[0]}  7d ${room[1]}`) +
      (spent ? `   refused: this Seat has no weekly allowance left` : ""),
  );
}

say();
say(`--- the negative controls: with the relay off, nothing of ours may touch the request ---`);

await turnOff(home.choiceFile);

// One: the same worthless credential must now reach the server and be refused. A
// 200 here would mean "off" still swapped, which is the failure this rules out.
const untouched = await ask({ token: NOT_A_REAL_TOKEN, session: "prove-off-dummy" }).catch(() => null);
const offRefuses = untouched !== null && untouched.status === 401;
say(
  `${offRefuses ? "ok   " : "WRONG"}  off, worthless credential          ${untouched?.status ?? "no answer"}  ` +
    `${offRefuses ? "refused, so nothing was swapped in" : "this should have been 401"}`,
);

// Two: a real credential must reach the Organization it belongs to and no other.
// This is the shape a Code session has when the Window account is paying.
const first = chosen[0];
let offPassesThrough = false;
if (first !== undefined) {
  const asItself = await ask({ token: await seats.sendTokenFor(first.name), session: "prove-off-real" }).catch(
    () => null,
  );
  const paidBy = asItself === null ? null : one(asItself.headers, "anthropic-organization-id");
  offPassesThrough = asItself?.status === 200 && paidBy === first.organization.id;
  say(
    `${offPassesThrough ? "ok   " : "WRONG"}  off, ${first.name}'s own credential${" ".repeat(Math.max(1, 12 - first.name.length))}` +
      `${asItself?.status ?? "no answer"}  server says ${paidBy ?? "nobody"}, which is its own Organization`,
  );
}

// And the relay's own verdict, read last and only to check it agrees with the
// server rather than to stand in for it.
const verdict = await openVerdictLog({ file: home.verdictFile }).last();
say();
say(`The relay's own last verdict: ${verdict === null ? "none" : `${verdict.kind}, ${verdict.seat ?? "nobody"}`}`);

await writeChoice(home.choiceFile, before);
say(`The Mode is back to ${before.mode}${before.payer === null ? "" : `, ${before.payer}`}.`);
say();
say(
  `${right} of ${chosen.length} Seats were charged the Organization we chose. ` +
    `${wrong === 0 ? "None went elsewhere." : `${wrong} did not, which is the mechanism failing rather than an allowance running out.`}`,
);

process.exitCode = wrong === 0 && offRefuses && offPassesThrough ? 0 : 1;
