/**
 * A SOCKS5 tunnel, so a machine that names only a SOCKS proxy is carried rather
 * than stopped.
 *
 * Before this, such a machine was refused with a sentence naming the proxy. That
 * was safe and not good enough: refusing beats going round the tunnel (ADR 0011),
 * but the user's own machine is one setting away from this case, and a proxy
 * switched into SOCKS-only mode would have stopped every Code session.
 *
 * Eighty lines of byte layout rather than a dependency, and everything that can go
 * wrong is a real answer with the proxy's own reason attached. Nothing here ever
 * falls back to going direct.
 */
export type { SocksCredentials } from "./internal/connect.ts";
export { socksConnect } from "./internal/connect.ts";
