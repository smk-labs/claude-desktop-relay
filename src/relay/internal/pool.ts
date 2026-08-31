import { Agent, type ClientRequest, type ClientRequestArgs } from "node:http";
import { connect as connectTls, TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import { dialUpstream } from "./dial.ts";
import type { Egress, Wiring } from "./config.ts";

/**
 * How long a connection may sit unused before it is closed.
 *
 * Five seconds against a machine proxy measured to hang up on a quiet tunnel at
 * about fifteen (2026-08-22). That margin is the whole safety of reusing anything:
 * a connection the proxy killed while it sat idle is a request that fails for no
 * reason the user did anything about, and the cure is never to have offered it.
 *
 * A third of the proxy's patience, not nine tenths of it, because the number
 * fifteen is one measurement of one proxy and the next one may be less patient.
 */
export const IDLE_FOR_AT_MOST_MS = 5_000;

/*
 * How many idle connections are kept per Seat: as many as may be in the air.
 *
 * It was four, and four is what a pool wants once the work has stopped: a session
 * that has finished should not hold twelve tunnels open through the machine's
 * proxy waiting for work that is not coming. The idle bound above does that job
 * now, and it does it on a clock rather than on a count, which is the difference.
 *
 * Any number below the gate's limit makes the pool fight itself under exactly the
 * load it exists for. Node destroys a free socket the instant there is one too
 * many of them, and during a burst a socket becomes free a moment before the next
 * queued request asks for one. Whether those two land in the same tick is a
 * scheduling accident: measured 2026-08-25, forty requests through the same relay
 * cost fourteen connections on macOS and twenty-four on Windows, from this number
 * alone. Twenty-four handshakes for forty requests is the churn this module was
 * written to remove.
 *
 * So the count no longer bounds anything and the clock does. Twelve tunnels stay
 * warm for at most five seconds after a burst, where four used to; that is the
 * whole cost, and it buys back every handshake the burst was paying twice for.
 *
 * There is no constant for it any more, on purpose: the only right value is the
 * gate's own limit, so it is read from the gate where it is used.
 */
export type Pool = {
  /**
   * The agent for one Seat, or for nobody. Reuses a connection when one is warm.
   *
   * Keyed by Seat, so no two Seats ever share a connection. That is safety by
   * construction rather than by argument: HTTP/1.1 authenticates a request and not
   * a connection, so sharing would very probably be fine, and "very probably fine"
   * about who is billed is not a thing this program says.
   */
  forSeat(seat: string | null, port: number): Promise<Agent>;
  /** How many connections are warm right now, across every Seat. */
  idle(): number;
  /** How many were ever opened, so reuse can be told from churn. */
  opened(): number;
  /**
   * Hang up on every connection, in flight as well as idle.
   *
   * Called when the machine's proxy turns out to be gone. `Agent.destroy` is not
   * enough on its own: Node destroys an agent's *free* sockets and leaves the
   * busy ones alone, and the busy ones are exactly the problem. A proxy that
   * disappears mid-flight leaves its exchanges wedged, holding turns at the gate,
   * and everything behind them queues until a three-minute guard fires.
   *
   * Measured 2026-08-24: a VPN blinked, 91 connections stayed wedged on the
   * relay, and the only cure anyone found was restarting the service by hand.
   * Nothing should need that.
   */
  hangUpOnEverything(why: string): number;
  close(): void;
};

/** A stable description of a route, so a route that changed cannot be reused. */
function describe(egress: Egress): string {
  if (egress.kind === "proxy") return `proxy ${egress.at.host}:${egress.at.port}`;
  return egress.kind;
}

/**
 * Connections to the opened host, kept warm and reused.
 *
 * Our own `Agent` subclass rather than Node's default, and that is the whole
 * design. Node honours `options.createConnection` only when there is no agent at
 * all, so `agent: false` beside a `createConnection` makes Node dial the host
 * itself and go straight round the machine's proxy: measured on 2026-08-22, by a
 * relay that reached the real Cloudflare in a test. An agent whose own
 * `createConnection` is our dialler has no such gap, and the chokepoint test is
 * what keeps saying so.
 *
 * What is deliberately not here is a retry. A connection that dies while it is
 * being used is a request that fails, exactly as it does today, because the only
 * way to tell "the server never read it" from "the server read it and then the
 * connection died" is to guess, and guessing wrong charges a Seat twice for one
 * request. The bound above is the answer instead: do not offer a connection that
 * might be dead. Ticket 26 allows that in so many words.
 */
export function openPool(options: { wiring: Wiring; idleForAtMostMs?: number }): Pool {
  const idleFor = options.idleForAtMostMs ?? IDLE_FOR_AT_MOST_MS;
  const agents = new Map<string, Agent>();

  /**
   * Every socket this pool has opened and not yet seen close.
   *
   * Held because Node's own agent bookkeeping cannot be asked to drop a busy
   * socket, and a busy socket riding a proxy that has gone away is the one that
   * has to go.
   */
  const live = new Set<Duplex>();
  let route: string | null = null;
  let opened = 0;

  /**
   * An agent whose connections go out the one way this machine says they may.
   *
   * `createConnection` is the extension point Node documents for exactly this, and
   * it is the only place in here that opens anything.
   */
  class OurAgent extends Agent {
    readonly port: number;
    /** Whether sockets from this agent carry a Seat's credential. ADR 0011. */
    carryingASeat: boolean;

    constructor(port: number, carryingASeat: boolean) {
      super({
        keepAlive: true,
        /**
         * As many as there may be exchanges, not as many as there may be dials.
         *
         * This used to be the gate's own limit, on the reasoning that the gate was
         * the thing doing the bounding and a larger number here could change
         * nothing. That stopped being true when the turn started coming back at
         * the head of the reply (ADR 0017): an exchange that is streaming holds a
         * socket and no turn, so a bound written as the gate's would have queued
         * those inside Node's own agent, invisibly, which is the one place in this
         * program where a queue has nothing watching it.
         *
         * Still per agent and so still per Seat, which is worth knowing rather
         * than assuming: with several Seats paying at once the real ceiling is
         * this times that. One pays at a time in ordinary use.
         */
        maxSockets: options.wiring.exchanges.limit(),
        // As many as may be in the air: see the note at the top of this file.
        maxFreeSockets: options.wiring.exchanges.limit(),
      });
      this.port = port;
      this.carryingASeat = carryingASeat;
    }

    override createConnection(
      _options: ClientRequestArgs,
      callback?: (error: Error | null, stream: Duplex) => void,
    ): Duplex | null | undefined {
      // Dialled and wrapped here rather than handed back synchronously, because
      // reaching the machine's proxy is a round trip of its own. The socket the
      // agent is given is a placeholder that is never written to; the real one
      // arrives through the callback.
      void (async () => {
        try {
          const raw = await dialUpstream(options.wiring.openHost, this.port, options.wiring, this.carryingASeat);
          const tls = connectTls({
            socket: raw,
            servername: options.wiring.openHost,
            ALPNProtocols: ["http/1.1"],
            ...(options.wiring.trust === null ? {} : { ca: [...options.wiring.trust] }),
          });
          tls.setNoDelay(true);
          tls.once("secureConnect", () => {
            opened += 1;
            live.add(tls);
            tls.once("close", () => live.delete(tls));
            callback?.(null, tls);
          });
          tls.once("error", (error) => callback?.(error, tls));
        } catch (error) {
          callback?.(error instanceof Error ? error : new Error(String(error)), undefined as unknown as Duplex);
        }
      })();

      /**
       * Nothing is returned, deliberately.
       *
       * Node uses the return value the moment it is truthy, and only falls back to
       * the callback when it is not. Reaching the machine's proxy is a round trip
       * of its own, so there is nothing to return yet.
       */
      return undefined;
    }

    /**
     * A connection that has just gone idle gets a clock on it.
     *
     * Node's own agent will keep a free socket for as long as the other end
     * tolerates, which for a machine proxy is about fifteen seconds and for a
     * server may be minutes. The bound has to be ours.
     */
    override keepSocketAlive(socket: Socket): boolean {
      // Node's own returns nothing in the types and true at runtime, so the result
      // is not read: what matters is that the clock is on before it goes idle.
      super.keepSocketAlive(socket);
      socket.setTimeout(idleFor);
      return true;
    }

    /**
     * In use again. The idle clock is deliberately not cleared here.
     *
     * It looked as though it had to be, and a line doing it stood here until no
     * test could tell the difference. The reason is that every request sets its own
     * timeout on the socket the moment it is assigned one (`silentFor`, three
     * minutes), and that replaces whatever the idle clock left behind. Clearing it
     * as well was a second mechanism for one job, and a line no test can
     * distinguish is a line that teaches a wrong model of how this works.
     */
    override reuseSocket(socket: Socket, request: ClientRequest): void {
      super.reuseSocket(socket, request);
    }
  }

  return {
    async forSeat(seat, port) {
      /**
       * Everything warm is let go when the route changes.
       *
       * A connection opened through a proxy that has since gone away, or opened
       * directly before a VPN came up, is a connection out the wrong door. It
       * would work, which is worse than failing: the request would leave by a
       * route the machine is no longer set up to take (ADR 0011).
       */
      const now = describe(await options.wiring.egressNow());
      if (route !== null && now !== route) {
        for (const agent of agents.values()) agent.destroy();
        agents.clear();
      }
      route = now;

      // Keyed by the port as well, because a client may ask for the opened host on
      // a port of its own and a pooled connection goes where it was dialled.
      const key = `${seat ?? "the Window account"} on ${port}`;
      const held = agents.get(key) ?? new OurAgent(port, seat !== null);
      agents.set(key, held);
      return held;
    },

    idle: () =>
      [...agents.values()].reduce(
        (all, agent) => all + Object.values(agent.freeSockets).reduce((some, held) => some + (held?.length ?? 0), 0),
        0,
      ),

    opened: () => opened,

    hangUpOnEverything(why) {
      const many = live.size;
      for (const socket of live) socket.destroy(new Error(why));
      live.clear();
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
      return many;
    },

    close() {
      for (const socket of live) socket.destroy();
      live.clear();
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
    },
  };
}
