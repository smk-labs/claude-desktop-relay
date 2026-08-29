import type { ClientRequest } from "node:http";

/**
 * Headers that belong to the hop, not to the request, and must not travel on.
 *
 * `connection` is the one that matters and it was missing. A caller that sends
 * `Connection: close` was having that forwarded, so the upstream closed after
 * every reply and nothing could ever be reused: forty requests, forty handshakes,
 * whatever the pool did. Forwarding it is also simply wrong, since a proxy must
 * not pass a header that describes the connection it arrived on.
 */
const HOP_ONLY = new Set(["proxy-connection", "connection", "keep-alive"]);

/**
 * The paths where a Send token decides who pays.
 *
 * Not every path under `/v1/`: a usage or model listing carries the caller's own
 * credential, and swapping it there would answer a question about the wrong
 * account. Anything not named here is left alone, because leaving a request on
 * the caller's own credential is the safe side of this decision.
 *
 * Counting tokens is here, which it was not at first. In one real session it was
 * 186 of the requests that went by, all of them landing on the Window account.
 * Two reasons that is wrong: it sends the conversation to an Organization that is
 * not paying for it, and it spends the Window account's own allowance on work
 * another Seat was chosen for, which is the whole thing this program exists to
 * stop.
 */
const PAID_FOR_BY_THE_PAYER = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

/** The path without its query string, so `?beta=true` still counts. */
function withoutQuery(path: string): string {
  const query = path.indexOf("?");
  return query === -1 ? path : path.slice(0, query);
}

export function isMessageEndpoint(path: string): boolean {
  return PAID_FOR_BY_THE_PAYER.has(withoutQuery(path));
}

/**
 * Put the caller's headers on the outgoing request exactly as they were written,
 * and, when a Send token was given, replace the credential.
 *
 * Names keep their casing and their order, because `setHeader` records what it is
 * given and the order it was given in. A header sent twice is sent twice.
 */
export function copyHeaders(rawHeaders: readonly string[], outgoing: ClientRequest, token: string | null): void {
  const seen = new Map<string, { name: string; values: string[] }>();

  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const value = rawHeaders[i + 1] as string;
    const key = name.toLowerCase();
    if (HOP_ONLY.has(key)) continue;

    const existing = seen.get(key);
    if (existing === undefined) seen.set(key, { name, values: [value] });
    else existing.values.push(value);
  }

  if (token !== null) {
    // The caller's own credential is replaced, not joined, and any competing one
    // is removed. A leftover key could quietly decide who pays, which is the one
    // thing the relay must never allow.
    const existing = seen.get("authorization");
    seen.set("authorization", { name: existing?.name ?? "authorization", values: [`Bearer ${token}`] });
    seen.delete("x-api-key");
  }

  for (const { name, values } of seen.values()) {
    outgoing.setHeader(name, values.length === 1 ? (values[0] as string) : values);
  }
}
