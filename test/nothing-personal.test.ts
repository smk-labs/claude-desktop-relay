/**
 * Nothing in this repository belongs to a real person.
 *
 * This is a public repository about credentials, written by somebody who had to
 * test it against their own accounts. Every fixture in `test/` started life as a
 * real account with a real Organization behind it, and the first scan before this
 * file existed found two hundred and twelve of them.
 *
 * A scrub is a thing you do once. This is the part that holds, and it is written
 * as shapes rather than as a list of names on purpose: a list of the names that
 * leaked would itself be the leak, and it would only ever catch the leak that
 * already happened. An address at a domain nobody reserved for documentation is
 * somebody's address whether or not anyone thought to add it here.
 *
 * Only files git is tracking are read, because those are the only ones that can
 * be pushed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The domains a documentation example is allowed to use.
 *
 * `example.com`, `.net` and `.org` are reserved by RFC 2606 for exactly this and
 * belong to nobody. `.example` is the reserved TLD from the same document, so
 * `me@work.example` is a valid way to say "some other machine".
 */
const MADE_UP_DOMAINS = /^(example\.(com|net|org)|[a-z0-9-]+\.example)$/;

/** The names a path is allowed to stand in for a person with. */
const NOBODY = new Set(["me", "you", "x", "user", "someone", "somebody", "example", "home", "root"]);

const AN_EMAIL = /[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

/**
 * A home directory, and the lookbehind is the whole of what makes it usable.
 *
 * Without it, `import { ON_WINDOWS } from "../../home/index.ts"` is a home
 * directory belonging to somebody called `index.ts`, and thirty-eight of those
 * drowned the two real ones on the first run. A path only counts when the leading
 * slash starts a path rather than continuing one.
 */
const A_HOME = /(?<![\w.~/-])(?:\/(?:Users|home)|[A-Za-z]:\\Users)[/\\]([A-Za-z0-9._-]+)/g;
const AN_ANTHROPIC_KEY = /sk-ant-[a-z0-9]+-([A-Za-z0-9_-]{16,})/g;

/**
 * Whether the tail of a token is a real one or a sentence somebody typed.
 *
 * Every placeholder in this repository reads as English with hyphens for spaces:
 * `a-token-that-only-a-test-ever-sees`. A real credential is base64url and cannot
 * be three or more all-lowercase alphabetic words in a row, so that is the test.
 * Length alone does not separate them, because the sentences are longer than the
 * keys, which is exactly why a length rule flagged nine fixtures and no secrets.
 */
function readsAsASentence(tail: string): boolean {
  const words = tail.split("-");
  return words.length >= 3 && words.every((word) => /^[a-z]+$/.test(word));
}

/**
 * The two files whose job is to carry strings shaped like a real credential.
 *
 * They prove that a token of the right shape is kept and one of the wrong shape
 * is refused, so a fixture in them has to look like the real thing or it tests
 * nothing at all. Named here rather than matched by a pattern, so that adding a
 * third is a decision somebody takes on purpose and not a hole that widens on its
 * own. Nothing exempts these files from the address rule or the path rule.
 */
const SHAPE_FIXTURES = new Set(["test/send-token.test.ts", "test/minting.test.ts"]);

/** Files whose bytes are not prose and cannot be read for names. */
const NOT_TEXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".zip", ".gz", ".pdf", ".woff", ".woff2"]);

/**
 * Every file that could be pushed, which is not the same as every tracked file.
 *
 * `git ls-files` alone reads what is already committed, and the file most likely
 * to be carrying something fresh is the one written ten minutes ago and not added
 * yet. This was proved by planting an address, a home directory and a key-shaped
 * string in a new file: the guard passed. So `--others --exclude-standard` is
 * here, which adds everything untracked that `.gitignore` does not already keep
 * out, and nothing that it does.
 */
function everyFileThatCouldBePushed(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter((one) => one !== "" && !NOT_TEXT.has(extname(one).toLowerCase()));
}

function read(path: string): string {
  try {
    return readFileSync(join(repo, path), "utf8");
  } catch {
    return "";
  }
}

/** Every match of a pattern, as `path:line  what` so a failure names the place. */
function offences(pattern: RegExp, judge: (match: RegExpExecArray) => boolean): string[] {
  const found: string[] = [];
  for (const path of everyFileThatCouldBePushed()) {
    // This file names the shapes it forbids, so reading it would fail on itself.
    if (path.endsWith("test/nothing-personal.test.ts")) continue;
    const lines = read(path).split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        if (judge(match as RegExpExecArray)) found.push(`${path}:${index + 1}  ${match[0]}`);
      }
    });
  }
  return found;
}

test("no address in this repository belongs to anybody", () => {
  const leaks = offences(AN_EMAIL, (match) => !MADE_UP_DOMAINS.test((match[1] ?? "").toLowerCase()));
  assert.deepEqual(
    leaks,
    [],
    `an email address at a domain somebody owns. Fixtures use example.com, which RFC 2606 reserves:\n${leaks.join("\n")}`,
  );
});

test("no path in this repository names whoever wrote it", () => {
  const leaks = offences(A_HOME, (match) => !NOBODY.has((match[1] ?? "").toLowerCase()));
  assert.deepEqual(
    leaks,
    [],
    `a home directory named after a person. Say /Users/me or /home/me:\n${leaks.join("\n")}`,
  );
});

/**
 * The one that would matter most and is the least likely to be noticed.
 *
 * A Send token pasted into a fixture during a sitting looks exactly like the
 * placeholders beside it, and the placeholders are three characters long.
 */
test("no real credential is anywhere in this repository", () => {
  const leaks = offences(AN_ANTHROPIC_KEY, (match) => !readsAsASentence(match[1] ?? "")).filter(
    (line) => !SHAPE_FIXTURES.has(line.slice(0, line.indexOf(":"))),
  );
  assert.deepEqual(leaks, [], `something shaped like a real Anthropic key:\n${leaks.join("\n")}`);
});
