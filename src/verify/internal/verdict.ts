import type { Exchange } from "../../relay/index.ts";

/**
 * Whether the Seat that was chosen is the one that paid.
 *
 * One question only, and the one the spec gives this module: who paid. Whether the
 * request also succeeded is a separate fact, carried alongside as `refused`. A
 * Refusal that names the chosen Seat's own Organization is positive proof the swap
 * worked, so flattening the two would throw that proof away, and ADR 0005 is
 * exactly about not reading a Refusal as more than it is.
 */
export type Verdict = {
  readonly kind: "verified" | "mismatch" | "unverified";
  /** The Seat that was chosen, or null when none was. */
  readonly seat: string | null;
  /** The Organization id that should have paid, or null when no Seat was chosen. */
  readonly expected: string | null;
  /** The Organization id the server says paid, or null when it did not say. */
  readonly paidBy: string | null;
  readonly method: string;
  readonly path: string;
  /** The status the server answered with. Zero when it never answered. */
  readonly status: number;
  /** The server declined this request, whoever paid for the attempt. */
  readonly refused: boolean;
  /** Why this is not `verified`, when it is not. */
  readonly because: Because | null;
};

/** The reasons a verdict falls short of proof, as reasons rather than prose. */
export type Because =
  | "no-seat-was-chosen"
  | "the-relay-did-not-swap"
  | "the-server-never-answered"
  | "the-server-named-no-organization"
  | "the-seat-has-no-organization-id"
  | "the-answer-was-not-a-success"
  | "a-different-organization-paid";

/** An Organization id we are willing to compare. Blank proves nothing. */
function named(id: string | null | undefined): string | null {
  const trimmed = (id ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Compare the Seat that was chosen against the Organization the server says paid.
 *
 * Agreement between two Organization ids that both actually exist is the only way
 * to reach `verified`. Two blanks are not agreement, and neither is a redirect: an
 * answer that is not a success has not told us that this request was served, so it
 * cannot prove who served it.
 */
/**
 * Judge one exchange, from the exchange alone.
 *
 * Nothing is passed in beside it on purpose. The Seat that was charged travels
 * with the exchange, so a verdict cannot be about a different request than the
 * one it names. When these were separate, thirty concurrent requests each
 * overwrote the other's Seat and the verdicts were about whoever happened to be
 * last.
 */
export function judge(exchange: Exchange): Verdict {
  const charged = exchange.chargedTo;

  const base = {
    seat: charged?.seat ?? null,
    expected: named(charged?.organizationId),
    paidBy: named(exchange.paidBy),
    method: exchange.method,
    path: exchange.path,
    status: exchange.status,
    refused: exchange.refused,
  };

  const short = (because: Because): Verdict => ({ ...base, kind: "unverified", because });

  if (charged === null) return short("no-seat-was-chosen");
  if (!exchange.swapped) return short("the-relay-did-not-swap");
  if (exchange.status === 0) return short("the-server-never-answered");
  if (base.expected === null) return short("the-seat-has-no-organization-id");
  if (base.paidBy === null) return short("the-server-named-no-organization");
  if (base.paidBy !== base.expected) return { ...base, kind: "mismatch", because: "a-different-organization-paid" };
  if (exchange.status < 200 || exchange.status >= 300) return short("the-answer-was-not-a-success");

  return { ...base, kind: "verified", because: null };
}

/** Nothing but a verified exchange exits zero. */
export function exitCodeFor(verdict: Verdict): number {
  return verdict.kind === "verified" ? 0 : 1;
}

const REASONS: Record<Because, string> = {
  "no-seat-was-chosen": "no Seat was chosen for it, so it was paid for by the Window account",
  "the-relay-did-not-swap": "the relay left the caller's own credential in place",
  "the-server-never-answered": "the server never answered, so nothing can be said about who paid",
  "the-server-named-no-organization": "the server did not say which Organization paid",
  "the-seat-has-no-organization-id": "the chosen Seat has no Organization id to check against",
  "the-answer-was-not-a-success": "the answer was not a success, so it does not show who served the request",
  "a-different-organization-paid": "a different Organization paid",
};

/**
 * One plain sentence, built when it is read rather than when it is recorded.
 *
 * Nothing stored on disk is English, so rewording this does not rewrite records
 * that were already kept.
 */
export function describeVerdict(verdict: Verdict): string {
  const where = `${verdict.method} ${verdict.path}`;
  const declined = verdict.refused ? `, and the server declined it with ${verdict.status}` : "";

  if (verdict.kind === "verified") {
    return (
      `${where}: the Seat "${verdict.seat}" paid, confirmed by the server naming ` +
      `${verdict.paidBy} as the Organization that paid${declined}.`
    );
  }

  if (verdict.kind === "mismatch") {
    return (
      `${where}: the wrong Seat paid. "${verdict.seat}" was chosen, whose Organization is ` +
      `${verdict.expected}, but the server says ${verdict.paidBy} paid for this request${declined}.`
    );
  }

  const reason = verdict.because === null ? "it could not be checked" : REASONS[verdict.because];
  return `${where}: unproved, because ${reason}${declined}.`;
}

/**
 * Whether this verdict says anything about a swap.
 *
 * A Code session makes many requests the relay was never asked to move: settings,
 * telemetry, a registry listing. Judging those produces a verdict that is true and
 * useless, and keeping the last of them as "the verdict" reports unverified
 * moments after a swap was verified. Only requests the relay was asked to pay for
 * are evidence about paying.
 */
export function isAboutASwap(verdict: Verdict): boolean {
  return verdict.because !== "no-seat-was-chosen" && verdict.because !== "the-relay-did-not-swap";
}
