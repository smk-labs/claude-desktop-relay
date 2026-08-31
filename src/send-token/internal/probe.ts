import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as connectTls } from "node:tls";

import { judge, type Verdict } from "../../verify/index.ts";
import { dialUpstream, routeFrom, type RouteAsked } from "../../relay/index.ts";
import { machineEgress } from "../../window/index.ts";
import type { Seat } from "../../seats/index.ts";

/**
 * How long the whole probe gets: the route, the handshake and the answer.
 *
 * The proxy has a clock of its own inside `dialUpstream`, and nothing else here
 * did. A sitting that hangs on one Seat with a blank screen is worse than one
 * that says the server never answered.
 */
const AT_MOST_MS = 20_000;

/** Where a Probe goes in real use. */
const ANTHROPIC = "https://api.anthropic.com";

/** The one path a Send token is allowed to reach, and the only one that names who paid. */
const MESSAGES = "/v1/messages";

/**
 * The shape of a real Code session's request, which is the only shape that proves
 * anything.
 *
 * The system prompt is not decoration. A request without it is refused for every
 * premium model with a rate-limit error whose message is the word "Error", while
 * the Seat's own reported Utilization sits near zero, so a Probe that left it off
 * would report untouched Seats as spent. See ADR 0005; measured 2026-08-21.
 *
 * The cheapest model and a single token of output, because this is asked once per
 * Seat and its whole job is to make the server name an Organization.
 */
const CLAUDE_CODE = "You are Claude Code, Anthropic's official CLI for Claude.";
const PROBE_MODEL = "claude-haiku-4-5-20251001";
const PROBE_BODY = JSON.stringify({
  model: PROBE_MODEL,
  max_tokens: 1,
  system: [{ type: "text", text: CLAUDE_CODE }],
  messages: [{ role: "user", content: "hi" }],
});

/** What the server needs to accept a Send token at all. Measured, not guessed. */
const OAUTH_BETA = "oauth-2025-04-20";
const API_VERSION = "2023-06-01";

/**
 * Which Seat a Send token actually pays for, judged from the server's own answer.
 *
 * This is the check that matters most in a sitting. `claude setup-token` binds to
 * whichever Organization was active in the browser at the time, so a token minted
 * for the right account and the wrong Organization looks perfect and is wrong,
 * and the only thing that can tell is the Organization the server names on a real
 * reply.
 *
 * The answer is a Verdict, the same one the relay produces for live traffic, so
 * "verified" means exactly one thing across this whole program and a Probe cannot
 * accept a token on terms the relay would not.
 *
 * Nothing here throws. A Probe that could not go out is unproved, which is a
 * fact about that Probe, and a sitting must not end because one request failed.
 */
export async function probeSendToken(options: {
  token: string;
  /** The Seat this token is claimed to belong to. Every caller already holds one. */
  seat: Seat;
  /** Where to send it. Only a test moves this. */
  origin?: string;
  /** The name to ask for in the handshake, when the origin is not that name. */
  servername?: string;
  /** Extra authorities to trust. Only a test needs these. */
  trust?: readonly string[];
  /** How traffic leaves. Unset, it is whatever this machine says. */
  route?: RouteAsked;
}): Promise<Verdict> {
  const where = new URL(options.origin ?? ANTHROPIC);

  const host = where.hostname;
  const port = where.port === "" ? 443 : Number(where.port);
  const route = routeFrom(options.route ?? { egress: machineEgress });

  /**
   * Out the way this machine says, or not at all. ADR 0011.
   *
   * This used to be `node:https` with no agent named, which asks the machine
   * nothing and goes straight out. On a machine whose only way out is a proxy,
   * every probe then failed, and a failed probe is not a quiet failure: the
   * sitting throws away the token it has just minted, because a token it could
   * not prove is a token it will not keep. So a person authorized a mint, watched
   * it succeed, and ended up with nothing, once per Seat.
   */
  const answered = await new Promise<{ status: number; headers: IncomingMessage["headers"] }>((resolve) => {
    let done = false;
    let hangUp = () => {};
    const finish = (answer: { status: number; headers: IncomingMessage["headers"] }) => {
      if (done) return;
      done = true;
      clearTimeout(givingUp);
      hangUp();
      resolve(answer);
    };
    // A status of zero is what `judge` already reads as "the server never
    // answered", so a failure needs no reason of its own invented here.
    const gaveUp = () => finish({ status: 0, headers: {} });
    const givingUp = setTimeout(gaveUp, AT_MOST_MS);

    void (async () => {
      let raw;
      try {
        raw = await dialUpstream(host, port, route, true);
      } catch {
        return gaveUp();
      }
      hangUp = () => raw.destroy();

      const secure = connectTls({
        socket: raw,
        servername: options.servername ?? host,
        ALPNProtocols: ["http/1.1"],
        ...(options.trust === undefined ? {} : { ca: [...options.trust] }),
      });
      hangUp = () => secure.destroy();
      secure.once("error", gaveUp);

      const outgoing = httpRequest({
        host,
        port,
        path: MESSAGES,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": API_VERSION,
          "anthropic-beta": OAUTH_BETA,
          authorization: `Bearer ${options.token}`,
          "content-length": Buffer.byteLength(PROBE_BODY),
        },
        /**
         * No agent at all. Node honours `createConnection` only when there is no
         * agent, and `agent: false` beside one makes Node dial the host itself,
         * straight round the route above.
         */
        createConnection: () => secure,
      });

      outgoing.once("response", (incoming: IncomingMessage) => {
        // Drained, because a reply nobody reads holds the socket open and the
        // flow would sit there waiting on the next Seat.
        incoming.resume();
        incoming.once("end", () => finish({ status: incoming.statusCode ?? 0, headers: incoming.headers }));
      });
      outgoing.once("error", gaveUp);
      outgoing.end(PROBE_BODY);
    })();
  });

  const paidBy = answered.headers["anthropic-organization-id"];

  return judge({
    method: "POST",
    path: MESSAGES,
    status: answered.status,
    refused: answered.status >= 400,
    swapped: true,
    chargedTo: { seat: options.seat.name, organizationId: options.seat.organization.id },
    paidBy: typeof paidBy === "string" ? paidBy : null,
    // A Probe is shaped like a real Code request or it proves nothing (ADR 0005),
    // so it says so rather than leaving a reader to infer it from the body above.
    about: { model: PROBE_MODEL, looksLikeCode: true, session: null },
    utilization: { fiveHour: null, sevenDay: null },
    overage: { status: null, disabledReason: null },
    resets: { fiveHour: null, sevenDay: null },
    replyHeaders: {},
  });
}

/**
 * Whether this Verdict proves the token belongs to the Seat it was probed for.
 *
 * Not the same question as "did the request succeed". The relay's own judgement
 * reaches `verified` only on a success, and rightly so: an answer that is not a
 * success has not shown that this request was served, so as a claim about live
 * traffic it proves nothing. But the question here is narrower and the evidence
 * is different. A Seat that is out of allowance right now still answers with its
 * own Organization, and that is exactly the fact being checked.
 *
 * So a refusal that names the Seat's own Organization proves the binding. ADR
 * 0005 is the same rule from the other side: a Refusal is evidence about one
 * request and never a verdict about a Seat. Reading it as "this token is no
 * good" would refuse a correct token the user had just minted, and would send
 * them round to re-mint a Seat that works.
 *
 * A refusal that names nobody proves nothing, because there is then nothing to
 * compare against, and that is what a dead or revoked token looks like.
 */
export function provesTheSeat(verdict: Verdict): boolean {
  if (verdict.kind === "verified") return true;

  // The one shortfall that still carries proof: the Organizations agreed and
  // only the status did not.
  return verdict.because === "the-answer-was-not-a-success";
}
