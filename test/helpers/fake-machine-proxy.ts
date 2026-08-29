import { createServer, connect, type Server, type Socket } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { readHead } from "../../src/relay/index.ts";

/** A stand-in for whatever proxy the machine already uses. */
export type FakeMachineProxy = {
  readonly host: string;
  readonly port: number;
  /** The CONNECT lines it was asked for, in order. */
  readonly asked: string[];
  close(): Promise<void>;
};

/**
 * A minimal CONNECT proxy on loopback, so a test can prove the relay chained to
 * the machine's proxy rather than dialling round it.
 */
export async function startFakeMachineProxy(
  redirect: Readonly<Record<string, { host: string; port: number }>> = {},
  /** How long to dawdle before answering, so a test can write into the window. */
  answerAfterMs = 0,
): Promise<FakeMachineProxy> {
  const asked: string[] = [];

  const open = new Set<Socket>();

  const server: Server = createServer((client: Socket) => {
    open.add(client);
    client.once("close", () => open.delete(client));
    serve(client).catch(() => client.destroy());
  });

  async function serve(client: Socket): Promise<void> {
    const { statusLine } = await readHead(client).catch(() => ({ statusLine: "" }));
    if (statusLine === "") return void client.destroy();

    const target = statusLine.replace(/^CONNECT\s+/, "").replace(/\s+HTTP\/1\.[01]$/, "");
    asked.push(target);

    // The relay names the real host, as it must. Standing in for the machine's
    // proxy, this is where that name is resolved to a loopback port.
    const [named = "", namedPort = "443"] = target.split(":");
    const where = redirect[target] ?? { host: named, port: Number(namedPort) };

    const upstream = connect(where.port, where.host);
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
    await once(upstream, "connect");
    if (answerAfterMs > 0) await new Promise((resolve) => setTimeout(resolve, answerAfterMs));

    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}

/** A port with nothing listening on it, for the dead-machine-proxy case. */
export async function aClosedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A proxy that hangs up on a tunnel nothing has travelled down for a while. */
export type ImpatientMachineProxy = FakeMachineProxy & {
  /** Tunnels it hung up on for going quiet. The failure the live proxy produced. */
  readonly hungUpOn: () => number;
  /** The most tunnels it held open at once. */
  readonly mostAtOnce: () => number;
};

/**
 * The machine's proxy as the real one behaves, which is the part phase one never
 * modelled: it hangs up on a tunnel that has gone quiet.
 *
 * This is what turned a slow moment into 190 failed requests on 2026-08-22. The
 * relay opened one connection per request, 86 of them at once, and every one of
 * them then sat waiting for a reply that was queued behind the other 85. The
 * proxy does not know they are queued; it sees a tunnel with no bytes in it and
 * closes it. The relay reports "socket hang up" on a request that was perfectly
 * good.
 *
 * `idleMs` is scaled down from the roughly fifteen seconds measured live, so the
 * same collapse happens in a test that finishes quickly.
 */
export async function startImpatientMachineProxy(options: {
  redirect?: Readonly<Record<string, { host: string; port: number }>>;
  idleMs: number;
}): Promise<ImpatientMachineProxy> {
  const asked: string[] = [];
  const open = new Set<Socket>();
  let hungUpOn = 0;
  let mostAtOnce = 0;
  let live = 0;

  const server: Server = createServer((client: Socket) => {
    open.add(client);
    client.once("close", () => open.delete(client));
    serve(client).catch(() => client.destroy());
  });

  async function serve(client: Socket): Promise<void> {
    const { statusLine } = await readHead(client).catch(() => ({ statusLine: "" }));
    if (statusLine === "") return void client.destroy();

    const target = statusLine.replace(/^CONNECT\s+/, "").replace(/\s+HTTP\/1\.[01]$/, "");
    asked.push(target);

    const [named = "", namedPort = "443"] = target.split(":");
    const where = options.redirect?.[target] ?? { host: named, port: Number(namedPort) };

    const upstream = connect(where.port, where.host);
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
    await once(upstream, "connect");

    live += 1;
    mostAtOnce = Math.max(mostAtOnce, live);
    client.once("close", () => (live -= 1));

    // The whole point of this stand-in. Any quiet stretch longer than `idleMs`
    // and the tunnel is gone, whoever was at fault for the quiet.
    let idle: NodeJS.Timeout;
    const restartTheClock = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        hungUpOn += 1;
        client.destroy();
        upstream.destroy();
      }, options.idleMs);
    };
    restartTheClock();
    client.on("data", restartTheClock);
    upstream.on("data", restartTheClock);
    client.once("close", () => clearTimeout(idle));

    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();

    // Either end going away takes the whole tunnel with it, which is what a real
    // proxy does and what `pipe` on its own does not: pipe only half-closes, so
    // a tunnel whose client had finished with it stayed open here and got counted
    // as one this proxy hung up on. That was a fault in this stand-in, not in the
    // relay, and it cost a while to find.
    const teardown = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("end", teardown);
    upstream.once("end", teardown);
    upstream.once("close", teardown);
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    asked,
    hungUpOn: () => hungUpOn,
    mostAtOnce: () => mostAtOnce,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}

/**
 * A proxy that accepts the connection and then says nothing at all.
 *
 * The worst kind, and the one nothing guarded against: it is not refused, not
 * unreachable, and not slow. It simply never answers the CONNECT. Every tunnel
 * waiting on it waited for ever, which from the outside is an app that has
 * frozen rather than an app that has failed. A VPN under load did exactly this
 * on 2026-08-23 and took ten MCP servers with it.
 */
export async function startSilentMachineProxy(): Promise<{ host: string; port: number; asked: () => number; close(): Promise<void> }> {
  const open = new Set<Socket>();
  let asked = 0;

  const server: Server = createServer((client: Socket) => {
    open.add(client);
    asked += 1;
    client.once("close", () => open.delete(client));
    client.once("error", () => client.destroy());
    // Deliberately no answer, ever.
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    asked: () => asked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}
