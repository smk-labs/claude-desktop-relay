import { connect, type Socket } from "node:net";
import { once } from "node:events";

import { readHead } from "./head.ts";
import { socksConnect } from "../../socks/index.ts";
import type { Wiring } from "./config.ts";

/**
 * Error codes that mean the machine's proxy is not there at all, as opposed to
 * there and unhappy. A VPN in tunnel mode stops the listener while the machine's
 * proxy settings still name it, so this is the ordinary case, not an exotic one.
 */
const ABSENT = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "ETIMEDOUT"]);

/**
 * How long the machine's proxy has to open a tunnel before we treat it as gone.
 *
 * A proxy on loopback answers in single-digit milliseconds. Eight seconds is
 * therefore not a performance limit, it is the line between "busy" and "not
 * coming back", and it exists because there was no line at all: a proxy that
 * accepted the connection and then went silent left every tunnel waiting for
 * ever, with nothing timing out anywhere. That is what a hung app looks like
 * from the inside, and it is worse than an error because nothing reports it.
 *
 * Measured 2026-08-23, after a VPN under load did exactly that and every MCP
 * server in the Window stopped answering.
 */
export const THE_PROXY_HAS_THIS_LONG = 8_000;

/** Whatever settles first: the work, or the clock. */
async function before<T>(ms: number, what: Promise<T>, giveUp: () => void): Promise<T> {
  let timer: NodeJS.Timeout;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      giveUp();
      const late = new Error(`the machine's proxy did not answer within ${ms}ms`);
      (late as NodeJS.ErrnoException).code = "ETIMEDOUT";
      reject(late);
    }, ms);
  });
  try {
    return await Promise.race([what, clock]);
  } finally {
    clearTimeout(timer!);
  }
}

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

async function dialDirect(host: string, port: number, wiring: Wiring): Promise<Socket> {
  const where = wiring.dial(host, port);
  const socket = connect(where.port, where.host);
  socket.setNoDelay(true);
  await once(socket, "connect");
  return socket;
}

/** Ask a proxy to open a tunnel to `host:port` and hand back the raw socket. */
async function dialThroughProxy(
  host: string,
  port: number,
  proxy: { host: string; port: number },
  patience: number,
): Promise<Socket> {
  const socket = connect(proxy.port, proxy.host);
  socket.setNoDelay(true);

  // The clock covers the whole handshake, not just the connect. A proxy that
  // accepts and then says nothing is the case that hung everything, and it gets
  // past a connect-only timeout untouched.
  const handshake = (async () => {
    await once(socket, "connect");
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    return readHead(socket);
  })();

  const { statusLine } = await before(patience, handshake, () => socket.destroy()).catch(
    (error: unknown) => {
      socket.destroy();
      throw error;
    },
  );

  if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
    socket.destroy();
    throw new Error(`the machine's proxy refused the tunnel: ${statusLine}`);
  }

  return socket;
}

/**
 * A socket carrying bytes to `host:port`, by whatever way this machine says
 * traffic leaves.
 *
 * The one function through which every byte to the opened host goes out, and it
 * is the only place allowed to decide the route. There are three answers and no
 * fourth (ADR 0011): chain through the named proxy, go straight out because
 * nothing is named, or refuse because something is named that we cannot use.
 *
 * What is deliberately gone is the fourth: "the proxy is named but not
 * listening, so go straight out and mention it". On a machine where that proxy
 * is a VPN, that is a leak and a request that was going to fail anyway.
 */
export async function dialUpstream(
  host: string,
  port: number,
  wiring: Wiring,
  /**
   * Whether a Seat's own credential is about to travel down this socket.
   *
   * This is what the no-bypass rule actually protects, and getting it wrong the
   * broad way cost a whole Window on 2026-08-23. ADR 0011 was written as "nothing
   * leaves except the way the machine would", and applied to every socket that
   * meant a VPN blink stopped the blind tunnels too: ten MCP servers, all of them
   * carrying nobody's credential and every one of them dead. None of that traffic
   * is ours. It is the app's own, it would have gone straight out if this program
   * had never been installed, and refusing it protects nothing.
   *
   * So the rule is narrower and says what it means: a Seat's credential never
   * leaves except the way the machine would. Everything else falls back and says
   * so, exactly as it did before this program existed.
   */
  carryingASeat: boolean,
): Promise<Socket> {
  const egress = await wiring.egressNow();

  if (egress.kind === "refuse" && !carryingASeat) {
    wiring.report({
      kind: "machine-proxy-unreachable",
      summary:
        `This machine names a way out the relay cannot use (${egress.why}). No Seat is paying for ` +
        `${host}:${port}, so it went straight out, which is what this machine would have done ` +
        `without the relay installed.`,
    });
    return dialDirect(host, port, wiring);
  }

  if (egress.kind === "refuse") {
    throw new Error(
      `this machine says traffic leaves by a route the relay cannot use (${egress.why}), ` +
        `so this request was not sent. Going straight out instead would go round the very ` +
        `route the machine is set up to take. Fix the proxy setting, or turn the proxy off ` +
        `entirely if going direct is really what you want.`,
    );
  }

  if (egress.kind === "direct") return dialDirect(host, port, wiring);

  /**
   * SOCKS, which is a route like any other and never a reason to go direct.
   *
   * A SOCKS proxy that refuses, or answers something we do not understand, ends
   * the request with the proxy's own reason. It is deliberately not folded into the
   * `ECONNREFUSED` handling below either: that one exists for an HTTP proxy whose
   * port a VPN took with it, and treating a SOCKS failure the same way would put
   * `whenTheProxyIsGone: "go-direct"` in reach of a case nobody has measured.
   *
   * The proxy's own address is dialled straight, exactly as the HTTP proxy's is,
   * and not through `wiring.dial`. That seam redirects where a *direct* dial to the
   * opened host lands, which is what makes it the negative control: point it at a
   * dead port and a request that still succeeds can only have gone through here.
   */
  if (egress.kind === "socks") {
    return socksConnect({
      through: egress.at,
      to: { host, port },
      credentials: egress.credentials,
    });
  }

  const proxy = egress.at;
  try {
    return await dialThroughProxy(host, port, proxy, wiring.proxyHasThisLong);
  } catch (error) {
    if (!ABSENT.has(codeOf(error))) throw error;

    if (wiring.whenTheProxyIsGone === "refuse" && carryingASeat) {
      wiring.report({
        kind: "machine-proxy-unreachable",
        summary:
          `The machine's own proxy at ${proxy.host}:${proxy.port} is not listening (${codeOf(error)}), ` +
          `and a Seat's credential was about to travel, so this request was NOT sent. Sending it ` +
          `straight out would put that credential outside the route this machine is set up to take. ` +
          `Start the proxy or the VPN, or run "relay off" and the same request will go out the way ` +
          `it would have without this program.`,
      });
      throw new Error(
        `the machine's proxy at ${proxy.host}:${proxy.port} is not listening (${codeOf(error)}), ` +
          `and the relay does not go round it`,
      );
    }

    wiring.report({
      kind: "machine-proxy-unreachable",
      summary:
        `The machine's own proxy at ${proxy.host}:${proxy.port} is not listening (${codeOf(error)}), ` +
        `so this request went straight out and did NOT take the route the machine is set up to take. ` +
        `Check the machine's proxy settings, or a VPN that took the port with it.`,
    });

    return dialDirect(host, port, wiring);
  }
}
