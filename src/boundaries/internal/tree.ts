import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { SourceTree } from "./rule.ts";

/** The folders read off disk. Anything outside them is not checked. */
const FOLDERS = ["src", "test", "scripts"];

/** Read every TypeScript file in the checked folders into memory, keyed POSIX style. */
export async function readSourceTree(root: string): Promise<SourceTree> {
  const tree: Record<string, string> = {};

  for (const folder of FOLDERS) {
    const entries = await readdir(join(root, folder), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const absolute = join(entry.parentPath, entry.name);
      tree[relative(root, absolute).split(sep).join("/")] = await readFile(absolute, "utf8");
    }
  }

  return tree;
}
