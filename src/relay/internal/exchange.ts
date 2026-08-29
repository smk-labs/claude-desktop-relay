import type { IncomingMessage } from "node:http";

/**
 * What was read off a request, carried onto the exchange it produced.
 *
 * Small on purpose: a name the user chose from a menu and a yes-or-no, never a
 * word anyone wrote. It travels with the exchange for the same reason the Charge
 * does. Kept beside the relay instead, thirty concurrent requests each overwrote
 * the others and every fact belonged to whoever happened to be last.
 */
export type RequestFacts = {
  /** The model asked for, or null when it was not named or could not be read. */
  readonly model: string | null;
  /**
   * Whether the request carried the Claude Code system prompt.
   *
   * A request without it is refused for every premium model with a message that
   * reads like an exhausted allowance, while the Seat is untouched (ADR 0005). So
   * a Refusal on a request this is false for is evidence about our own request and
   * says nothing about the Seat that paid for the attempt.
   */
  readonly looksLikeCode: boolean;
  /**
   * The session the CLI named in its own metadata, or null when it named none.
   *
   * An identifier the CLI generated, never anything from a message. It is here so
   * that a history row can be attributed to a project later: Claude Code writes a
   * session's transcript into a directory named after the working directory, so
   * the session id is the only link between an exchange and the repository the work
   * was for. The account uuid that travels beside it in the same field is
   * deliberately left behind, because it identifies a person and nothing here
   * needs it.
   */
  readonly session: string | null;
};

/** Nothing was asked, or nothing could be read. No claim either way. */
export const NOTHING_READ: RequestFacts = { model: null, looksLikeCode: false, session: null };

/**
 * Everything the relay knows about one exchange with the opened host, and
 * nothing else. No part of any request or reply body is here, and no credential.
 */
export type Exchange = {
  readonly method: string;
  /** The path as asked for, query included. Never a body. */
  readonly path: string;
  readonly status: number;
  /** The server declined this request. Evidence about one request, never a verdict. */
  readonly refused: boolean;
  /** Whether the relay put a Send token on this request. */
  readonly swapped: boolean;
  /**
   * The Seat the relay charged this request to, carried with the exchange itself.
   * Null when it charged nobody. Nothing keeps this aside between requests,
   * because thirty concurrent requests would then each answer for the others.
   */
  readonly chargedTo: { readonly seat: string; readonly organizationId: string } | null;
  /** The organization the server says paid, or null when it did not say. */
  readonly paidBy: string | null;
  /**
   * What the decider read off the request, carried here rather than kept aside.
   *
   * The relay never reads a body, so this arrives with the answer to "who pays"
   * and is forwarded verbatim. It is what lets a Refusal be judged against the
   * request that caused it instead of against the Seat that paid for the attempt.
   */
  readonly about: RequestFacts;
  readonly utilization: {
    readonly fiveHour: number | null;
    readonly sevenDay: number | null;
  };
  readonly overage: {
    readonly status: string | null;
    readonly disabledReason: string | null;
  };
  /** When each Allowance window resets, as seconds since 1970, or null if unsaid. */
  readonly resets: {
    readonly fiveHour: number | null;
    readonly sevenDay: number | null;
  };
  /**
   * Every header the reply carried, verbatim.
   *
   * The seven names below were measured, two of them the reset times, and
   * `factsFrom` reads those two into `resets`. Every other header is kept anyway
   * rather than filtered out: a figure arriving under a name we never measured is
   * still here to be found. A reply header cannot carry message content. See
   * docs/adr/0008.
   */
  readonly replyHeaders: Readonly<Record<string, string>>;
};

/**
 * Header names, every one of them measured on a real reply rather than guessed.
 * Measured 2026-08-21; see docs/mechanism.md.
 */
const PAID_BY = "anthropic-organization-id";
const FIVE_HOUR = "anthropic-ratelimit-unified-5h-utilization";
const SEVEN_DAY = "anthropic-ratelimit-unified-7d-utilization";
const FIVE_HOUR_RESET = "anthropic-ratelimit-unified-5h-reset";
const SEVEN_DAY_RESET = "anthropic-ratelimit-unified-7d-reset";
const OVERAGE = "anthropic-ratelimit-unified-overage-status";
const OVERAGE_REASON = "anthropic-ratelimit-unified-overage-disabled-reason";

/**
 * A status the server uses to decline a request.
 *
 * Anything from 400 up: the request did not get an answer it asked for. Whether
 * the Seat is actually spent is not decided here. ADR 0005 measured a Refusal
 * that had nothing to do with allowance at all, so this is evidence about one
 * request and never a verdict about a Seat.
 */
export function isRefusal(status: number): boolean {
  return status >= 400;
}

function one(headers: IncomingMessage["headers"], name: string): string | null {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function share(headers: IncomingMessage["headers"], name: string): number | null {
  const text = one(headers, name);
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** A moment the server states as seconds since 1970. */
function moment(headers: IncomingMessage["headers"], name: string): number | null {
  const value = share(headers, name);
  return value === null || value <= 0 ? null : Math.trunc(value);
}

/** Read the facts of one exchange off the reply's headers. */
export function factsFrom(options: {
  method: string;
  path: string;
  status: number;
  swapped: boolean;
  chargedTo: { seat: string; organizationId: string } | null;
  about: RequestFacts;
  headers: IncomingMessage["headers"];
}): Exchange {
  const replyHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers)) {
    replyHeaders[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  return {
    method: options.method,
    path: options.path,
    status: options.status,
    refused: isRefusal(options.status),
    swapped: options.swapped,
    chargedTo: options.chargedTo,
    paidBy: one(options.headers, PAID_BY),
    about: options.about,
    utilization: {
      fiveHour: share(options.headers, FIVE_HOUR),
      sevenDay: share(options.headers, SEVEN_DAY),
    },
    overage: {
      status: one(options.headers, OVERAGE),
      disabledReason: one(options.headers, OVERAGE_REASON),
    },
    resets: {
      fiveHour: moment(options.headers, FIVE_HOUR_RESET),
      sevenDay: moment(options.headers, SEVEN_DAY_RESET),
    },
    replyHeaders,
  };
}
