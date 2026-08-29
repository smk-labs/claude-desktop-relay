import type { Socket } from "node:net";

import { dialUpstream } from "./dial.ts";
import { ESTABLISHED, describeError } from "./wire.ts";
import type { Wiring } from "./config.ts";

/**
 * Carry one connection through untouched.
 *
 * The client must not lose a byte it wrote before being told the tunnel was open.
 * A real client sends its opening TLS record straight after the CONNECT request,
 * and if those bytes land with nothing reading them the handshake dies: the window
 * renders black with nothing in any log to say why. Two things hold them:
 *
 * - Bytes that arrive attached to the request itself are pushed back onto the
 *   socket by the caller. That one is proved: remove it and the same-write test
 *   fails.
 * - Bytes that arrive while the upstream is still being dialled are held because
 *   the socket is paused. Node hands it over paused and `pipe` is what resumes
 *   it, so the explicit pause below is belt and braces rather than the only
 *   thing standing between us and the bug. It stays because it makes the
 *   guarantee independent of that behaviour, and because the failure it prevents
 *   was measured and cost a day to find.
 */
export async function tunnelBlind(client: Socket, host: string, port: number, wiring: Wiring): Promise<void> {
  client.pause();

  let upstream: Socket;
  try {
    // A blind tunnel carries nobody's credential, so it never refuses: it goes
    // the way the machine would, and falls back exactly as it would have without
    // this program installed. ADR 0011, narrowed 2026-08-23.
    upstream = await dialUpstream(host, port, wiring, false);
  } catch (error) {
    wiring.report({
      kind: "upstream-unreachable",
      summary: `Could not reach ${host}:${port}: ${describeError(error)}`,
    });
    client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
    return;
  }

  // Answered only now, with somewhere for the reply to go.
  client.write(ESTABLISHED);
  client.pipe(upstream);
  upstream.pipe(client);
  client.resume();
  upstream.resume();

  const hangUp = () => {
    client.destroy();
    upstream.destroy();
  };
  client.once("error", hangUp);
  upstream.once("error", hangUp);
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
}

