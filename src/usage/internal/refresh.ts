/**
 * Keep what is known about every Seat current, instead of explaining that it is old.
 *
 * A Send token cannot read usage from any endpoint (measured: `/api/oauth/profile`
 * answers 403, the token is inference-only), so the figures only ever arrive
 * attached to a real reply. A Seat sitting idle therefore has no news, and every
 * screen ended up carrying "(2h 27m ago)" beside numbers nobody could act on. A
 * timestamp is not an answer to "how much room is left"; it is an apology for not
 * having one.
 *
 * So this asks. One real request per stale Seat, the cheapest the server sells,
 * and the reply's own headers are folded in exactly as live traffic is. That is
 * not a workaround: the request genuinely is an exchange the Seat paid for, so it
 * is remembered as one rather than as a reading taken on the side.
 *
 * What it costs, stated rather than buried: one Haiku request of about fifteen
 * tokens per stale Seat per round. A Seat is only stale after twenty-five
 * minutes, so each one is asked half-hourly whatever the timer is set to, which
 * is two requests an hour per Seat, and a single token cannot move a percentage
 * point on either window. A Seat that is out of allowance answers 429, which is a true
 * fact about that Seat and is remembered as one.
 *
 * The probe is shaped like a Code session's request or it proves nothing (ADR
 * 0005): without the Claude Code system prompt the server refuses every premium
 * model with a message that reads exactly like an exhausted allowance, and a
 * refresher that did that would report healthy Seats as spent.
 */
import { request } from "node:https";
import type { IncomingMessage } from "node:http";

import { factsFrom } from "../../relay/index.ts";
import type { SeatStore } from "../../seats/index.ts";
import type { SeatUsage } from "./known.ts";
import type { UsageMemory } from "./memory.ts";

const ANTHROPIC = { host: "api.anthropic.com", path: "/v1/messages" };
/** The cheapest thing the server will answer, shaped like Code's own request. */
const MODEL = "claude-haiku-4-5-20251001";
const BODY = JSON.stringify({
  model: MODEL,
  max_tokens: 1,
  system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: "user", content: "hi" }],
});
/** Every wait has a ceiling. A probe that hangs must not hold up the round. */
const AT_MOST_MS = 20_000;
/** At most this many in the air at once, so a round cannot become a burst. */
const AT_A_TIME = 4;

/**
 * How old a reading may be before it is worth a request to replace it.
 *
 * Adjustable, because the right answer depends on how many Seats somebody has and
 * how much they mind the traffic, and because a round that never fires cannot be
 * told from one that fires and finds nothing to do. Setting it to zero asks every
 * Seat every round, which is how the timer itself was proved.
 */
export const STALE_AFTER_SECONDS = Math.max(
  0,
  Number(process.env["RELAY_STALE_MINUTES"] ?? 25) * 60,
);

export type Refreshed = {
  readonly asked: number;
  readonly answered: number;
  readonly failed: number;
  readonly skipped: number;
};

/** The oldest reading for one Seat, or null when there is none at all. */
function oldestReading(usage: SeatUsage | undefined): number | null {
  if (usage === undefined) return null;
  const ages = [usage.sevenDay?.ageSeconds, usage.fiveHour?.ageSeconds].filter(
    (age): age is number => age !== undefined,
  );
  return ages.length === 0 ? null : Math.max(...ages);
}

/** Which Seats are worth asking about. Pure, so the rule is a table in a test. */
export function whichAreStale(options: {
  readonly seats: readonly { readonly name: string; readonly hasSendToken: boolean }[];
  readonly usage: readonly SeatUsage[];
  readonly olderThan: number;
}): readonly string[] {
  return options.seats
    .filter((seat) => {
      if (!seat.hasSendToken) return false;
      const age = oldestReading(options.usage.find((one) => one.seat === seat.name));
      // Never read at all counts as stale: that is the Seat the list has nothing
      // to say about, which is the worst one to be quiet about.
      return age === null || age >= options.olderThan;
    })
    .map((seat) => seat.name);
}

function ask(token: string): Promise<{ status: number; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve) => {
    const outgoing = request(
      {
        host: ANTHROPIC.host,
        path: ANTHROPIC.path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          authorization: `Bearer ${token}`,
          "content-length": Buffer.byteLength(BODY),
        },
      },
      (incoming) => {
        // Drained, because a reply nobody reads holds its socket open and the
        // round would wait on it.
        incoming.resume();
        incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers }));
      },
    );

    const givingUp = setTimeout(() => {
      outgoing.destroy();
      resolve({ status: 0, headers: {} });
    }, AT_MOST_MS);
    const done = () => clearTimeout(givingUp);
    outgoing.once("response", done);
    outgoing.once("error", () => {
      done();
      resolve({ status: 0, headers: {} });
    });
    outgoing.end(BODY);
  });
}

/**
 * Ask every stale Seat what it has spent, and remember the answers.
 *
 * Nothing here throws. A Seat that could not be asked is a fact about that Seat,
 * and a round must not end because one request failed.
 */
export async function refreshStaleSeats(options: {
  readonly seats: SeatStore;
  readonly usage: UsageMemory;
  readonly at: number;
  readonly olderThan?: number;
  /** Told what happened, one line per Seat, for a log or a terminal. */
  readonly say?: (line: string) => void;
}): Promise<Refreshed> {
  const listed = await options.seats.list();
  const known = await options.usage.known(options.at);
  const stale = whichAreStale({
    seats: listed,
    usage: known,
    olderThan: options.olderThan ?? STALE_AFTER_SECONDS,
  });

  const summary = { asked: stale.length, answered: 0, failed: 0, skipped: listed.length - stale.length };
  const queue = [...stale];

  const worker = async () => {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;

      const seat = listed.find((one) => one.name === name);
      if (seat === undefined) continue;

      const token = await options.seats.sendTokenFor(name).catch(() => null);
      if (token === null) {
        summary.failed += 1;
        continue;
      }

      const answered = await ask(token);
      if (answered.status === 0) {
        summary.failed += 1;
        options.say?.(`could not reach the server for ${name}`);
        continue;
      }

      // Folded in as the exchange it is: this Seat's own credential paid for it,
      // and the server named the Organization, so the ordinary rules about what a
      // reply may teach apply unchanged.
      const exchange = factsFrom({
        method: "POST",
        path: ANTHROPIC.path,
        status: answered.status,
        swapped: true,
        chargedTo: { seat: name, organizationId: seat.organization.id },
        about: { model: MODEL, looksLikeCode: true, session: null },
        headers: answered.headers,
      });

      await options.usage.rememberExchange(exchange, Math.trunc(Date.now() / 1000)).catch(() => undefined);
      summary.answered += 1;
    }
  };

  await Promise.all(Array.from({ length: Math.min(AT_A_TIME, queue.length) }, worker));
  return summary;
}
