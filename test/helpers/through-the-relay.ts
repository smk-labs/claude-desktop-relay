import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { request as httpRequest } from "node:http";
import { once } from "node:events";

import { readHead } from "../../src/relay/index.ts";

/** Where the relay is listening. */
export type RelayAddress = { readonly host: string; readonly port: number };

/** One chunk of a reply and the moment it arrived, so streaming can be proved. */
export type ArrivedChunk = { readonly text: string; readonly at: number };

export type Answer = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly chunks: readonly ArrivedChunk[];
  readonly body: string;
};

/**
 * Ask for a tunnel and write `pipelined` bytes without waiting for the answer,
 * the way a real client sends its opening TLS record. `together` puts them in the
 * same write, so they reach the relay attached to the CONNECT request itself;
 * otherwise they follow after `afterMs`, while the relay is still dialling.
 *
 * This is the shape that finds a relay which answers CONNECT before its upstream
 * pipe exists: the bytes arrive with nothing reading and are gone.
 */
export async function pipelineThrough(
  relay: RelayAddress,
  target: string,
  pipelined: string,
  options: { together: boolean; afterMs?: number } = { together: true },
): Promise<Socket> {
  const socket = connectTcp(relay.port, relay.host);
  await once(socket, "connect");

  const ask = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
  if (options.together) {
    socket.write(ask + pipelined);
  } else {
    socket.write(ask);
    await new Promise((resolve) => setTimeout(resolve, options.afterMs ?? 5));
    socket.write(pipelined);
  }

  const { statusLine } = await readHead(socket).catch((error: unknown) => {
    socket.destroy();
    throw error;
  });

  if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
    socket.destroy();
    throw new Error(`the relay refused the tunnel: ${statusLine}`);
  }

  return socket;
}

/** Read from a socket until `bytes` bytes have come back. */
export async function readBack(socket: Socket, bytes: number): Promise<string> {
  socket.resume();
  let back = "";
  for await (const chunk of socket) {
    back += (chunk as Buffer).toString("utf8");
    if (back.length >= bytes) break;
  }
  return back;
}

/**
 * Many requests down one connection, held open throughout, which is what a real
 * Code session does and what a fresh tunnel per request does not.
 *
 * The difference matters for anything about connection lifetime: when the client
 * hangs up after every request, the relay's own sockets go with it and a leak
 * upstream is hidden. Here nothing is closed until the end.
 */
export async function manyDownOneConnection(options: {
  relay: RelayAddress;
  host: string;
  port: number;
  trust: string;
  howMany: number;
  path?: string;
}): Promise<number> {
  const secure = await secureTunnelThrough(options.relay, options.host, options.port, options.trust);
  let answered = 0;

  for (let i = 0; i < options.howMany; i++) {
    const outgoing = httpRequest({
      createConnection: () => secure,
      host: options.host,
      port: options.port,
      path: options.path ?? "/v1/messages",
      method: "POST",
      headers: { connection: "keep-alive" },
    });
    outgoing.end("{}");

    const [incoming] = (await once(outgoing, "response")) as [import("node:http").IncomingMessage];
    for await (const _ of incoming) {
      // Drained, because a reply nobody reads never completes.
    }
    if (incoming.statusCode === 200) answered += 1;
  }

  secure.destroy();
  return answered;
}

/**
 * Two requests down one connection, which is what a real Code session does.
 *
 * A relay that read its Send token once per connection rather than once per
 * request would pass a test that opened a fresh tunnel each time. This does not
 * give it that chance.
 */
export async function twiceDownOneConnection(options: {
  relay: RelayAddress;
  host: string;
  port: number;
  trust: string;
  path?: string;
  body?: string;
}): Promise<[Answer, Answer]> {
  const secure = await secureTunnelThrough(options.relay, options.host, options.port, options.trust);

  const one = async (): Promise<Answer> => {
    const outgoing = httpRequest({
      createConnection: () => secure,
      host: options.host,
      port: options.port,
      path: options.path ?? "/v1/messages",
      method: "POST",
      headers: { connection: "keep-alive" },
    });
    outgoing.write(options.body ?? "{}");
    outgoing.end();

    const [incoming] = (await once(outgoing, "response")) as [import("node:http").IncomingMessage];
    const chunks: ArrivedChunk[] = [];
    for await (const chunk of incoming) {
      chunks.push({ text: (chunk as Buffer).toString("utf8"), at: performance.now() });
    }
    return {
      status: incoming.statusCode ?? 0,
      headers: incoming.headers,
      chunks,
      body: chunks.map((c) => c.text).join(""),
    };
  };

  const first = await one();
  const second = await one();
  secure.destroy();
  return [first, second];
}

/** Ask the relay to open a tunnel to `target`, and hand back the raw socket. */
export async function tunnelThrough(relay: RelayAddress, target: string): Promise<Socket> {
  const socket = connectTcp(relay.port, relay.host);
  await once(socket, "connect");
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

  const { statusLine } = await readHead(socket).catch((error: unknown) => {
    socket.destroy();
    throw error;
  });

  if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
    socket.destroy();
    throw new Error(`the relay refused the tunnel: ${statusLine}`);
  }

  return socket;
}

/** Open a tunnel, then finish a TLS handshake through it as the client would. */
export async function secureTunnelThrough(
  relay: RelayAddress,
  host: string,
  port: number,
  trust: string,
): Promise<TLSSocket> {
  const socket = await tunnelThrough(relay, `${host}:${port}`);
  socket.resume();
  const secure = connectTls({ socket, servername: host, ca: [trust] });
  await once(secure, "secureConnect");
  return secure;
}

/**
 * Drive one real HTTPS request through the relay and report what came back,
 * chunk by chunk with arrival times.
 *
 * `onFirstChunk` runs the moment the first chunk of the reply arrives, which is
 * how a test tells a streamed reply from a buffered one: the fake upstream is
 * released to write its second part only once the client has the first.
 */
export async function requestThrough(options: {
  relay: RelayAddress;
  host: string;
  port: number;
  trust: string;
  path?: string;
  method?: string;
  headers?: ReadonlyArray<readonly [string, string | readonly string[]]>;
  body?: string;
  onFirstChunk?: () => void;
  /** Give up and hang up after this long, the way a cancelled request does. */
  hangUpAfterMs?: number;
}): Promise<Answer> {
  const secure = await secureTunnelThrough(options.relay, options.host, options.port, options.trust);

  const outgoing = httpRequest({
    createConnection: () => secure,
    host: options.host,
    port: options.port,
    path: options.path ?? "/v1/messages",
    method: options.method ?? "POST",
  });

  for (const [name, value] of options.headers ?? []) outgoing.setHeader(name, value as string | string[]);
  if (options.body !== undefined) outgoing.write(options.body);
  outgoing.end();

  if (options.hangUpAfterMs !== undefined) {
    const givingUp = setTimeout(() => secure.destroy(), options.hangUpAfterMs);
    outgoing.once("response", () => clearTimeout(givingUp));
    outgoing.once("error", () => clearTimeout(givingUp));
  }

  const [incoming] = (await once(outgoing, "response")) as [import("node:http").IncomingMessage];

  const chunks: ArrivedChunk[] = [];
  for await (const chunk of incoming) {
    chunks.push({ text: (chunk as Buffer).toString("utf8"), at: performance.now() });
    if (chunks.length === 1) options.onFirstChunk?.();
  }

  secure.destroy();

  return {
    status: incoming.statusCode ?? 0,
    headers: incoming.headers,
    chunks,
    body: chunks.map((c) => c.text).join(""),
  };
}
