/** One module specifier as it was written, with the line it was written on. */
export type Specifier = { readonly text: string; readonly line: number };

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

const FORMS = [
  // import x from "y" · import "y" · export { x } from "y"
  /\b(?:import|export)\b[^"'`;()]*?\bfrom\s*(["'])([^"']+)\1/g,
  /\bimport\s*(["'])([^"']+)\1/g,
  // import("y")
  /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
];

/**
 * Every module specifier a file imports, re-exports or dynamically loads.
 *
 * Comments are blanked first so a commented-out import is not counted, and so
 * the line numbers still line up with the original file.
 */
export function specifiersOf(source: string): Specifier[] {
  const code = source.replace(COMMENTS, (m) => m.replace(/[^\n]/g, " "));
  const found: Specifier[] = [];

  for (const form of FORMS) {
    form.lastIndex = 0;
    for (let m = form.exec(code); m !== null; m = form.exec(code)) {
      const text = m[2];
      if (text === undefined) continue;
      found.push({ text, line: lineAt(code, m.index) });
    }
  }

  return found.sort((a, b) => a.line - b.line || a.text.localeCompare(b.text));
}

/** The one-based line number the character at `offset` sits on. */
function lineAt(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (code[i] === "\n") line++;
  return line;
}
