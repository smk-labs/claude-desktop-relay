import type { Server, ServerResponse, IncomingMessage } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createServer as createRawServer, type Server as RawServer, type Socket } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { authorityFor } from "./authorities.ts";

/** Everything the fake upstream saw of one request. */
export type SeenRequest = {
  /**
   * Which connection this arrived on, counted from one.
   *
   * The only way to assert that two requests shared a connection, or did not. Two
   * Seats sharing one is the thing ticket 26 has to rule out.
   */
  readonly connection: number;
  readonly method: string;
  readonly url: string;
  /** Header names and values exactly as they arrived, in order. */
  readonly rawHeaders: readonly string[];
  readonly body: string;
};

export type Reply = {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Written in order. A function is awaited before the next part is written. */
  readonly parts: ReadonlyArray<string | (() => Promise<void>)>;
};

export type FakeUpstream = {
  /** How many connections are open to it right now. */
  readonly openConnections: () => number;
  /** How many were ever opened, so connection reuse can be told from churn. */
  readonly totalConnections: () => number;
  readonly port: number;
  readonly host: string;
  /** PEM of the authority that signed this upstream's certificate. */
  readonly authority: string;
  readonly seen: SeenRequest[];
  /**
   * Close every connection that is open right now, as a machine proxy does to a
   * tunnel that has gone quiet. Resolves once they are gone.
   */
  hangUpOnEverything(): Promise<void>;
  /** What to answer with next. */
  reply: Reply;
  /**
   * What to answer one particular request with, decided from the request itself.
   *
   * Set this rather than `reply` whenever the answer depends on what arrived: a
   * credential that is refused, say. Deciding from `seen` beforehand cannot work
   * and looks as if it does, because the request being answered is not in `seen`
   * until it gets here.
   */
  replyTo: ((seen: SeenRequest) => Reply) | null;
  close(): Promise<void>;
};

/**
 * An HTTPS server holding a certificate for `host`, on a free port on loopback.
 * It records what arrived and answers with whatever `reply` says, writing the
 * parts in order so a test can prove a response streamed rather than buffered.
 */
export async function startFakeUpstream(host: string): Promise<FakeUpstream> {
  const authority = await authorityFor(host);
  const seen: SeenRequest[] = [];
  const state: { reply: Reply; replyTo: ((seen: SeenRequest) => Reply) | null } = {
    reply: { parts: ["ok"] } as Reply,
    replyTo: null,
  };

  const server = createSecureServer(
    { key: authority.leaf.key, cert: authority.leaf.cert },
    (request, response) => void answer(request, response, seen, state, numbered),
  );

  let open = 0;
  let total = 0;
  const numbered = new WeakMap<object, number>();
  const alive = new Set<Socket>();
  server.on("connection", (socket) => {
    open += 1;
    total += 1;
    numbered.set(socket, total);
    alive.add(socket as unknown as Socket);
    socket.once("close", () => {
      open -= 1;
      alive.delete(socket as unknown as Socket);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    openConnections: () => open,
    async hangUpOnEverything() {
      for (const socket of [...alive]) socket.destroy();
      alive.clear();
      // One turn of the loop, so the close events have landed before this returns.
      await new Promise((resolve) => setImmediate(resolve));
    },
    totalConnections: () => total,
    host,
    port: (server.address() as AddressInfo).port,
    authority: authority.caCertificate,
    seen,
    get reply() {
      return state.reply;
    },
    set reply(next: Reply) {
      state.reply = next;
    },
    get replyTo() {
      return state.replyTo;
    },
    set replyTo(next: ((seen: SeenRequest) => Reply) | null) {
      state.replyTo = next;
    },
    close: () => closeServer(server),
  };
}

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  seen: SeenRequest[],
  state: { reply: Reply; replyTo: ((seen: SeenRequest) => Reply) | null },
  numbered: WeakMap<object, number>,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);

  const arrived: SeenRequest = {
    connection:
      numbered.get(request.socket) ??
      // A TLS socket wraps the raw one the server counted.
      numbered.get((request.socket as unknown as { _parent?: object })._parent ?? {}) ??
      0,
    method: request.method ?? "",
    url: request.url ?? "",
    rawHeaders: [...request.rawHeaders],
    body: Buffer.concat(chunks).toString("utf8"),
  };
  seen.push(arrived);

  const reply = state.replyTo === null ? state.reply : state.replyTo(arrived);
  response.writeHead(reply.status ?? 200, { "content-type": "text/plain", ...reply.headers });
  for (const part of reply.parts) {
    if (typeof part === "function") await part();
    else response.write(part);
  }
  response.end();
}

/**
 * An upstream that finishes the handshake, reads the request, and then hangs up
 * without answering. Stands in for the server, or a proxy in between, dropping an
 * established connection: the shape of a real failure, as opposed to a caller who
 * changed its mind.
 */
export async function startRudeUpstream(host: string): Promise<{ port: number; close(): Promise<void> }> {
  const authority = await authorityFor(host);
  const open = new Set<Socket>();

  const server = createSecureServer(
    { key: authority.leaf.key, cert: authority.leaf.cert },
    // Never called: the socket is gone before a request is parsed.
    () => {},
  );

  server.on("secureConnection", (socket) => {
    open.add(socket as unknown as Socket);
    socket.once("data", () => socket.destroy());
    socket.once("close", () => open.delete(socket as unknown as Socket));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}

/** A raw TCP server that echoes every byte back, for proving nothing is dropped. */
export async function startEchoServer(): Promise<{ port: number; close(): Promise<void> }> {
  const open = new Set<Socket>();
  const server: RawServer = createRawServer((socket: Socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    socket.pipe(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}

export async function closeServer(server: Server | RawServer): Promise<void> {
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}



export type CrowdedUpstream = {
  readonly port: number;
  readonly host: string;
  readonly authority: string;
  /** How many requests it answered. */
  readonly answered: () => number;
  /** The most requests it was working on at one time. */
  readonly mostAtOnce: () => number;
  /** How many TCP connections were ever opened to it, so reuse shows up. */
  readonly totalConnections: () => number;
  close(): Promise<void>;
};

/**
 * An upstream that can only think about a few requests at a time.
 *
 * Every real server is this, and phase one's fake never was: it answered
 * instantly however many arrived, so no test could ever produce the queue that
 * made requests sit idle long enough for the machine's proxy to hang up on them.
 * A request that arrives while `atOnce` are already in hand waits its turn, in
 * silence, which is exactly the silence the proxy punishes.
 */
export async function startCrowdedUpstream(options: {
  host: string;
  atOnce: number;
  thinkMs: number;
}): Promise<CrowdedUpstream> {
  const authority = await authorityFor(options.host);
  let working = 0;
  let mostAtOnce = 0;
  let answered = 0;
  let totalConnections = 0;
  const waiting: Array<() => void> = [];

  const takeATurn = async (): Promise<void> => {
    if (working >= options.atOnce) await new Promise<void>((resolve) => waiting.push(resolve));
    working += 1;
    mostAtOnce = Math.max(mostAtOnce, working);
  };

  const giveUpTheTurn = () => {
    working -= 1;
    waiting.shift()?.();
  };

  const server = createSecureServer(
    { key: authority.leaf.key, cert: authority.leaf.cert },
    (request, response) => {
      void (async () => {
        // Drained first, so a body that is still arriving is not mistaken for a
        // request that has not been made.
        request.resume();
        await takeATurn();
        try {
          await new Promise((resolve) => setTimeout(resolve, options.thinkMs));
          if (response.writableEnded) return;
          answered += 1;
          response.writeHead(200, {
            "content-type": "application/json",
            "anthropic-organization-id": "org-seat-a",
          });
          response.end(`{"ok":true}`);
        } finally {
          giveUpTheTurn();
        }
      })();
    },
  );

  server.on("connection", () => void (totalConnections += 1));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: (server.address() as AddressInfo).port,
    host: options.host,
    authority: authority.caCertificate,
    answered: () => answered,
    mostAtOnce: () => mostAtOnce,
    totalConnections: () => totalConnections,
    close: () => closeServer(server),
  };
}

/**
 * An upstream that completes the handshake, reads the request, and then says
 * nothing at all, for ever, without closing.
 *
 * This is the shape of the failure that wedged the relay twice on 2026-08-24: a
 * tunnel through a proxy on loopback whose far end has died. Nothing errors,
 * nothing closes, no dial fails, and the exchange holds its turn until the silence
 * guard fires. Telling that apart from a slow reply is the whole point, so the
 * connections are kept rather than dropped.
 */
export async function startSilentUpstream(host: string): Promise<{
  port: number;
  authority: string;
  /** How many connections it is holding open and ignoring. */
  holding(): number;
  close(): Promise<void>;
}> {
  const authority = await authorityFor(host);
  const open = new Set<Socket>();

  const server = createSecureServer({ key: authority.leaf.key, cert: authority.leaf.cert }, () => {
    // Deliberately empty: the request is read and never answered.
  });

  server.on("secureConnection", (socket) => {
    open.add(socket as unknown as Socket);
    socket.on("close", () => open.delete(socket as unknown as Socket));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: (server.address() as AddressInfo).port,
    authority: authority.caCertificate,
    holding: () => open.size,
    async close() {
      for (const socket of open) socket.destroy();
      open.clear();
      server.close();
    },
  };
}
