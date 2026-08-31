/**
 * The relay: a local CONNECT proxy that Claude Desktop's Code sessions are
 * pointed at.
 *
 * One host is opened for inspection and every other host is tunnelled blind, so
 * the relay sees Code's traffic and nothing else. It chains to whatever proxy the
 * machine already uses, so egress is unchanged, and it says so plainly when that
 * proxy is named but not listening.
 *
 * Start it, and close it when you are done. Everything else is inside.
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";

import { wiringFrom, type RelayConfig } from "./internal/config.ts";
import { startOpener } from "./internal/open.ts";
import { tunnelBlind } from "./internal/tunnel.ts";

export type { RelayConfig, RelayNotice, RequestShape, Charge, Decision, Egress } from "./internal/config.ts";
export { NOTHING_DECIDED, AT_MOST_ATTEMPTS, AT_MOST_EXCHANGES, A_TURN_MAY_BE_HELD } from "./internal/config.ts";
export type { Exchange, RequestFacts } from "./internal/exchange.ts";
export type { TokenCounts } from "../tokens/index.ts";
export { isRefusal, NOTHING_READ } from "./internal/exchange.ts";
/**
 * Reading the facts off a reply is part of the interface.
 *
 * Anything that pays with a Seat's own credential and gets an answer back has
 * learned exactly what live traffic teaches, and it must be remembered the same
 * way. The refresher is the only caller today: without this it would either reach
 * into this module's internals or keep a second, drifting copy of the header names.
 */
export { factsFrom } from "./internal/exchange.ts";
/**
 * How traffic leaves this machine, and the one function allowed to act on it.
 *
 * On the interface because the relay is not the only thing in this program that
 * sends a Seat's credential to Anthropic. The background usage refresher does
 * too, and until 2026-08-30 it dialled the host itself: no proxy, no agent, no
 * question asked, straight past whatever route the machine had named. ADR 0011
 * says a Seat's credential never leaves except the way the machine would, and a
 * rule that lives inside one module is a rule the module next door does not have.
 *
 * So the dialler is exported rather than copied. Anything carrying a Seat's
 * credential calls this with `carryingASeat` true, and gets the refusal for free
 * rather than having to remember it.
 */
export type { Route, RouteAsked } from "./internal/dial.ts";
export { dialUpstream, routeFrom } from "./internal/dial.ts";
/**
 * Part of the interface, not a convenience: anything that speaks CONNECT to the
 * relay has to read the relay's answer off a raw socket without destroying it,
 * and doing that with `for await` silently drops the bytes that follow. Hiding
 * that trap in one place is the whole point of a module.
 */
export { readHead } from "./internal/head.ts";
/**
 * How many exchanges may be in the air at once, and the queue for the rest.
 *
 * On the interface because the bound is part of what the relay promises now, not
 * an implementation detail: it is the thing standing between a burst and the
 * collapse of 2026-08-22, and it is worth being able to test on its own.
 */
export type { Gate } from "./internal/gate.ts";
export { openGate, AT_MOST_IN_FLIGHT } from "./internal/gate.ts";
export type { Head } from "./internal/head.ts";
/**
 * Connections to the opened host, kept warm and reused, and the bound on how long
 * one may sit idle. On the interface because that bound is the whole safety of
 * reusing anything: see `internal/pool.ts`.
 */
export type { Pool } from "./internal/pool.ts";
export { IDLE_FOR_AT_MOST_MS } from "./internal/pool.ts";

/**
 * How often the bound itself is looked at.
 *
 * Two seconds: long enough that an ordinary burst filling the gate for a moment
 * says nothing, short enough that a wedge is named while somebody is still
 * watching the screen it happened on.
 */
const HOW_OFTEN_THE_BOUND_IS_WATCHED = 2_000;

export type RunningRelay = {
  readonly address: { readonly host: string; readonly port: number };
  close(): Promise<void>;
};

const ONLY_CONNECT =
  "HTTP/1.1 405 Method Not Allowed\r\n" +
  "content-type: text/plain\r\n" +
  "content-length: 34\r\n" +
  "connection: close\r\n\r\n" +
  "relay: this proxy speaks CONNECT\r\n";

export async function startRelay(config: RelayConfig): Promise<RunningRelay> {
  const tunnels = new Set<Socket>();

  const server: Server = createServer((request, response) => {
    // A proxy client only ever sends CONNECT here, so a plain request is a person
    // with a browser. They get the page when there is one, and the old sentence
    // when there is not.
    if (config.onPlainRequest !== undefined) config.onPlainRequest(request, response);
    else response.socket?.end(ONLY_CONNECT);
  });

  // Listening first, so the relay knows its own address before anything decides
  // where to send bytes. Without that, a machine whose proxy setting happens to
  // name this relay would have it dialling itself for every request.
  const wanted = config.listen?.port ?? 0;
  server.listen(wanted, config.listen?.host ?? "127.0.0.1");

  // A service that keeps restarting on a port somebody else holds would otherwise
  // fill its log with a bare EADDRINUSE and no idea what to do about it.
  await once(server, "listening").catch((error: unknown) => {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code !== "EADDRINUSE") throw error;
    throw new Error(
      `port ${wanted} is already taken, so the relay cannot listen where the app has been told to find it. ` +
        `Find what holds it with "lsof -nP -iTCP:${wanted} -sTCP:LISTEN", then stop that or choose another port.`,
    );
  });
  const { address, port } = server.address() as AddressInfo;

  const wiring = wiringFrom(config, { host: address, port });
  const opener = startOpener(wiring);

  /**
   * The one thing that watches the bound instead of the traffic.
   *
   * A gate at its limit with a queue behind it is not an error, so no error path
   * reports it, and that is precisely why it went unseen: the relay's figures for
   * how many are in the air and how many are waiting appear only inside failure
   * messages, and a full gate produces no failures. Six days of logs held 3,414
   * requests that died waiting and not one line saying the queue was the reason.
   *
   * Said only on the way in and out of the state, not every tick, because a relay
   * that is busy for a minute is working and a log that repeats itself is a log
   * nobody reads.
   */
  let wasFull = false;
  const watch = setInterval(() => {
    const full = wiring.gate.inFlight() >= wiring.gate.limit() && wiring.gate.waiting() > 0;
    if (full === wasFull) return;
    wasFull = full;
    wiring.report({
      kind: "gate-is-full",
      summary: full
        ? `Every one of the ${wiring.gate.limit()} turns is taken and ${wiring.gate.waiting()} are waiting. ` +
          `Nothing new is being sent until one comes back.`
        : `A turn came back. ${wiring.gate.inFlight()} of ${wiring.gate.limit()} in the air, ${wiring.gate.waiting()} waiting.`,
    });
  }, HOW_OFTEN_THE_BOUND_IS_WATCHED);
  // Never the reason a process stays up: this watches work, it is not work.
  watch.unref();

  server.on("connect", (request, client: Socket, head: Buffer) => {
    const { host, port } = splitTarget(request.url ?? "");
    if (head.length > 0) client.unshift(head);

    tunnels.add(client);
    client.once("close", () => tunnels.delete(client));
    // Heard now, before any await. An unheard 'error' on a client socket is an
    // uncaught exception, and a proxy sees resets as a matter of course.
    client.once("error", () => client.destroy());

    if (host === wiring.openHost) opener.take(client, port);
    else void tunnelBlind(client, host, port, wiring);
  });

  return {
    address: { host: address, port },
    async close() {
      // Tunnels are long-lived by nature, so closing has to hang up on them.
      // `server.close` on its own waits for every connection to end, which for a
      // proxy means waiting forever.
      clearInterval(watch);
      for (const socket of tunnels) socket.destroy();
      tunnels.clear();
      server.closeAllConnections();
      // Anything still queued is let go, or closing would wait on turns that are
      // never coming, and every warm connection is closed: an agent holding an
      // idle socket keeps the process alive for as long as it holds it.
      wiring.gate.release();
      wiring.pool.close();
      await opener.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Split a CONNECT target into host and port. A bracketed IPv6 literal keeps its
 * brackets in the host, and a port that is not a number is treated as absent
 * rather than becoming NaN further down.
 */
function splitTarget(target: string): { host: string; port: number } {
  const bracket = target.lastIndexOf("]");
  const colon = target.lastIndexOf(":");
  const hasPort = colon > bracket;

  const host = hasPort ? target.slice(0, colon) : target;
  const port = hasPort ? Number(target.slice(colon + 1)) : 443;

  return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 443 };
}
