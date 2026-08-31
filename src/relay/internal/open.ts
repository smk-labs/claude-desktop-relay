import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectTls, TLSSocket } from "node:tls";
import { once } from "node:events";
import type { Socket } from "node:net";

import { dialUpstream } from "./dial.ts";
import { ESTABLISHED, describeError } from "./wire.ts";
import { factsFrom, NOTHING_READ } from "./exchange.ts";
import { copyHeaders, isMessageEndpoint } from "./swap.ts";
import { holdBody, type HeldBody } from "./body.ts";
import { NOTHING_DECIDED, type Charge, type Wiring } from "./config.ts";
import { openScanner, type TokenCounts } from "../../tokens/index.ts";

export type Opener = {
  /** Terminate TLS on this client connection and serve its requests. */
  take(client: Socket, port: number): void;
  close(): Promise<void>;
};

/**
 * Open a client connection: present our certificate, read the requests in the
 * clear, and forward each one over a fresh TLS connection to the real host.
 *
 * ALPN is pinned to HTTP/1.1 on both sides. Nothing here reimplements HTTP/2
 * framing, and pinning is what makes that safe rather than lucky.
 */
export function startOpener(wiring: Wiring): Opener {
  const ports = new WeakMap<TLSSocket, number>();

  const server = createHttpServer((request, response) => {
    const socket = request.socket;
    const port = socket instanceof TLSSocket ? (ports.get(socket) ?? 443) : 443;
    forward(request, response, port, wiring).catch((error: unknown) => {
      wiring.report({ kind: "open-failed", summary: describeError(error) });
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end();
    });
  });

  /**
   * Node's own request clock, turned off, because this server is the slow party.
   *
   * `requestTimeout` bounds how long a client may take to deliver a whole
   * request, and it defaults to five minutes. A relay that queues holds the
   * request paused on purpose (see `forward`), so a body larger than the stream's
   * high-water mark stays unfinished for exactly as long as the queue is long.
   * Node then destroyed the request as if the client were slow, and because that
   * arrives as `response.destroyed`, the relay could not tell it from a Code
   * session cancelling and reported thousands of its own kills as the caller
   * giving up. Worse, it destroys the whole keep-alive socket, so the other
   * exchanges riding it die too.
   *
   * Two clocks where the hidden one wins is the thing being removed here. The
   * bound below is ours, it is stated, and it is the only one.
   */
  server.requestTimeout = 0;

  return {
    take(client, port) {
      client.write(ESTABLISHED);
      const secure = new TLSSocket(client, {
        isServer: true,
        key: wiring.certificate.key,
        cert: wiring.certificate.cert,
        ALPNProtocols: ["http/1.1"],
      });
      ports.set(secure, port);
      secure.once("error", () => secure.destroy());
      server.emit("connection", secure);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** What came back from one attempt at the upstream. */
type Attempt =
  | {
      readonly kind: "answered";
      readonly status: number;
      readonly headers: IncomingMessage["headers"];
      /**
       * Pipe the reply to the caller, and say what it cost when the last byte has
       * gone. Ends the exchange.
       */
      finish(report: (tokens: TokenCounts | null) => void): void;
      /** Throw this answer away and drain its connection, so it can be sent again. */
      giveUp(): void;
    }
  | {
      readonly kind: "no-answer";
      readonly error: unknown;
      /** Whether we were the ones who closed it, so a guess stays a fact. */
      readonly closedByUs: boolean;
    };

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  wiring: Wiring,
): Promise<void> {
  // Held for the same reason the blind tunnel holds its client: nothing is
  // reading the body until the upstream request exists to pipe it into.
  request.pause();

  const startedAt = performance.now();
  const path = request.url ?? "";
  const method = request.method ?? "";

  /**
   * The outer bound, taken first and held to the last byte.
   *
   * This is the one that says how much the relay may be holding at once:
   * descriptors, and bodies in memory. It is looser than the turn below it
   * because it is answering a different question, and taking it first is what
   * makes the two orderly rather than a deadlock waiting to happen.
   */
  const doneWithExchange = await wiring.exchanges.enter();

  // The turn is taken before anything is dialled, which is the whole point: the
  // connection that would collapse the route is never opened in the first place.
  const waited = wiring.gate.waiting();
  const noLongerBusy = await wiring.gate.enter();
  const queuedFor = Math.round(performance.now() - startedAt);

  /**
   * The turn, handed back exactly once and from wherever this ends.
   *
   * A turn that is never handed back starves everything behind it, and twelve of
   * those wedge the relay for good with nothing in any log to say why.
   *
   * What it covers is the part that can collapse the route: the dial, the
   * request, and the wait for the head of the reply. That wait is the quiet one
   * a proxy cannot tell from a dead tunnel, which is the whole of the 2026-08-22
   * shape, so it is deliberately inside. Once the head is in, bytes are moving
   * and the connection is visibly alive, so the turn goes back and the exchange
   * finishes under the outer bound instead.
   */
  let ceiling: NodeJS.Timeout;
  let handedBack = false;
  const handBack = () => {
    if (handedBack) return;
    handedBack = true;
    noLongerBusy();
  };

  /**
   * Everything given up at once, for the ways an exchange ends before it streams.
   *
   * The turn and the outer bound come back together on every failure path, and
   * apart on exactly one: the good one, where the turn goes back at the head and
   * this waits for the last byte.
   */
  let letGo = false;
  const letEverythingGo = () => {
    handBack();
    if (letGo) return;
    letGo = true;
    clearTimeout(ceiling);
    doneWithExchange();
  };

  /**
   * The turn's own ceiling, and the only thing here that cannot be reasoned past.
   *
   * Every other guard in this file covers a named way an exchange can stall: the
   * proxy not answering, the upstream going silent, the caller hanging up. This
   * one covers the ways nobody has named yet, and on 2026-08-30 there was one: a
   * `scutil --proxy` with no clock of its own, reached from inside this turn, held
   * by a VPN rewriting its routes. Twelve of those took every turn the relay had,
   * and because nothing between here and the close handler below writes a line,
   * the relay served nothing for twenty-three minutes and said nothing at all.
   *
   * It is a backstop and not a reply-time limit, which is worth being plain
   * about: it does end an honest exchange that runs past it. Ten minutes is above
   * three attempts each waiting out the full silence guard, and forty times the
   * measured p90 of a real exchange, so an honest one reaching it is a thing worth
   * hearing about rather than a cost worth paying quietly.
   */
  ceiling = setTimeout(() => {
    wiring.report({
      kind: "open-failed",
      summary:
        `${method} ${path}: still held after ${Math.round(wiring.aTurnMayBeHeld / 1000)}s, ` +
        `so its turn was taken back. Nothing here should reach this: see the ceiling in open.ts.`,
    });
    request.destroy();
    response.destroy();
    letEverythingGo();
  }, wiring.aTurnMayBeHeld);

  /**
   * A caller that gave up while it was queued gets nothing dialled for it.
   *
   * A Code session cancels requests it no longer needs as a matter of course, 62
   * of them in the sitting that produced this file's other lessons. Without this,
   * every one of those still takes a turn, opens a tunnel and waits for a reply
   * nobody is listening for, which is the scarce thing being spent on work that
   * is already pointless.
   */
  if (response.destroyed || response.writableEnded || request.destroyed) {
    wiring.report({
      kind: "caller-went-away",
      summary: `${method} ${path}: the caller gave up while it was queued for ${queuedFor}ms, so nothing was dialled for it.`,
    });
    letEverythingGo();
    return;
  }

  /**
   * The body and the decision come before any dial.
   *
   * Neither needs a connection, and sending the request again on another Seat
   * needs the body to still be here. Dialling first would mean holding a
   * connection open through both.
   */
  let held: HeldBody | null = null;
  let decided = NOTHING_DECIDED;
  const swappable = isMessageEndpoint(path);
  try {
    held = swappable ? await holdBody(request) : null;
    decided = swappable ? await wiring.chargeFor({ method, path, body: held?.body ?? null }) : NOTHING_DECIDED;
  } catch (error) {
    // Nothing in this repository throws here today. That is exactly why it is
    // pinned: whoever decides who pays is the part most likely to grow, and the
    // cost of it throwing once was a turn gone for the life of the process.
    wiring.report({
      kind: "open-failed",
      summary: `${method} ${path}: deciding who pays failed, so nothing was sent: ${describeError(error)}`,
    });
    letEverythingGo();
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end();
    const nothing = factsFrom({
      method,
      path,
      status: 0,
      swapped: false,
      chargedTo: null,
      about: NOTHING_READ,
      headers: {},
    });
    wiring.reportExchange(nothing);
    wiring.reportFinished(nothing, null);
    return;
  }

  const about = decided.about;

  /**
   * Whether this request could be sent a second time at all.
   *
   * Only a body that was read whole. One that outgrew the relay's limit is still
   * arriving from the caller as a stream, and a stream cannot be replayed, so a
   * Refusal on one of those is passed straight through however spent the Seat is.
   * A `GET` with no body can always be sent again.
   */
  const canBeSentAgain = held === null ? !swappable : held.whole;

  /**
   * Whether the caller was still there when this ended.
   *
   * Registered once, not per attempt. A Code session cancels requests it no longer
   * needs, and that arrives here as the reply never finishing; telling it apart
   * from a real failure is the difference between a relay that looks broken and
   * one that is.
   */
  let callerWentAway = false;
  let closing: (() => void) | null = null;
  response.once("close", () => {
    if (!response.writableFinished) {
      callerWentAway = true;
      wiring.report({
        kind: "caller-went-away",
        summary:
          `${method} ${path}: the caller hung up before the reply was finished, ` +
          `after ${Math.round(performance.now() - startedAt)}ms, ${wiring.gate.inFlight() - 1} other exchanges in the air.`,
      });
    }
    letEverythingGo();
    /**
     * Only when it ended badly, so the code says what it means.
     *
     * No test can tell the difference, and that is worth writing down rather than
     * implying otherwise: by this moment a finished request has already released
     * its socket to the pool, and destroying a finished request does nothing. The
     * condition is here because "give up on this connection" is the wrong thing to
     * say about a connection we want kept, not because removing it breaks anything
     * today.
     */
    if (!response.writableFinished) closing?.();
  });

  let charge = decided.charge;
  const refusedBy: string[] = [];

  for (let attempt = 1; ; attempt += 1) {
    const sent = await sendOnce({
      request,
      response,
      port,
      wiring,
      held,
      charge,
      // Only the first attempt may pipe a body that is still arriving. Every later
      // one has a whole body in hand, which is what `canBeSentAgain` guarantees.
      mayPipe: attempt === 1,
      onClosing: (close) => {
        closing = close;
      },
    });

    if (sent.kind === "no-answer") {
      if (!callerWentAway && neverConnected(sent.error)) {
        /**
         * Told apart, because they send a reader to different places.
         *
         * "Could not reach it" is a network or a proxy problem. "It answered
         * nothing" is a connection that was made and then died, which is the
         * congestion signature this file exists for. Now that the connection comes
         * from a pool, the dial failure arrives here as the request's own error
         * rather than as a throw, so the distinction has to be made from the error.
         */
        wiring.report({
          kind: "open-failed",
          summary: `Could not reach ${wiring.openHost}:${port}: ${describeError(sent.error)}`,
        });
      } else if (!callerWentAway) {
        wiring.report({
          kind: "open-failed",
          summary:
            `${method} ${path}: ${wiring.openHost} answered nothing: ${describeError(sent.error)}. ` +
            `Lived ${Math.round(performance.now() - startedAt)}ms, closed by us: ${sent.closedByUs}, ` +
            `attempt ${attempt}, ${wiring.gate.inFlight() - 1} other exchanges in the air, ` +
            `most at once so far ${wiring.gate.mostAtOnce()}, ${wiring.gate.waiting()} waiting for a turn, ` +
            `and this one queued for ${queuedFor}ms behind ${waited}.`,
        });
      }
      letEverythingGo();
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end();
      const nothing = factsFrom({
        method,
        path,
        status: 0,
        swapped: charge !== null,
        chargedTo: chargedTo(charge),
        about,
        headers: {},
      });
      wiring.reportExchange(nothing);
      // Finished too, with nothing counted, so a request that failed leaves a row
      // rather than a gap. A gap in a history reads as work that never happened.
      wiring.reportFinished(nothing, null);
      return;
    }

    const exchange = factsFrom({
      method,
      path,
      status: sent.status,
      swapped: charge !== null,
      chargedTo: chargedTo(charge),
      about,
      headers: sent.headers,
    });

    /**
     * Reported before anything is decided about trying again.
     *
     * The Refusal is what puts that Seat on cooldown, and the cooldown is what
     * stops the next attempt walking into the same wall. Reporting it after the
     * retry decision would have the decision made on figures that do not yet
     * include the thing that just happened.
     */
    wiring.reportExchange(exchange);

    /**
     * One condition, not two. When this was written as a boolean and then checked
     * again for the type's sake, either half could be removed without any test
     * noticing, because the other one caught it.
     */
    const refusedSeat = charge;
    if (
      refusedSeat !== null &&
      exchange.refused &&
      canBeSentAgain &&
      attempt < wiring.atMostAttempts &&
      !callerWentAway
    ) {
      const next = await Promise.resolve(
        wiring.whenRefused(exchange, { method, path, body: held?.body ?? null }),
      ).catch(() => null);
      if (next !== null && next.seat !== refusedSeat.seat) {
        refusedBy.push(`${refusedSeat.seat} answered ${exchange.status}`);
        wiring.report({
          kind: "moved-on",
          summary:
            `${method} ${path}: ${refusedBy.join(", then ")}, so it is being sent again on "${next.seat}". ` +
            `Attempt ${attempt + 1} of ${wiring.atMostAttempts}.`,
        });
        sent.giveUp();
        charge = next;
        continue;
      }
    }

    /**
     * The turn goes back here, one moment before the reply starts moving.
     *
     * This line is the whole of ticket 0017 and it is worth saying why it is
     * safe. The turn exists to keep the machine's proxy from holding more quiet
     * tunnels than it has patience for. Everything quiet has already happened:
     * the dial, the request, and the wait for this head. What follows is bytes
     * arriving, which is the opposite of the shape that collapsed the route.
     *
     * What it buys is the difference between a bound on dials and a bound on
     * conversations. Holding the turn through the body meant twelve replies of
     * about thirty seconds each, which is a ceiling of roughly 1,400 requests an
     * hour: measured on six days of this relay's own log, where every busy hour
     * sat inside a band of 31 to 38 seconds a turn and 14.3% of all requests died
     * waiting for one. The exchange is still bounded, by `wiring.exchanges`, which
     * is what keeps descriptors and held bodies finite.
     */
    handBack();

    // The counts are the last thing to arrive, so this is the only moment a whole
    // row about this exchange exists.
    sent.finish((tokens) => wiring.reportFinished(exchange, tokens));
    return;
  }
}

/**
 * Whether this failure means nothing was ever connected.
 *
 * Node prefixes a connect failure with the word, and the codes are the ones a
 * machine gives when the far end is not there at all.
 */
const NEVER_GOT_THERE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "ETIMEDOUT", "ENOTFOUND"]);

function neverConnected(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (NEVER_GOT_THERE.has(code)) return true;
  return error instanceof Error && error.message.startsWith("connect ");
}

const chargedTo = (charge: Charge | null) =>
  charge === null ? null : { seat: charge.seat, organizationId: charge.organizationId };

/**
 * One attempt at the upstream: dial, send, and wait for the head of the reply.
 *
 * Resolves as soon as the status and headers are in, not when the body is done,
 * so the caller can decide whether to keep this answer or send the request again
 * before a single byte reaches whoever asked.
 */
async function sendOnce(options: {
  request: IncomingMessage;
  response: ServerResponse;
  port: number;
  wiring: Wiring;
  held: HeldBody | null;
  charge: Charge | null;
  mayPipe: boolean;
  onClosing: (close: () => void) => void;
}): Promise<Attempt> {
  const { request, response, port, wiring, held, charge } = options;

  /**
   * The connection comes from the pool, keyed by the Seat that is paying.
   *
   * One exchange used to cost one handshake, and a session with parallel agents is
   * hundreds of them through the machine's proxy. The pool keeps a few warm, on
   * its own agent whose `createConnection` is the relay's dialler, because Node
   * honours a bare `createConnection` only when there is no agent at all and
   * `agent: false` beside one makes it dial the host itself. That was measured on
   * 2026-08-22, by a relay that reached the real Cloudflare in a test, and the
   * chokepoint test is what keeps saying it does not happen.
   */
  let agent;
  try {
    agent = await wiring.pool.forSeat(charge?.seat ?? null, port);
  } catch (error) {
    wiring.report({
      kind: "open-failed",
      summary: `Could not reach ${wiring.openHost}:${port}: ${describeError(error)}`,
    });
    return { kind: "no-answer", error, closedByUs: false };
  }

  const outgoing = httpRequest({
    agent,
    host: wiring.openHost,
    port,
    method: request.method,
    path: request.url,
  });

  const method = request.method ?? "";
  const path = request.url ?? "";

  /**
   * The guard that makes a turn impossible to lose for good.
   *
   * Not a limit on how long a reply may take: it sits far above any honest think
   * time, and above the machine proxy's own patience, so in ordinary life the
   * proxy or the server decides first and this never fires. It is here so that a
   * connection which dies without saying so cannot hold a turn for ever and
   * starve everything behind it.
   */
  outgoing.setTimeout(wiring.silentFor, () => {
    wiring.report({
      // Its own kind, so the wiring can treat it as evidence about the route and
      // free everything else riding it rather than letting each one wait its own
      // three minutes. See the report function in config.ts.
      kind: "upstream-went-silent",
      summary:
        `${method} ${path}: nothing arrived for ${Math.round(wiring.silentFor / 1000)}s, ` +
        `so it was given up on and its turn handed back.`,
    });
    outgoing.destroy(new Error(`nothing arrived for ${wiring.silentFor}ms`));
  });

  /**
   * Given up on, whichever way the exchange ends badly.
   *
   * Destroying the request is what tells the pool this connection is not fit to
   * keep: a reply that was never read to the end cannot be reused, and offering it
   * to the next request would be handing over a connection with half an answer
   * still on it. An exchange that ends cleanly never calls this, and the agent
   * keeps the connection warm.
   *
   * Declared after the request it destroys, rather than before it. It read the
   * other way round first, and was safe only because no await sat between the two.
   */
  let gaveUp = false;
  const giveUp = () => {
    if (gaveUp) return;
    gaveUp = true;
    outgoing.destroy();
  };
  options.onClosing(giveUp);

  copyHeaders(request.rawHeaders, outgoing, charge?.token ?? null);

  const answered = await new Promise<Attempt>((resolve) => {
    let settled = false;
    const settle = (attempt: Attempt) => {
      if (settled) return;
      settled = true;
      resolve(attempt);
    };

    outgoing.once("response", (upstream: IncomingMessage) => {
      settle({
        kind: "answered",
        status: upstream.statusCode ?? 0,
        headers: upstream.headers,
        finish(report) {
          response.writeHead(upstream.statusCode ?? 502, [...upstream.rawHeaders]);

          /**
           * Watched, never transformed.
           *
           * A second listener beside the pipe sees the same chunks; it does not
           * take them. So the reply reaches the caller byte for byte whatever
           * happens in here, and a scanner that threw would cost a count and not
           * a reply. A test drives forty megabytes through and compares.
           */
          const scanner = openScanner();
          upstream.on("data", (chunk: Buffer) => {
            try {
              scanner.take(chunk.toString("utf8"));
            } catch {
              // A count is worth less than the reply it is about.
            }
          });
          const done = () => report(scanner.counts());
          upstream.once("end", done);
          upstream.once("error", done);

          upstream.pipe(response);
        },
        giveUp() {
          /**
           * Drained rather than destroyed, because this answer is being thrown
           * away and the connection is not.
           *
           * A Refusal's body is a few dozen bytes, so reading it to the end costs
           * nothing and leaves the connection fit for the next request on this
           * Seat. Destroying it would throw away a handshake for a reply we had
           * already finished with.
           */
          upstream.resume();
        },
      });
    });

    outgoing.once("error", (error) => {
      const ours = gaveUp;
      giveUp();
      settle({ kind: "no-answer", error, closedByUs: ours });
    });

    if (held === null) {
      if (options.mayPipe) request.pipe(outgoing);
      else outgoing.end();
      return;
    }

    // What was read is written on first, in the order it arrived. A body that was
    // read whole ends the request here; one that outgrew the limit lets the rest
    // of the stream follow, so the upstream sees the same bytes either way.
    for (const chunk of held.readSoFar) outgoing.write(chunk);
    if (held.whole) outgoing.end();
    else if (options.mayPipe) request.pipe(outgoing);
    else outgoing.end();
  });

  return answered;
}
