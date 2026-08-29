import type { Shape } from "./shape.ts";

/**
 * Where one request sits in the life of a conversation.
 *
 * `conversation` is a handle and never a name: it is the CLI's own session id
 * where there is one, and otherwise a stand-in built from the model. It held a
 * Payer steady once. That hold was unshipped, and what these boundaries do now is
 * keep the count of live conversations, which is how a switch is reported with
 * what it cost.
 */
export type Boundary = {
  /** Which conversation this request belongs to, or null when that cannot be told. */
  readonly conversation: string | null;
  /**
   * Whether this request begins one.
   *
   * False whenever the answer is not known. Prompt caching is bound to the paying
   * Organization (ADR 0003), so switching on a guess re-charges the whole history
   * to a new Seat, and the cost of guessing wrong in this direction is a wasted
   * decision where the other direction is a doubled bill.
   */
  readonly beginsNew: boolean;
};

/** Nothing could be told about this request. The caller keeps what it had. */
const UNKNOWN: Boundary = { conversation: null, beginsNew: false };

/**
 * How long a conversation is remembered after its last request.
 *
 * Long enough that a user who walks away from a session and comes back to it is
 * still on the Seat they started on; short enough that a machine left running for
 * a month is not holding a handle for every session it ever saw. Session ids are
 * small and the count is in the hundreds, so this is about tidiness rather than
 * memory.
 */
const FORGET_AFTER_SECONDS = 12 * 60 * 60;

export type Conversations = {
  /** Place one request, from its shape alone, at a stated moment. */
  place(shape: Shape, at: number): Boundary;
  /** How many conversations are being held. For a status line and for tests. */
  held(): number;
};

/**
 * Tell one conversation from another, from the shape of a request and nothing
 * else.
 *
 * Two of them running at once is ordinary here: a session and the subagent it
 * started are separate conversations in the same process, sending down the same
 * connection. They are told apart by the session id the CLI puts in its own
 * metadata, which is why that is read at all.
 *
 * When there is no session id the model and the depth answer instead, which is
 * weaker and known to be: it can say "this is a first request" but it cannot say
 * whose. That is the honest limit of a body that does not identify itself.
 */
export function openConversations(options: { forgetAfterSeconds?: number } = {}): Conversations {
  const forgetAfter = options.forgetAfterSeconds ?? FORGET_AFTER_SECONDS;
  const seen = new Map<string, number>();

  const forgetTheOld = (at: number) => {
    for (const [conversation, lastSeen] of seen) {
      if (at - lastSeen > forgetAfter) seen.delete(conversation);
    }
  };

  return {
    held: () => seen.size,

    place(shape, at) {
      if (shape.messages === null) return UNKNOWN;
      forgetTheOld(at);

      // No session id: the depth is all there is. A request carrying one message
      // begins something; anything deeper continues something, even though which
      // something cannot be said.
      if (shape.session === null) {
        return { conversation: null, beginsNew: shape.messages <= 1 };
      }

      const beginsNew = !seen.has(shape.session);
      seen.set(shape.session, at);
      return { conversation: shape.session, beginsNew };
    },
  };
}
