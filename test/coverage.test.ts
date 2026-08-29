/**
 * The coverage matrix's judgement, as a table.
 *
 * The whole ticket rests on one rule, and it is the rule most likely to be quietly
 * softened later: coverage is judged by negative control and never by counting. A
 * request that went round the relay is simply absent, and an absence looks exactly
 * like work that never happened.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { asTable, judgePath, knownLimits, PATHS } from "../src/coverage/index.ts";

const NOTHING = { verified: 0, mismatch: 0, unverified: 0 };

test("work completing with the control armed is covered, and the reason says why", () => {
  const judged = judgePath({ workCompleted: true, negativeControl: true, saw: { ...NOTHING, verified: 7 } });
  assert.equal(judged.verdict, "covered");
  assert.match(judged.saying, /cannot buy anything/);
});

test("work completing with the control not armed proves nothing at all", () => {
  // This is the failure the whole method exists to prevent. Without the control,
  // work completing is just the Window's own credential doing its job, and calling
  // that "covered" is the app claiming a success nobody checked.
  const judged = judgePath({ workCompleted: true, negativeControl: false, saw: { ...NOTHING, verified: 7 } });
  assert.equal(judged.verdict, "not-covered");
  assert.match(judged.saying, /nothing was proved/);
});

test("work that did not complete and never reached the relay is a path that goes round it", () => {
  const judged = judgePath({ workCompleted: false, negativeControl: true, saw: NOTHING });
  assert.equal(judged.verdict, "not-covered");
  assert.match(judged.saying, /goes round it/);
});

test("work that did not complete while requests were swapped says something else stopped it", () => {
  // Told apart on purpose. "The relay never saw it" and "the relay carried it and
  // it still failed" send a reader to two entirely different places.
  const judged = judgePath({ workCompleted: false, negativeControl: true, saw: { ...NOTHING, verified: 4 } });
  assert.equal(judged.verdict, "not-covered");
  assert.match(judged.saying, /something else stopped it/);
});

test("an exchange the wrong Organization paid for fails the path whatever the work did", () => {
  const judged = judgePath({
    workCompleted: true,
    negativeControl: true,
    saw: { verified: 6, mismatch: 1, unverified: 0 },
  });
  assert.equal(judged.verdict, "not-covered");
  assert.match(judged.saying, /different Organization/);
});

test("work completing while the relay saw nothing is reported as impossible, not as covered", () => {
  // With the control armed this cannot happen, so it means the control is not
  // really where we think it is. Saying "covered" here would be the worst answer.
  const judged = judgePath({ workCompleted: true, negativeControl: true, saw: NOTHING });
  assert.equal(judged.verdict, "not-covered");
  assert.match(judged.saying, /should be impossible/);
});

test("the table holds a row for every path, measured or not, so nothing goes missing", () => {
  const table = asTable({ negativeControl: true, rows: [] }).join("\n");
  for (const path of PATHS) {
    assert.match(table, new RegExp(path.called.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // A path nobody has got to yet says so, rather than being absent from the table,
  // which is the same reason a Refusal is not a verdict: silence is not evidence.
  assert.equal((table.match(/not measured yet/g) ?? []).length, PATHS.length);
});

test("every path has steps a person can follow without guessing, and a reason to exist", () => {
  for (const path of PATHS) {
    assert.equal(path.byHand.length > 0, true, `${path.key} has no steps`);
    assert.equal(path.note.length > 20, true, `${path.key} does not say why it is measured`);
    assert.match(path.key, /^[a-z][a-z-]*$/, `${path.key} is not typeable`);
  }
  assert.equal(new Set(PATHS.map((one) => one.key)).size, PATHS.length, "two paths share a key");
});

test("known limits are every row that is not covered, so the README cannot omit one", () => {
  const limits = knownLimits({
    negativeControl: true,
    rows: [
      { key: "plain", verdict: "covered", on: "2026-08-22", versions: "x", saw: NOTHING, saying: "" },
      { key: "cowork", verdict: "not-covered", on: "2026-08-22", versions: "x", saw: NOTHING, saying: "its own stack" },
      { key: "cloud", verdict: "not-applicable", on: "2026-08-22", versions: "x", saw: NOTHING, saying: "elsewhere" },
    ],
  });
  assert.deepEqual(
    limits.map((one) => one.key),
    ["cowork", "cloud"],
    "a path that is not covered is a limit whether it is our fault or not",
  );
});
