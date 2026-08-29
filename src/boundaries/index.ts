/**
 * The one structural rule this repo enforces, and the check that bites.
 *
 * A module is a folder under `src/`. Its entry point, `index.ts`, is its whole
 * interface; everything in its subfolders is implementation and is unreachable
 * from any other module. Widening the interface is a deliberate edit to one
 * file, which is the point.
 *
 * Run through the test suite. There is no separate lint step to forget.
 */
import { findViolations } from "./internal/rule.ts";
import { readSourceTree } from "./internal/tree.ts";

export type { Violation, SourceTree } from "./internal/rule.ts";
export { findViolations };

/** Check the real `src/` tree of the repo rooted at `root`. */
export async function checkSourceTree(root: string) {
  return findViolations(await readSourceTree(root));
}
