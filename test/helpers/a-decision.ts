import type { Charge, Decision, RequestFacts } from "../../src/relay/index.ts";

/**
 * A request shaped like a real Code session's, which is what most tests are
 * about.
 *
 * Named rather than repeated. Every relay test has to answer "who pays and what
 * is this", and a literal copied into a dozen files is a dozen places to forget
 * that a Refusal only counts against a Seat when `looksLikeCode` is true.
 */
export const LIKE_CODE: RequestFacts = { model: "claude-sonnet-5", looksLikeCode: true, session: "session-one" };

/** One decision: charge this, and the request was shaped like this. */
export const paying = (charge: Charge | null, about: RequestFacts = LIKE_CODE): Decision => ({ charge, about });
