import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { findViolations, checkSourceTree } from "../src/boundaries/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fixture files are built rather than written out, so this test file contains no
 * literal quoted relative specifier of its own. The checker reads `test/` as well
 * as `src/`, and it cannot tell a specifier in code from one inside a string, so a
 * pasted `from "../x/y.ts"` here would be checked as if this file imported it.
 */
const importing = (...specifiers: string[]) =>
  specifiers.map((s) => `import x from ${JSON.stringify(s)};`).join("\n");
const reexporting = (specifier: string) => `export { a } from ${JSON.stringify(specifier)};`;
const dynamically = (specifier: string) => `const b = await import(${JSON.stringify(specifier)});`;

test("reaching past another module's entry point is a violation", () => {
  const violations = findViolations({
    "src/relay/index.ts": importing("../seats/internal/store.ts"),
    "src/seats/index.ts": "",
    "src/seats/internal/store.ts": "",
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.from, "src/relay/index.ts");
  assert.equal(violations[0]?.to, "src/seats/internal/store.ts");
  assert.match(violations[0]?.reason ?? "", /reaches past the seats module's entry point/);
});

test("removing that import passes", () => {
  const violations = findViolations({
    "src/relay/index.ts": importing("../seats/index.ts"),
    "src/seats/index.ts": "",
    "src/seats/internal/store.ts": "",
  });

  assert.deepEqual(violations, []);
});

test("a module may reach its own internals", () => {
  const violations = findViolations({
    "src/seats/index.ts": importing("./internal/store.ts"),
    "src/seats/internal/store.ts": importing("./keychain.ts"),
    "src/seats/internal/keychain.ts": "",
  });

  assert.deepEqual(violations, []);
});

test("bare specifiers are not module imports", () => {
  const violations = findViolations({
    "src/relay/index.ts": importing("node:http", "tls"),
  });

  assert.deepEqual(violations, []);
});

test("a file loose in src may only reach an entry point", () => {
  const violations = findViolations({
    "src/main.ts": importing("./relay/index.ts", "./relay/internal/mitm.ts"),
    "src/relay/index.ts": "",
    "src/relay/internal/mitm.ts": "",
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.to, "src/relay/internal/mitm.ts");
  assert.equal(violations[0]?.line, 2);
});

test("a test may only reach an entry point either, because that is the test surface", () => {
  const violations = findViolations({
    "test/relay.test.ts": importing("../src/relay/internal/mitm.ts"),
    "src/relay/index.ts": "",
    "src/relay/internal/mitm.ts": "",
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.from, "test/relay.test.ts");
});

test("tests may share helpers with each other", () => {
  const violations = findViolations({
    "test/relay.test.ts": importing("./helpers/fake-upstream.ts", "../src/relay/index.ts"),
    "test/helpers/fake-upstream.ts": "",
    "src/relay/index.ts": "",
  });

  assert.deepEqual(violations, []);
});

test("a compiled-style .js specifier is reported, because these files are never compiled", () => {
  const violations = findViolations({
    "src/relay/index.ts": importing("../seats/index.js"),
    "src/seats/index.ts": "",
  });

  assert.equal(violations.length, 1);
  assert.match(violations[0]?.reason ?? "", /no such file/);
  assert.match(violations[0]?.reason ?? "", /explicit \.ts extension/);
});

test("dynamic imports and re-exports are seen too", () => {
  const violations = findViolations({
    "src/relay/index.ts":
      reexporting("../seats/internal/store.ts") + "\n" + dynamically("../seats/internal/keychain.ts"),
    "src/seats/internal/store.ts": "",
    "src/seats/internal/keychain.ts": "",
  });

  assert.equal(violations.length, 2);
});

test("a commented-out import is not counted, and the lines still line up", () => {
  const violations = findViolations({
    "src/relay/index.ts": `// ${importing("../seats/internal/store.ts")}\n${importing("../seats/internal/store.ts")}`,
    "src/seats/internal/store.ts": "",
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.line, 2);
});

test("the check bites on real files on disk, not only on trees in memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-boundaries-"));
  try {
    await mkdir(join(root, "src/relay"), { recursive: true });
    await mkdir(join(root, "src/seats/internal"), { recursive: true });
    await writeFile(join(root, "src/seats/index.ts"), "");
    await writeFile(join(root, "src/seats/internal/store.ts"), "");

    const offending = join(root, "src/relay/index.ts");
    await writeFile(offending, importing("../seats/internal/store.ts"));

    const red = await checkSourceTree(root);
    assert.equal(red.length, 1);
    assert.equal(red[0]?.from, "src/relay/index.ts");

    await writeFile(offending, importing("../seats/index.ts"));
    assert.deepEqual(await checkSourceTree(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a command may only reach an entry point either", () => {
  const violations = findViolations({
    "scripts/start.ts": importing("../src/relay/internal/open.ts"),
    "src/relay/index.ts": "",
    "src/relay/internal/open.ts": "",
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.from, "scripts/start.ts");
});

test("this repo's own source tree has no violations", async () => {
  const violations = await checkSourceTree(repoRoot);
  assert.deepEqual(violations, [], violations.map((v) => v.reason).join("\n"));
});
