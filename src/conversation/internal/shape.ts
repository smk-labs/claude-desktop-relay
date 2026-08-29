/**
 * The one place in this program that goes near a request body.
 *
 * It reads four things and keeps none of them beyond the answer: which model was
 * asked for, how many messages the request carries, which session the CLI named
 * in its own metadata, and whether the request is shaped like a real Claude Code
 * request at all. No part of any message is returned, logged or stored, and a
 * test asserts that over the whole of what this emits.
 */

/** The phrase a real Code session's system prompt opens with. Measured; ADR 0005. */
const CLAUDE_CODE = "You are Claude Code";

/**
 * Everything read off a body, and the whole of it.
 *
 * Every field here is a count, a name the user chose from a menu, or an
 * identifier the CLI generated. None of them can carry a sentence the user
 * wrote, which is the property the privacy test is really checking.
 */
export type Shape = {
  /** The model asked for, or null when the body did not name one. */
  readonly model: string | null;
  /**
   * How many messages the request carries, which is how far into a conversation
   * it is. Null when the body could not be read at all.
   */
  readonly messages: number | null;
  /** The session the CLI named in its metadata. Never anything from a message. */
  readonly session: string | null;
  /**
   * Whether this request carries the Claude Code system prompt.
   *
   * A request without it is refused for every premium model with what reads like
   * an exhausted allowance while the Seat is untouched (ADR 0005). So a Refusal
   * on a request this is false for says nothing about the Seat, and the one place
   * that can tell is here, where the body is.
   */
  readonly looksLikeCode: boolean;
};

/** A body nobody could read. Every field unknown, and no claim made about it. */
export const UNREADABLE: Shape = { model: null, messages: null, session: null, looksLikeCode: false };

type Loose = Record<string, unknown>;
const asObject = (value: unknown): Loose | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Loose) : null;
const asText = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * The session id out of `metadata.user_id`.
 *
 * The CLI packs a small JSON object into that string: the account uuid, a session
 * id, and sometimes a parent session id. Only the session id is taken. The
 * account uuid is deliberately left behind: it identifies a person and nothing
 * here needs it.
 */
function sessionFrom(metadata: unknown): string | null {
  const packed = asText(asObject(metadata)?.["user_id"]);
  if (packed === null) return null;

  try {
    return asText(asObject(JSON.parse(packed))?.["session_id"]);
  } catch {
    return null;
  }
}

/**
 * Whether the system prompt is Claude Code's own.
 *
 * Only the opening of the first block is looked at, and only to answer yes or no.
 * The prompt is ours, not the user's, but the habit of reading no further than
 * the question needs is the one that keeps this module honest.
 */
function looksLikeCode(system: unknown): boolean {
  const opening =
    typeof system === "string"
      ? system
      : Array.isArray(system)
        ? (asText(asObject(system[0])?.["text"]) ?? "")
        : "";
  return opening.slice(0, CLAUDE_CODE.length + 8).includes(CLAUDE_CODE);
}

/**
 * Read a request body's shape, or report that it could not be read.
 *
 * Unreadable is a real answer and never an error: a body that arrived truncated,
 * or in some encoding this does not know, must leave the caller holding whatever
 * it already had rather than switching a Payer on a guess.
 */
export function shapeOf(body: Buffer | string | null): Shape {
  if (body === null || body.length === 0) return UNREADABLE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
  } catch {
    return UNREADABLE;
  }

  const held = asObject(parsed);
  if (held === null) return UNREADABLE;

  const messages = held["messages"];

  return {
    model: asText(held["model"]),
    messages: Array.isArray(messages) ? messages.length : null,
    session: sessionFrom(held["metadata"]),
    looksLikeCode: looksLikeCode(held["system"]),
  };
}
