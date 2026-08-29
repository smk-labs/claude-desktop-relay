import type { IncomingMessage, ServerResponse } from "node:http";

import { NOTHING_READ, type Exchange, type RequestFacts } from "./exchange.ts";
import type { TokenCounts } from "../../tokens/index.ts";
import type { SocksCredentials } from "../../socks/index.ts";
import { openGate, type Gate } from "./gate.ts";
import { THE_PROXY_HAS_THIS_LONG } from "./dial.ts";
import { openPool, type Pool } from "./pool.ts";

/** Something the relay wants said out loud rather than swallowed. */
export type RelayNotice = {
  readonly kind:
    | "machine-proxy-unreachable"
    | "upstream-unreachable"
    | "open-failed"
    /**
     * An exchange heard nothing at all for the whole silence guard.
     *
     * Its own kind, because it is evidence about the route rather than about the
     * request. A tunnel that has said nothing for three minutes is not slow, it is
     * dead, and the ones beside it are riding the same route.
     */
    | "upstream-went-silent"
    /**
     * The caller hung up before the reply came. Not a failure: a Code session
     * cancels requests it no longer needs, and counting them as failures makes
     * ordinary behaviour look like a broken relay.
     */
    | "caller-went-away"
    /**
     * A Seat refused, so the same request is being sent again on another one.
     *
     * Said out loud rather than kept quiet. Moving the work is the right answer to
     * a spent allowance, but a Payer changing without the user asking is exactly
     * the kind of thing they must be able to read afterwards.
     */
    | "moved-on";
  /** One plain sentence, fit to show a user as it stands. */
  readonly summary: string;
};

/** The deadlock guard, deliberately far above any honest think time. */
const THREE_MINUTES = 180_000;

/**
 * How many times one request may be sent, counting the first.
 *
 * Three, and low on purpose. A long list of Seats with no bound means one spent
 * account walks the whole list for every request: one upstream connection per Seat
 * where the route collapsed at eighty-six, and a caller waiting through all of
 * them. Two
 * moves is enough to get past a Seat that has just run dry.
 */
export const AT_MOST_ATTEMPTS = 3;

/** A host and a port, which in this module never travel apart. */
export type Address = { readonly host: string; readonly port: number };

/** Where a dial should actually go. Identity in real use. */
export type Dial = (host: string, port: number) => Address;

/**
 * How traffic leaves this machine, and the only three answers there are.
 *
 * There is deliberately no fourth. "The machine names a way out but we could not
 * use it, so we went round it" was the old behaviour and it is a leak: it puts
 * the request, its credential and the fact of this machine talking to Anthropic
 * out over the ordinary connection, which is what the tunnel exists to prevent.
 * ADR 0011.
 */
export type Egress =
  /** Nothing is named, so straight out is what the machine itself would do. */
  | { readonly kind: "direct" }
  /** Chain through this, with an HTTP CONNECT. */
  | { readonly kind: "proxy"; readonly at: Address }
  /**
   * Chain through this, with a SOCKS5 CONNECT.
   *
   * Its own answer rather than a flag on `proxy`, because the two are different
   * protocols to different ports and a reader who has to remember which one a
   * boolean meant is a reader who will get it wrong once.
   */
  | {
      readonly kind: "socks";
      readonly at: Address;
      /** Null when the machine names none, which most machines do. */
      readonly credentials: SocksCredentials | null;
    }
  /** Something is named that we cannot use. Never go round it. */
  | { readonly kind: "refuse"; readonly why: string };

/**
 * What the relay was told to charge a request to.
 *
 * The token and who it belongs to travel together, deliberately. They used to be
 * apart, with the Seat kept in one variable beside the relay, and under thirty
 * concurrent requests each one overwrote it for the others: the money went to the
 * right Seat and the verdict named the wrong one. Carrying them together makes
 * that impossible rather than unlikely.
 */
export type Charge = {
  readonly token: string;
  /** The Seat's own name, as the user knows it. */
  readonly seat: string;
  /** The Organization id, the only thing the server's answer can be checked against. */
  readonly organizationId: string;
};

/**
 * The one answer the relay wants about a request: who pays for it, and what it is.
 *
 * Both halves come back together because both need the body, and exactly one
 * module in this program is allowed near a body. Two hooks each handed the bytes
 * would be two places to keep honest instead of one.
 */
export type Decision = {
  /** The Seat to charge, or null to leave the caller's own credential alone. */
  readonly charge: Charge | null;
  readonly about: RequestFacts;
};

/** Nobody pays and nothing was read. The answer when no decider was given. */
export const NOTHING_DECIDED: Decision = { charge: null, about: NOTHING_READ };

/**
 * What the relay says about a request when it asks which Seat should pay.
 *
 * The body is handed over and never read here. Deciding who pays for a
 * conversation needs to know where in that conversation the request sits, and
 * that is in the body and nowhere else, so the choice is between passing the
 * bytes on and having the relay learn to read them. Passing them on keeps
 * exactly one module near a body, which is `src/conversation`, and that one is
 * held to not retaining a word of it.
 *
 * No header is offered, then or ever. A header carries the credential.
 */
export type RequestShape = {
  readonly method: string;
  /** The path as asked for. */
  readonly path: string;
  /**
   * The request body, for the paths where a Send token decides who pays, and
   * null everywhere else.
   *
   * Null also means "longer than the relay is willing to hold", which the reader
   * has to treat as unknown rather than as an empty body.
   */
  readonly body: Buffer | null;
};

export type RelayConfig = {
  /** Defaults to a free port on loopback. */
  readonly listen?: { readonly host?: string; readonly port?: number };
  /** The one host opened for inspection. Every other host is tunnelled blind. */
  readonly openHost: string;
  /** The certificate presented to the client for `openHost`. */
  readonly certificate: { readonly key: string; readonly cert: string };
  /**
   * The proxy the machine already uses, chained to so egress is unchanged.
   *
   * A function is asked again as the relay runs, which is how a VPN that comes up
   * or goes down after login is noticed. A plain value is read once and never
   * changes, which is only right for a test.
   */
  readonly machineProxy?: Address | null | (() => Promise<Address | null>);
  /**
   * Where a direct dial lands. The relay always believes it is reaching the host
   * the client asked for; this is the one place that belief is redirected, which
   * is how the tests put a loopback port where the internet would be.
   */
  readonly dial?: Dial;
  /** Extra authorities to trust when talking to the opened host. */
  readonly trust?: readonly string[];
  /**
   * How traffic leaves, asked again per dial so a VPN coming up or going down is
   * noticed. Wins over `machineProxy` when both are given.
   */
  readonly egress?: () => Promise<Egress>;
  /**
   * What to do when the machine names a proxy that is not listening.
   *
   * `refuse` by default, and ADR 0011 is why: going straight out instead is a
   * bypass of the route the machine is set up to take, and on a machine where
   * that route is a VPN it is both a leak and a request that was going to fail
   * anyway. Nothing in this repo sets the other value.
   */
  readonly whenTheProxyIsGone?: "refuse" | "go-direct";
  /**
   * Which Seat should pay for this request, or null to leave the caller's own
   * credential alone. Asked once per request, so changing the answer needs no
   * restart of anything.
   */
  readonly chargeFor?: (request: RequestShape) => Decision | Promise<Decision>;
  /** The facts of each exchange with the opened host, as the server answered. */
  readonly onExchange?: (exchange: Exchange) => void;
  /**
   * The same exchange again once its reply has finished, with what it cost.
   *
   * Two callbacks rather than one, because the two moments are different and both
   * are needed. `onExchange` fires at the head of the reply, which is when the
   * verdict and the allowance figures are known and when a rotation has to be
   * decided; this fires when the last byte has gone, which is the first moment the
   * token counts exist at all.
   *
   * The counts are null when the reply did not state them, never zero: zero is a
   * claim about what the work cost and a history row that says it where it means
   * "unknown" is a wrong total later.
   */
  readonly onExchangeFinished?: (exchange: Exchange, tokens: TokenCounts | null) => void;
  readonly onNotice?: (notice: RelayNotice) => void;
  /**
   * What answers a plain HTTP request to the relay's own port.
   *
   * The port a proxy listens on can also be asked for a page, because a proxy
   * client only ever sends CONNECT there. So the interface lives at the one
   * address the app was already told about: nothing further to install, nothing
   * further to guard, nothing further to explain. Left out, the relay answers
   * what it always did, which is that it speaks CONNECT and nothing else.
   */
  readonly onPlainRequest?: (request: IncomingMessage, response: ServerResponse) => void;
  /**
   * How many exchanges with the opened host may be in the air at once.
   *
   * Defaults to twelve. Raising it is how the collapse of 2026-08-22 is invited
   * back: see `internal/gate.ts` for what happened at 86.
   */
  readonly atMostInFlight?: number;
  /**
   * How long an exchange may go with no bytes at all before it is given up on.
   *
   * A guard against a turn never being handed back, not a limit on how long a
   * reply may take. It has to sit well above both any honest think time and the
   * machine proxy's own patience, or it would be the thing killing good
   * requests. Defaults to three minutes.
   */
  readonly silentFor?: number;
  /**
   * How long the machine's proxy has to open a tunnel before it counts as gone.
   *
   * Only a test moves this. In real use the default is what stands between a
   * proxy that has stopped answering and a Window that appears to have frozen.
   */
  readonly proxyHasThisLong?: number;
  /**
   * What to charge a refused request to instead, or null to let the Refusal stand.
   *
   * The one thing that overrides holding a Seat for a conversation (ADR 0003): a
   * spent allowance should cost the user a moment, not an afternoon. Only asked
   * about a request that was actually charged to a Seat and whose body was read
   * whole, because a body still arriving as a stream cannot be sent again.
   */
  readonly whenRefused?: (refused: Exchange, request: RequestShape) => Promise<Charge | null> | Charge | null;
  /**
   * How many times one request may be sent, in total. Defaults to three.
   *
   * A bound, and a low one. A long list of Seats and no bound means one spent
   * account walks the whole list for every request, which is one upstream
   * connection per Seat where the route collapsed at eighty-six.
   */
  readonly atMostAttempts?: number;
  /**
   * How long a connection may sit unused before it is closed.
   *
   * Defaults to five seconds, against a machine proxy measured to hang up on a
   * quiet tunnel at about fifteen. Raising it is how a connection the proxy killed
   * becomes a request that failed for no reason anybody did anything about.
   */
  readonly idleForAtMostMs?: number;
};

/** The parts of the configuration the internals need, with defaults filled in. */
export type Wiring = {
  readonly chargeFor: (request: RequestShape) => Decision | Promise<Decision>;
  readonly reportExchange: (exchange: Exchange) => void;
  readonly reportFinished: (exchange: Exchange, tokens: TokenCounts | null) => void;
  readonly openHost: string;
  readonly certificate: { readonly key: string; readonly cert: string };
  /** Asked per dial, so a proxy that appears or disappears is noticed. */
  readonly egressNow: () => Promise<Egress>;
  readonly whenTheProxyIsGone: "refuse" | "go-direct";
  readonly dial: Dial;
  readonly trust: readonly string[] | null;
  readonly report: (notice: RelayNotice) => void;
  readonly gate: Gate;
  /** Connections to the opened host, kept warm and reused. One per Seat. */
  readonly pool: Pool;
  readonly silentFor: number;
  readonly proxyHasThisLong: number;
  readonly whenRefused: (refused: Exchange, request: RequestShape) => Promise<Charge | null> | Charge | null;
  readonly atMostAttempts: number;
};

/**
 * Fill in the defaults, and refuse to chain to ourselves.
 *
 * `listening` is the address the relay actually got, which is only known after it
 * is listening. A machine whose own proxy setting names that address would have
 * the relay opening a tunnel to itself for every request, which looks like a hang
 * with nothing in any log. Dropping it and saying so is the only useful answer.
 */
export function wiringFrom(config: RelayConfig, listening: Address): Wiring {
  const told = config.onNotice ?? (() => {});

  /**
   * The pool, once it exists, so a notice can reach it.
   *
   * Set at the bottom of this function. Nothing reports a notice before then.
   */
  let pool: Pool | null = null;

  /**
   * Every notice goes through here, and one kind of notice does more than get
   * said out loud.
   *
   * When the machine's proxy turns out to be gone, the connections already riding
   * it are wedged: the far end will never answer and nothing will close them.
   * They hold turns at the gate, so everything behind them waits, and the relay
   * needs a restart by hand to come back. Measured 2026-08-24: a VPN blinked, 91
   * connections stayed wedged, and restarting the service was the only cure
   * anybody found. Hanging up on them here is what makes that cure automatic.
   */
  const report = (notice: RelayNotice): void => {
    told(notice);
    /**
     * Two kinds of notice are evidence about the route rather than about one
     * request, and both mean the same thing for the connections already riding it.
     *
     * `machine-proxy-unreachable` is a dial that failed. That never fires for a
     * proxy which is an app on loopback: it accepts a connection whatever state its
     * own tunnels are in, so the route can die under us without a single dial
     * failing. Measured 2026-08-24: twelve exchanges, which is the whole gate, sat
     * silent and died together at the guard, twice, and nothing in between could
     * get a turn. That is what this second kind is for.
     *
     * The first casualty pays the full guard. Everything else on the route is hung
     * up on at once and dials afresh, so one blink costs three minutes once rather
     * than three minutes twelve times over.
     *
     * It does hang up on an exchange that was merely slow. That is the trade, taken
     * knowingly: three minutes of total silence is evidence about the road and not
     * about the traveller, and the alternative measured here was a relay that
     * needed restarting by hand.
     */
    const aboutTheRoute = notice.kind === "machine-proxy-unreachable" || notice.kind === "upstream-went-silent";
    if (!aboutTheRoute || pool === null) return;

    const many = pool.hangUpOnEverything(
      notice.kind === "upstream-went-silent"
        ? "another exchange on this route heard nothing at all, so this one is not waiting for the same silence"
        : "the machine's proxy went away under this connection",
    );
    if (many > 0) {
      told({
        kind: notice.kind,
        summary:
          `Hung up on ${many} connection${many === 1 ? "" : "s"} that were riding the route when it ` +
          `stopped answering. They would otherwise have held their turns until the silence guard fired, ` +
          `and everything behind them would have waited. The next request dials afresh.`,
      });
    }
  };
  const asked = config.machineProxy ?? null;
  const readProxy: () => Promise<Address | null> =
    typeof asked === "function" ? asked : async () => asked;

  let saidAlready = false;

  /**
   * Never chain to ourselves. A machine whose own proxy setting names this relay
   * would have it opening a tunnel to itself for every request, which looks like
   * a hang with nothing in any log. Going direct is right here, and is not the
   * bypass ADR 0011 forbids: the named proxy is us, so there is no third party
   * being gone round.
   */
  const notOurselves = (egress: Egress): Egress => {
    if (egress.kind !== "proxy") return egress;
    const { at } = egress;
    if (at.host !== listening.host || at.port !== listening.port) return egress;

    if (!saidAlready) {
      saidAlready = true;
      report({
        kind: "machine-proxy-unreachable",
        summary:
          `The machine's own proxy is set to ${at.host}:${at.port}, which is this relay. ` +
          `Chaining to that would be the relay talking to itself, so requests are going straight out instead.`,
      });
    }
    return { kind: "direct" };
  };

  const egressNow: () => Promise<Egress> =
    config.egress !== undefined
      ? async () => notOurselves(await config.egress!())
      : async () => {
          const proxy = await readProxy();
          return notOurselves(proxy === null ? { kind: "direct" } : { kind: "proxy", at: proxy });
        };

  const wiring: Wiring = {
    gate: openGate(config.atMostInFlight),
    // Filled in below: the pool needs the wiring to know how traffic leaves, and
    // the wiring needs the pool to hand a connection out. One of them has to be
    // second, and it is this one.
    pool: undefined as unknown as Pool,
    egressNow,
    whenTheProxyIsGone: config.whenTheProxyIsGone ?? "refuse",
    silentFor: config.silentFor ?? THREE_MINUTES,
    proxyHasThisLong: config.proxyHasThisLong ?? THE_PROXY_HAS_THIS_LONG,
    whenRefused: config.whenRefused ?? (() => null),
    atMostAttempts: Math.max(1, config.atMostAttempts ?? AT_MOST_ATTEMPTS),
    chargeFor: config.chargeFor ?? (() => NOTHING_DECIDED),
    reportExchange: config.onExchange ?? (() => {}),
    reportFinished: config.onExchangeFinished ?? (() => {}),
    openHost: config.openHost,
    certificate: config.certificate,
    dial: config.dial ?? ((host, port) => ({ host, port })),
    trust: config.trust ?? null,
    report,
  };

  pool = openPool({
    wiring,
    ...(config.idleForAtMostMs === undefined ? {} : { idleForAtMostMs: config.idleForAtMostMs }),
  });

  return { ...wiring, pool };
}
