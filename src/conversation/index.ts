/**
 * Whether a request begins a new conversation, decided without reading a word of
 * it.
 *
 * This is the one module allowed near a request body, and the whole of what it
 * takes from one is four things: the model, how many messages there are, the
 * session id the CLI generated, and whether the Claude Code system prompt is
 * there at all. It retains and emits nothing else, which a test asserts over
 * everything it returns.
 *
 * It exists because prompt caching is bound to the paying Organization (ADR
 * 0003): a Payer that changes mid-conversation re-charges the whole history to the
 * new Seat. Auto used to hold its pick for a conversation's life for exactly that
 * reason, and nothing is gated on the boundary since that hold was unshipped. What
 * is left is the count of live conversations, which is what says how much a switch
 * just cost.
 */
export type { Shape } from "./internal/shape.ts";
export { shapeOf, UNREADABLE } from "./internal/shape.ts";
export type { Boundary, Conversations } from "./internal/boundaries.ts";
export { openConversations } from "./internal/boundaries.ts";
