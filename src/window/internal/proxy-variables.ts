/** Where the relay is listening. */
export type Address = { readonly host: string; readonly port: number };

/**
 * Hosts that must never go through the relay, or the relay would be asked to
 * reach itself.
 */
const NEVER = "localhost,127.0.0.1,::1,.local";

/**
 * Every proxy variable, in every case and every scheme.
 *
 * All of them, deliberately. A login shell commonly exports the lowercase names
 * already, and the lowercase name wins in the tools that read both, so setting
 * only the uppercase ones looks like it worked and quietly does nothing. The
 * SOCKS name is overridden too: a machine with `all_proxy=socks5h://...` would
 * otherwise send Code somewhere the relay cannot follow, because the relay speaks
 * HTTP CONNECT.
 *
 * The certificate variable is not here on purpose. The Window computes its own
 * value for that after it has read its environment, so it has to go through the
 * app's own store instead. See ADR 0006.
 */
export function proxyVariables(relay: Address): Readonly<Record<string, string>> {
  const at = `http://${relay.host}:${relay.port}`;

  return {
    HTTPS_PROXY: at,
    https_proxy: at,
    HTTP_PROXY: at,
    http_proxy: at,
    ALL_PROXY: at,
    all_proxy: at,
    NO_PROXY: NEVER,
    no_proxy: NEVER,
  };
}
