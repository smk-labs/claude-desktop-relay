/**
 * Reading what a reply cost, and reading nothing else.
 *
 * The second of those is the one that matters. This module is the only thing in
 * the program that sees generated text, so the test that earns it is the one that
 * writes a passphrase into every field of a real reply and asserts it appears in
 * nothing that comes out.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { counted, openScanner } from "../src/tokens/index.ts";

const SECRET = "correct-horse-battery-staple";

/** A streaming reply in the shape Anthropic publishes, with text in every slot. */
function aStreamingReply(options: { input: number; output: number; cacheWritten?: number; cacheRead?: number }) {
  const usage = {
    input_tokens: options.input,
    cache_creation_input_tokens: options.cacheWritten ?? 0,
    cache_read_input_tokens: options.cacheRead ?? 0,
    output_tokens: 1,
  };
  return [
    `event: message_start\n`,
    `data: ${JSON.stringify({ type: "message_start", message: { id: `msg_${SECRET}`, role: "assistant", content: [], usage } })}\n\n`,
    `event: content_block_delta\n`,
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: `here is the answer: ${SECRET}` } })}\n\n`,
    `event: message_delta\n`,
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: options.output } })}\n\n`,
  ];
}

test("a streaming reply's counts are read from message_start and message_delta together", () => {
  const scanner = openScanner();
  for (const part of aStreamingReply({ input: 1200, output: 340, cacheWritten: 90, cacheRead: 8000 })) {
    scanner.take(part);
  }

  assert.deepEqual(scanner.counts(), { input: 1200, output: 340, cacheWritten: 90, cacheRead: 8000 });
});

test("the last output count wins, because a stream reports a partial one first", () => {
  const scanner = openScanner();
  scanner.take(`data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n`);
  scanner.take(`data: {"type":"message_delta","usage":{"output_tokens":900}}\n`);

  assert.equal(scanner.counts()?.output, 900);
});

test("counts split across two chunks are still read, because a stream splits where it likes", () => {
  const whole = aStreamingReply({ input: 1200, output: 340 }).join("");

  // Every possible split point, so this cannot pass by luck of chunk size.
  for (let at = 1; at < whole.length; at += 7) {
    const scanner = openScanner();
    scanner.take(whole.slice(0, at));
    scanner.take(whole.slice(at));
    assert.deepEqual(
      scanner.counts(),
      { input: 1200, output: 340, cacheWritten: 0, cacheRead: 0 },
      `split at ${at} lost a count`,
    );
  }
});

test("byte-at-a-time is read the same as one chunk, which is the worst case a stream can give", () => {
  const whole = aStreamingReply({ input: 55, output: 66 }).join("");
  const scanner = openScanner();
  for (const character of whole) scanner.take(character);

  assert.deepEqual(scanner.counts(), { input: 55, output: 66, cacheWritten: 0, cacheRead: 0 });
});

test("a reply that is not streamed carries one usage object, and is read the same way", () => {
  const scanner = openScanner();
  scanner.take(
    JSON.stringify({
      type: "message",
      content: [{ type: "text", text: `the whole answer, ${SECRET}` }],
      usage: { input_tokens: 7, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  );

  assert.deepEqual(scanner.counts(), { input: 7, output: 8, cacheWritten: 0, cacheRead: 0 });
});

test("a reply with no counts reads as none, never as zero", () => {
  const scanner = openScanner();
  scanner.take(`data: {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}\n`);

  // Zero is a claim about what the work cost. None is the truth about what we know,
  // and a history row that says zero where it means unknown is a wrong total later.
  assert.equal(scanner.counts(), null);
  assert.equal(counted({ input: 0, output: 0, cacheWritten: 0, cacheRead: 0 }), false);
});

test("a name the server has changed reads as none, rather than as a wrong number", () => {
  const scanner = openScanner();
  scanner.take(`data: {"type":"message_delta","usage":{"completion_tokens":900}}\n`);
  assert.equal(scanner.counts(), null);
});

/**
 * The test that earns this module.
 *
 * It is the only thing in the program that sees generated text. What it emits has
 * to be four integers and nothing else, and the passphrase is in the message id,
 * in a content block, and in the prose of a reply.
 */
test("nothing this emits carries a word of the reply", () => {
  const scanner = openScanner();
  for (const part of aStreamingReply({ input: 10, output: 20 })) scanner.take(part);

  const emitted = JSON.stringify(scanner.counts());
  assert.equal(emitted.includes(SECRET), false, "a word of the reply reached what this emits");
  assert.equal(emitted.includes("assistant"), false);
  assert.equal(emitted.includes("msg_"), false);
  assert.match(emitted, /^\{"input":10,"output":20,"cacheWritten":0,"cacheRead":0\}$/);
});

test("a reply of any length costs a fixed and tiny amount of memory", () => {
  const scanner = openScanner();
  // Forty megabytes of generated text through a scanner that keeps a few hundred
  // bytes. Without a bounded window this is where a long session ran the machine
  // out of memory instead of the disk.
  const chunk = "x".repeat(1024 * 1024);
  for (let megabyte = 0; megabyte < 40; megabyte += 1) scanner.take(chunk);
  scanner.take(`data: {"type":"message_delta","usage":{"output_tokens":5}}\n`);

  assert.equal(scanner.counts()?.output, 5);
  // Measured rather than reasoned about: the whole scanner, serialised.
  const held = JSON.stringify(scanner.counts()).length;
  assert.equal(held < 200, true, `it held ${held} bytes`);
});
