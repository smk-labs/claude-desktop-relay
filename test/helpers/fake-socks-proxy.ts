import { connect, createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/**
 * A SOCKS5 proxy on loopback, so a test can prove the relay tunnelled through one
 * rather than dialling round it.
 *
 * It speaks the protocol properly rather than answering fixed bytes, because a
 * double that accepts anything proves nothing about a handshake. It can also be
 * told to misbehave in each of the ways a real one does, which is what the failure
 * tests drive.
 */
export type FakeSocksProxy = {
  readonly port: number;
  /** Every `host:port` it was asked to reach, in order. */
  readonly asked: string[];
  /** How many connections were ever made to it, so reuse can be seen. */
  readonly connections: () => number;
  close(): Promise<void>;
};

export type HowItBehaves = {
  /** Where a tunnel actually lands, whatever was asked for. */
  readonly to: { readonly host: string; readonly port: number };
  /** Demand a username and password, and accept only this pair. */
  readonly wants?: { readonly user: string; readonly password: string };
  /** Answer the connect request with this code instead of success. */
  readonly refuseWith?: number;
  /** Answer the greeting with a version that is not 5. */
  readonly pretendVersion?: number;
  /** Accept none of the offered methods. */
  readonly acceptNothing?: boolean;
};

const VERSION = 5;

/** Read exactly this many bytes, or give up when the socket ends. */
async function exactly(socket: Socket, howMany: number): Promise<Buffer | null> {
  const held: Buffer[] = [];
  let have = 0;
  while (have < howMany) {
    const chunk = socket.read(howMany - have) ?? socket.read();
    if (chunk === null) {
      const more = await Promise.race([
        once(socket, "readable").then(() => true as const),
        once(socket, "close").then(() => false as const),
      ]);
      if (!more) return null;
      continue;
    }
    held.push(chunk as Buffer);
    have += (chunk as Buffer).length;
  }
  return Buffer.concat(held).subarray(0, howMany);
}

export async function startFakeSocksProxy(behaviour: HowItBehaves): Promise<FakeSocksProxy> {
  const asked: string[] = [];
  const open = new Set<Socket>();
  let connections = 0;

  const server: Server = createServer((client: Socket) => {
    connections += 1;
    open.add(client);
    client.once("close", () => open.delete(client));
    client.once("error", () => client.destroy());
    void serve(client);
  });

  async function serve(client: Socket): Promise<void> {
    const greeting = await exactly(client, 2);
    if (greeting === null) return void client.destroy();
    const offered = await exactly(client, greeting[1] ?? 0);
    if (offered === null) return void client.destroy();

    if (behaviour.pretendVersion !== undefined) {
      client.write(Buffer.from([behaviour.pretendVersion, 0x00]));
      return;
    }
    if (behaviour.acceptNothing === true) {
      client.write(Buffer.from([VERSION, 0xff]));
      return;
    }

    if (behaviour.wants !== undefined) {
      client.write(Buffer.from([VERSION, 0x02]));
      const head = await exactly(client, 2);
      if (head === null) return void client.destroy();
      const user = await exactly(client, head[1] ?? 0);
      const passwordLength = await exactly(client, 1);
      const password = await exactly(client, passwordLength?.[0] ?? 0);
      const right =
        user?.toString("utf8") === behaviour.wants.user && password?.toString("utf8") === behaviour.wants.password;
      client.write(Buffer.from([0x01, right ? 0x00 : 0x01]));
      if (!right) return;
    } else {
      client.write(Buffer.from([VERSION, 0x00]));
    }

    const request = await exactly(client, 4);
    if (request === null) return void client.destroy();

    // Only the name form, because that is the only one the relay sends: sending a
    // resolved address would put a DNS question out over the ordinary connection.
    if (request[3] !== 0x03) {
      client.write(Buffer.from([VERSION, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const nameLength = await exactly(client, 1);
    const name = await exactly(client, nameLength?.[0] ?? 0);
    const port = await exactly(client, 2);
    asked.push(`${name?.toString("utf8") ?? ""}:${port?.readUInt16BE(0) ?? 0}`);

    if (behaviour.refuseWith !== undefined) {
      client.write(Buffer.from([VERSION, behaviour.refuseWith, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      return;
    }

    const upstream = connect(behaviour.to.port, behaviour.to.host);
    open.add(upstream);
    upstream.once("close", () => open.delete(upstream));
    upstream.once("error", () => {
      client.destroy();
      upstream.destroy();
    });
    await once(upstream, "connect");

    // Success, and a bound address the relay has to read off before the tunnel's
    // own bytes start.
    client.write(Buffer.from([VERSION, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
    client.pipe(upstream);
    upstream.pipe(client);
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: (server.address() as AddressInfo).port,
    asked,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}
