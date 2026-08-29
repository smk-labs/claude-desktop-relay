import { strict as assert } from "node:assert";
import { test } from "node:test";

import { openConversations, shapeOf, UNREADABLE, type Shape } from "../src/conversation/index.ts";

const CLAUDE_CODE = "You are Claude Code, Anthropic's official CLI for Claude.";

/** A body shaped the way a real Code session writes one. */
function aCodeRequest(over: {
  model?: string;
  messages?: unknown[];
  session?: string | null;
  system?: unknown;
} = {}): string {
  const body: Record<string, unknown> = {
    model: over.model ?? "claude-opus-5",
    max_tokens: 32000,
    system: "system" in over ? over.system : [{ type: "text", text: CLAUDE_CODE }],
    messages: over.messages ?? [{ role: "user", content: "what does this repository do?" }],
  };
  if (over.session !== null) {
    body["metadata"] = {
      user_id: JSON.stringify({
        account_uuid: "6f1b0c5e-0000-0000-0000-000000000000",
        session_id: over.session ?? "session-one",
      }),
    };
  }
  return JSON.stringify(body);
}

test("a body yields the model, the depth and the session, and says whether it is Claude Code's", () => {
  const shape = shapeOf(aCodeRequest({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }));
  assert.equal(shape.model, "claude-opus-5");
  assert.equal(shape.messages, 2);
  assert.equal(shape.session, "session-one");
  assert.equal(shape.looksLikeCode, true);
});

test("a request without the Claude Code system prompt is known to be shaped wrong", () => {
  assert.equal(shapeOf(aCodeRequest({ system: undefined })).looksLikeCode, false);
  assert.equal(shapeOf(aCodeRequest({ system: [{ type: "text", text: "You are a helpful assistant." }] })).looksLikeCode, false);
  // A plain string system prompt is accepted too: the API takes both shapes.
  assert.equal(shapeOf(aCodeRequest({ system: `${CLAUDE_CODE} And more.` })).looksLikeCode, true);
});

test("a first request begins a conversation and a continuation does not", () => {
  const conversations = openConversations();
  const at = 1_700_000_000;

  const first = conversations.place(shapeOf(aCodeRequest()), at);
  assert.deepEqual(first, { conversation: "session-one", beginsNew: true });

  const second = conversations.place(
    shapeOf(aCodeRequest({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] })),
    at + 5,
  );
  assert.deepEqual(second, { conversation: "session-one", beginsNew: false });
});

test("two conversations in flight at once are told apart", () => {
  const conversations = openConversations();
  const at = 1_700_000_000;

  const one = conversations.place(shapeOf(aCodeRequest({ session: "session-one" })), at);
  const other = conversations.place(shapeOf(aCodeRequest({ session: "session-two" })), at);
  const oneAgain = conversations.place(shapeOf(aCodeRequest({ session: "session-one" })), at + 1);

  assert.equal(one.beginsNew, true);
  assert.equal(other.beginsNew, true, "a second session starting at the same moment is its own conversation");
  assert.notEqual(one.conversation, other.conversation);
  assert.equal(oneAgain.beginsNew, false, "the first session carries on, whatever the second did");
  assert.equal(conversations.held(), 2);
});

test("a body it cannot read is unknown, and unknown never begins a conversation", () => {
  const conversations = openConversations();

  for (const body of ["", "not json at all", "[1,2,3]", "null", Buffer.from("{\"messages\":")]) {
    assert.deepEqual(shapeOf(body as string | Buffer), UNREADABLE, `"${String(body).slice(0, 12)}" should read as unknown`);
    assert.deepEqual(
      conversations.place(shapeOf(body as string | Buffer), 1_700_000_000),
      { conversation: null, beginsNew: false },
      "nothing switches on a guess",
    );
  }

  // A body longer than the relay will hold arrives here as null, and must read
  // the same way as one that made no sense.
  assert.deepEqual(shapeOf(null), UNREADABLE);
  assert.equal(conversations.place(shapeOf(null), 1).beginsNew, false);
});

test("with no session id, depth alone decides, and says so by naming no conversation", () => {
  const conversations = openConversations();

  const first = conversations.place(shapeOf(aCodeRequest({ session: null })), 1);
  assert.deepEqual(first, { conversation: null, beginsNew: true });

  const deeper = conversations.place(
    shapeOf(aCodeRequest({ session: null, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] })),
    2,
  );
  assert.deepEqual(deeper, { conversation: null, beginsNew: false });
});

test("a conversation nobody has touched for long enough is forgotten", () => {
  const conversations = openConversations({ forgetAfterSeconds: 60 });
  conversations.place(shapeOf(aCodeRequest()), 1_000);
  assert.equal(conversations.held(), 1);

  const later = conversations.place(shapeOf(aCodeRequest({ session: "session-two" })), 1_000 + 61);
  assert.equal(later.beginsNew, true);
  assert.equal(conversations.held(), 1, "the old one was let go rather than kept for ever");
});

/**
 * The privacy rule, checked over everything the module emits rather than over one
 * field.
 *
 * The prompt below is put in every place a message can sit: the content of a
 * message, a content block inside one, a tool result, and the system prompt. Then
 * everything the module returns is serialised and searched. Put a field back that
 * carries a body through — `messages` as the array rather than its length, say —
 * and this fails.
 */
test("no word of a message appears in anything this module returns", () => {
  const SECRET = "the-passphrase-is-hunter2-and-the-repository-is-called-mercury";

  const body = JSON.stringify({
    model: "claude-opus-5",
    system: [{ type: "text", text: `${CLAUDE_CODE} ${SECRET}` }],
    metadata: { user_id: JSON.stringify({ account_uuid: "acct", session_id: "session-one", extra: SECRET }) },
    messages: [
      { role: "user", content: SECRET },
      { role: "assistant", content: [{ type: "text", text: SECRET }] },
      { role: "user", content: [{ type: "tool_result", content: SECRET }] },
    ],
  });

  const shape = shapeOf(body);
  const conversations = openConversations();
  const boundary = conversations.place(shape, 1);

  const emitted = JSON.stringify({ shape, boundary, held: conversations.held() });
  assert.ok(!emitted.includes(SECRET), `something the module emitted carried a message: ${emitted}`);
  assert.ok(!emitted.includes("hunter2"), "not even a fragment of one");

  // And what it does emit is still the answer, or this test would pass on a
  // module that returned nothing at all.
  assert.equal(shape.messages, 3);
  assert.equal(shape.session, "session-one");
  assert.equal(shape.looksLikeCode, true);
  assert.equal(boundary.beginsNew, true);
});

test("the account uuid the CLI packs beside the session id is left behind", () => {
  const shape: Shape = shapeOf(aCodeRequest());
  assert.ok(!JSON.stringify(shape).includes("6f1b0c5e"), "a person's account uuid is not ours to carry");
});
