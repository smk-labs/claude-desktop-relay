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
import { request as httpRequest } from "node:http";
import { connect as connectTls } from "node:tls";
import type { IncomingMessage } from "node:http";

import { dialUpstream, factsFrom, routeFrom, type Route, type RouteAsked } from "../../relay/index.ts";
import type { SeatStore } from "../../seats/index.ts";
import type { SeatUsage } from "./known.ts";
import type { UsageMemory } from "./memory.ts";

const ANTHROPIC = { host: "api.anthropic.com", port: 443, path: "/v1/messages" };
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

/**
 * How a round is told to reach the server.
 *
 * A `RouteAsked` and one extra. `trust` is only ever set by a test, and it is the
 * same seam `RelayConfig.trust` is: without it there is no way to stand a fake
 * where Anthropic is, and the route claim below could only be argued rather than
 * proved.
 */
export type RefreshRoute = RouteAsked & { readonly trust?: readonly string[] };

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

/**
 * What one probe came back with, and the three ways it can end.
 *
 * `not-sent` is its own answer rather than another kind of failure. "The machine
 * names a way out we could not use, so nothing was sent" and "it went out and the
 * server said nothing" are different facts about different things, and a round
 * that reports them as one number sends whoever reads it to the wrong place.
 */
type Answer =
  | { readonly kind: "answered"; readonly status: number; readonly headers: IncomingMessage["headers"] }
  | { readonly kind: "not-sent"; readonly why: string }
  | { readonly kind: "no-answer"; readonly why: string };

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One probe, out by whatever way this machine says traffic leaves.
 *
 * Every byte here goes through `dialUpstream`, with `carryingASeat` true, which
 * is the whole of the fix this function exists in. It used to call `request` from
 * `node:https` with no agent and no proxy, so a Seat's Send token went straight
 * out of the machine whatever the machine's proxy settings said. On a laptop
 * running a VPN in tunnel mode that is invisible, because the traffic is inside
 * the tunnel at the IP layer regardless; on a machine whose only route out is the
 * configured proxy, the credential went round it. Found 2026-08-30, and the same
 * thing ADR 0011 and `carryingASeat` were written to stop.
 *
 * TLS is terminated here rather than by `node:https` because the socket that
 * comes back may already have travelled through a CONNECT tunnel or a SOCKS
 * handshake, and wrapping it is the only way to keep exactly one handshake.
 */
function ask(options: { token: string; route: Route; trust: readonly string[] | null }): Promise<Answer> {
  return new Promise((resolve) => {
    let settled = false;
    let reached = false;
    let hangUp: (() => void) | null = null;

    const finish = (answer: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(givingUp);
      // Hung up on however it ended, including well. Without an agent there is no
      // connection to keep, so by the time an answer is in, the socket's only
      // remaining job is to hold the process open.
      hangUp?.();
      resolve(answer);
    };

    /**
     * The ceiling now covers the dial as well as the reply.
     *
     * It used to start at the request and so timed only the half that was already
     * bounded. Reaching the machine's proxy, opening its tunnel and finishing a
     * handshake all happen before a single header is written, and none of that had
     * a clock of its own beyond the proxy's own eight seconds.
     */
    const givingUp = setTimeout(() => {
      finish(
        reached
          ? { kind: "no-answer", why: `nothing arrived within ${AT_MOST_MS}ms` }
          : { kind: "not-sent", why: `the route did not open within ${AT_MOST_MS}ms` },
      );
    }, AT_MOST_MS);

    void (async () => {
      let raw;
      try {
        raw = await dialUpstream(ANTHROPIC.host, ANTHROPIC.port, options.route, true);
      } catch (error) {
        // The route refused, or was not there. Nothing left this machine, which
        // is the point: `dialUpstream` has already reported it the way the relay
        // reports it, through this route's own `report`.
        return finish({ kind: "not-sent", why: describeError(error) });
      }
      reached = true;
      hangUp = () => raw.destroy();

      try {
        const secure = connectTls({
          socket: raw,
          servername: ANTHROPIC.host,
          ALPNProtocols: ["http/1.1"],
          ...(options.trust === null ? {} : { ca: [...options.trust] }),
        });
        secure.setNoDelay(true);
        hangUp = () => secure.destroy();
        secure.once("error", (error) => finish({ kind: "no-answer", why: describeError(error) }));

        const outgoing = httpRequest({
          host: ANTHROPIC.host,
          port: ANTHROPIC.port,
          path: ANTHROPIC.path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
            authorization: `Bearer ${options.token}`,
            "content-length": Buffer.byteLength(BODY),
          },
          /**
           * No agent at all, and the two words are load-bearing.
           *
           * Node honours `createConnection` only when there is no agent; setting
           * `agent: false` beside one makes Node build an agent and dial the host
           * itself, straight round everything above. That was measured in the
           * relay on 2026-08-22, where it reached the real Cloudflare from a test.
           * The negative control in `test/refresh-through-the-machines-route.test.ts`
           * is what keeps saying it does not happen here.
           */
          createConnection: () => secure,
        });

        outgoing.once("response", (incoming: IncomingMessage) => {
          // Drained, because a reply nobody reads holds its socket open and the
          // round would wait on it.
          incoming.resume();
          incoming.once("end", () =>
            finish({ kind: "answered", status: incoming.statusCode ?? 0, headers: incoming.headers }),
          );
        });
        outgoing.once("error", (error) => finish({ kind: "no-answer", why: describeError(error) }));
        outgoing.end(BODY);
      } catch (error) {
        finish({ kind: "no-answer", why: describeError(error) });
      }
    })();
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
  /**
   * How traffic leaves this machine, and it has no default on purpose.
   *
   * Required, so that a caller cannot get "straight out" by saying nothing. That
   * is exactly how this function spent its life sending Send tokens past the
   * machine's proxy: not by anybody deciding to, but by nobody being asked. Every
   * caller already knows the answer; the relay in the same process is using it.
   */
  readonly route: RefreshRoute;
  /** Told what happened, one line per Seat, for a log or a terminal. */
  readonly say?: (line: string) => void;
}): Promise<Refreshed> {
  const route = routeFrom(options.route);
  const trust = options.route.trust ?? null;
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

      const answered = await ask({ token, route, trust });
      if (answered.kind !== "answered") {
        summary.failed += 1;
        options.say?.(
          answered.kind === "not-sent"
            ? // Said as a refusal rather than as a failure, because that is what it
              // is. Nothing was sent, and the Seat is not the thing that is wrong.
              `${name} was not asked, because a Seat's credential does not go round ` +
              `the route this machine names: ${answered.why}`
            : `could not reach the server for ${name}: ${answered.why}`,
        );
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
