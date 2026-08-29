import { specifiersOf } from "./specifiers.ts";

/** A crossing that the module rule forbids. */
export type Violation = {
  /** Repo-relative path of the file that reaches. */
  readonly from: string;
  /** Repo-relative path it reaches, as resolved. */
  readonly to: string;
  readonly line: number;
  /** Plain sentence naming what is wrong, suitable for a failing test's message. */
  readonly reason: string;
};

/** A whole source tree in memory: repo-relative path to file contents. */
export type SourceTree = Readonly<Record<string, string>>;

/** Only folders under here hold modules. */
const SRC_PREFIX = "src/";

/**
 * Every folder whose files are checked.
 *
 * Tests are in, because a test that reaches past an entry point is testing the
 * implementation rather than the interface, and the interface is meant to be the
 * test surface. Commands are in for the same reason: they are the app's own
 * callers, and if they can reach an internal then the interface is a suggestion.
 */
const CHECKED = [SRC_PREFIX, "test/", "scripts/"];

/**
 * The module a file belongs to, or null when it belongs to none: a file loose in
 * `src/`, or any file under `test/`. `src/relay/internal/open.ts` belongs to
 * `relay`.
 */
function moduleOf(path: string): string | null {
  if (!path.startsWith(SRC_PREFIX)) return null;
  const rest = path.slice(SRC_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? null : rest.slice(0, slash);
}

/** The one file of a module that anything else may import. */
function entryPointOf(module: string): string {
  return `${SRC_PREFIX}${module}/index.ts`;
}

/** Where a violation was written, for the front of a message. */
function at(from: string, line: number): string {
  return `${from}:${line}`;
}

/** Resolve a relative specifier against the importing file, POSIX style. */
function resolveFrom(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Every violation of the one rule this repo enforces: a module's internals are
 * reachable only from inside that module. Everything else about a module is
 * private, so the only cross-module import that is legal is its entry point.
 *
 * A bare specifier (`node:http`, `tls`) is not a module import and is ignored. A
 * relative specifier that resolves to nothing in the tree is a violation as well,
 * because this repo imports with an explicit `.ts` extension: Node runs these
 * files by stripping their types, so a compiled-style `./x.js` specifier names a
 * file that will never exist and the import would fail at run time.
 */
export function findViolations(tree: SourceTree): Violation[] {
  const violations: Violation[] = [];

  for (const [from, source] of Object.entries(tree)) {
    if (!CHECKED.some((prefix) => from.startsWith(prefix))) continue;
    const home = moduleOf(from);

    for (const { text, line } of specifiersOf(source)) {
      if (!text.startsWith(".")) continue;

      const to = resolveFrom(from, text);

      if (!Object.hasOwn(tree, to)) {
        violations.push({
          from,
          to,
          line,
          reason:
            `${at(from, line)} imports "${text}": no such file. This repo imports ` +
            `with an explicit .ts extension, because Node runs the files by ` +
            `stripping their types rather than compiling them.`,
        });
        continue;
      }

      const target = moduleOf(to);
      if (target === null || target === home) continue;
      if (to === entryPointOf(target)) continue;

      violations.push({
        from,
        to,
        line,
        reason:
          `${at(from, line)} reaches past the ${target} module's entry point into ${to}. ` +
          `Import ${entryPointOf(target)} instead, and widen its interface if it does not say enough.`,
      });
    }
  }

  return violations;
}
