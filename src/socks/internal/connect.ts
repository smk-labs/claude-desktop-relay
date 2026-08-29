import { connect, type Socket } from "node:net";
import { once } from "node:events";

/**
 * A SOCKS5 CONNECT, and nothing else.
 *
 * Four exchanges: a greeting, the method the proxy picked, the request, and the
 * reply. Written out by hand because it is small and because pulling a dependency
 * in for eighty lines of byte layout is a supply chain for no reason.
 *
 * Every failure here is a real answer. A proxy that refuses, or that answers
 * something this does not understand, ends the request: it is never gone round
 * (ADR 0011), and the sentence names what the proxy actually said so the user can
 * act on it.
 */

const VERSION = 5;

/** The authentication methods this speaks, as the protocol numbers them. */
const NO_AUTHENTICATION = 0x00;
const USERNAME_AND_PASSWORD = 0x02;
const NOTHING_ACCEPTABLE = 0xff;

/** The one command this needs. Bind and UDP-associate are not ours to want. */
const CONNECT = 0x01;

/** Address kinds. A name is sent as a name so the proxy resolves it, not us. */
const A_NAME = 0x03;
const AN_IPV4 = 0x01;
const AN_IPV6 = 0x04;

/** The version of the username-and-password sub-negotiation, which is its own. */
const AUTH_VERSION = 0x01;
const AUTH_OK = 0x00;

/**
 * What the proxy said went wrong, in its own words.
 *
 * Named rather than numbered, because "the proxy answered 5" tells a user nothing
 * and "the proxy says that host is unreachable" tells them where to look.
 */
const WHY_IT_REFUSED: Readonly<Record<number, string>> = {
  0x01: "the proxy had a failure of its own",
  0x02: "the proxy is not allowed to make that connection",
  0x03: "the network is unreachable from the proxy",
  0x04: "that host is unreachable from the proxy",
  0x05: "the connection was refused",
  0x06: "the time to live expired",
  0x07: "the proxy does not support that command",
  0x08: "the proxy does not support that kind of address",
};

/** A username and password for a proxy that asks for one. */
export type SocksCredentials = { readonly user: string; readonly password: string };

/**
 * Read exactly this many bytes, or fail saying how far it got.
 *
 * Exactly, because every field below is a fixed width and a short read that is
 * treated as a whole one is how a protocol parser starts inventing addresses.
 */
async function exactly(socket: Socket, howMany: number): Promise<Buffer> {
  const held: Buffer[] = [];
  let have = 0;

  while (have < howMany) {
    const chunk = socket.read(howMany - have) ?? socket.read();
    if (chunk === null) {
      // Nothing buffered. Wait for more, and treat the socket ending as the
      // failure it is rather than as an empty answer.
      const more = await Promise.race([
        once(socket, "readable").then(() => true as const),
        once(socket, "end").then(() => false as const),
        once(socket, "close").then(() => false as const),
      ]);
      if (!more) {
        throw new Error(`the SOCKS proxy closed the connection after ${have} of ${howMany} bytes`);
      }
      continue;
    }
    held.push(chunk as Buffer);
    have += (chunk as Buffer).length;
  }

  return Buffer.concat(held).subarray(0, howMany);
}

/** The greeting: the version and the methods we are willing to use. */
function greeting(withCredentials: boolean): Buffer {
  const methods = withCredentials ? [NO_AUTHENTICATION, USERNAME_AND_PASSWORD] : [NO_AUTHENTICATION];
  return Buffer.from([VERSION, methods.length, ...methods]);
}

/** The request: connect me to this host and port. */
function askFor(host: string, port: number): Buffer {
  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw new Error(`the host name is too long for SOCKS5 (${name.length} bytes)`);

  const where = Buffer.alloc(2);
  where.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([VERSION, CONNECT, 0x00, A_NAME, name.length]), name, where]);
}

/** How many bytes of address follow, given the kind the proxy answered with. */
async function skipTheBoundAddress(socket: Socket, kind: number): Promise<void> {
  if (kind === AN_IPV4) return void (await exactly(socket, 4 + 2));
  if (kind === AN_IPV6) return void (await exactly(socket, 16 + 2));
  if (kind === A_NAME) {
    const [length] = await exactly(socket, 1);
    return void (await exactly(socket, (length ?? 0) + 2));
  }
  throw new Error(`the SOCKS proxy answered with an address kind this does not know (${kind})`);
}

/**
 * Open a tunnel to `host:port` through a SOCKS5 proxy, and hand back the socket.
 *
 * The host is sent as a name rather than resolved here, so the proxy does the
 * looking up. That matters on the machine this is for: resolving it locally would
 * put a DNS question for `api.anthropic.com` out over the ordinary connection,
 * which is exactly what the tunnel exists to prevent.
 */
export async function socksConnect(options: {
  readonly through: { readonly host: string; readonly port: number };
  readonly to: { readonly host: string; readonly port: number };
  readonly credentials?: SocksCredentials | null;
  /** Injected so a test never opens a socket of its own making. */
  readonly open?: (port: number, host: string) => Socket;
}): Promise<Socket> {
  const socket = (options.open ?? ((port, host) => connect(port, host)))(
    options.through.port,
    options.through.host,
  );
  socket.setNoDelay(true);

  try {
    await once(socket, "connect");
    const credentials = options.credentials ?? null;

    socket.write(greeting(credentials !== null));
    const [version, chosen] = await exactly(socket, 2);

    if (version !== VERSION) {
      throw new Error(`${options.through.host}:${options.through.port} is not a SOCKS5 proxy (it answered version ${version})`);
    }

    if (chosen === NOTHING_ACCEPTABLE) {
      throw new Error(
        credentials === null
          ? `the SOCKS proxy at ${options.through.host}:${options.through.port} wants authentication, and none is set. ` +
            `Give it a username and password, or point the machine at a proxy that does not ask.`
          : `the SOCKS proxy at ${options.through.host}:${options.through.port} would accept none of the ways this can authenticate`,
      );
    }

    if (chosen === USERNAME_AND_PASSWORD) {
      if (credentials === null) {
        // Refused rather than ignored: a proxy that asked for a password and got
        // none would otherwise fail a step later with a confusing reason.
        throw new Error(
          `the SOCKS proxy at ${options.through.host}:${options.through.port} asked for a username and password, ` +
            `and none is set for it.`,
        );
      }
      const user = Buffer.from(credentials.user, "utf8");
      const password = Buffer.from(credentials.password, "utf8");
      if (user.length > 255 || password.length > 255) {
        throw new Error(`the SOCKS username or password is too long (255 bytes each at most)`);
      }
      socket.write(
        Buffer.concat([Buffer.from([AUTH_VERSION, user.length]), user, Buffer.from([password.length]), password]),
      );
      const [, status] = await exactly(socket, 2);
      if (status !== AUTH_OK) {
        throw new Error(`the SOCKS proxy at ${options.through.host}:${options.through.port} rejected the username and password`);
      }
    } else if (chosen !== NO_AUTHENTICATION) {
      throw new Error(`the SOCKS proxy chose a way to authenticate this does not speak (${chosen})`);
    }

    socket.write(askFor(options.to.host, options.to.port));
    const [, reply, , kind] = await exactly(socket, 4);

    if (reply !== 0x00) {
      throw new Error(
        `the SOCKS proxy would not open a tunnel to ${options.to.host}:${options.to.port}: ` +
          `${WHY_IT_REFUSED[reply ?? -1] ?? `it answered ${reply}`}`,
      );
    }

    // Read and thrown away. It is the address the proxy bound on its own side,
    // which nothing here needs, but it has to come off the socket before the
    // tunnel's own bytes start or it would be read as part of the reply.
    await skipTheBoundAddress(socket, kind ?? 0);

    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
