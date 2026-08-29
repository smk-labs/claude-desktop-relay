import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

import { ON_WINDOWS } from "../../home/index.ts";

/**
 * The one Keychain entry the `claude` command keeps its own login in.
 *
 * Written down here rather than discovered because it is not ours and cannot be
 * changed: `CLAUDE_CONFIG_DIR` moves every file the command writes and does not
 * move this. An isolated config folder therefore does not isolate the credential,
 * which is the whole reason this module exists.
 */
export const CLI_LOGIN_SERVICE = "Claude Code-credentials";

/** The entry is keyed by the OS user, so there is exactly one per machine. */
export function cliLoginAccount(): string {
  return userInfo().username;
}

/**
 * The binary, by its full path.
 *
 * Everything this module claims rests on what this one process prints, and a
 * `security` found on `PATH` can be substituted by anything at all. A shim that
 * prints a fixed dump and exits 0 would make every run report "untouched" whatever
 * happened to the user's login, which is worse than having no check.
 */
const SECURITY = "/usr/bin/security";

/**
 * How long the Keychain gets to answer before the reading is abandoned.
 *
 * Reading one entry's attributes takes milliseconds. It can also take forever: a
 * locked keychain puts up an unlock dialog and waits for the person, and skipping
 * `-w` avoids the permission prompt but not that one. Without a ceiling the mint
 * flow would sit there with nothing on the screen.
 */
const CEILING_MS = 5_000;

/**
 * What `security` said, with nothing thrown away.
 *
 * The seam every test uses: a reading is a string of attributes, so nothing here
 * has to run `security`, and no test ever reaches the real Keychain.
 */
export type AskSecurity = (args: readonly string[]) => Promise<{ code: number; out: string; err: string }>;

/**
 * Ask the machine's `security` for one entry's attributes, and nothing else.
 *
 * `find-generic-password` without `-w` or `-g` prints attributes and never the
 * secret, so this cannot read the user's login even by accident and never causes
 * the Keychain to ask them to allow access to it.
 */
export const askTheKeychain: AskSecurity = (args) =>
  new Promise((resolve) => {
    const child = spawn(SECURITY, [...args], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    let settled = false;

    const finish = (answer: { code: number; out: string; err: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(ceiling);
      resolve(answer);
    };

    // The whole group, because a child killed on its own leaves any it started.
    const ceiling = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish({ code: -1, out: "", err: `the Keychain did not answer within ${CEILING_MS / 1000} seconds` });
    }, CEILING_MS);

    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", (error) => finish({ code: -1, out: "", err: error.message }));
    child.on("close", (code) => finish({ code: code ?? -1, out, err }));
  });

/**
 * When the CLI login was last written, as the Keychain itself dates it.
 *
 * Three answers and not two. "Held" carries the date; "none" says there is no such
 * entry, which is a machine where nothing can be lost; and "unreadable" says the
 * question could not be answered. That third one is the reason this is not a
 * string: a reading that failed must never be compared as though it were a date,
 * because two failures look identical and would read as "untouched".
 */
export type CliLoginReading =
  | { readonly kind: "held"; readonly lastChanged: string }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly because: string };

/**
 * The modification date out of an attribute dump.
 *
 * `security` prints it twice, as hex and as the text the hex decodes to, and it
 * prints only the hex when the value has no printable rendering. So the match is
 * held to a single line: allowed to run on across a newline, the optional hex part
 * swallows the line break and the next attribute's opening quote, and this returns
 * `svce` as the date. That fails open, which is the one way this module must never
 * fail, so the gap is spaces and tabs only.
 */
export function lastChangedIn(attributes: string): string | null {
  const found = /^[ \t]*"mdat"<timedate>=(?:0x[0-9A-Fa-f]+[ \t]+)?"([^"\\\n]+)/m.exec(attributes);
  return found?.[1] ?? null;
}

/** One quoted attribute off a dump, on its own line, or null when it is not there. */
function attribute(attributes: string, name: string): string | null {
  const found = new RegExp(`^[ \\t]*"${name}"<blob>="([^"\\n]*)"`, "m").exec(attributes);
  return found?.[1] ?? null;
}

/**
 * Where the `claude` command keeps its own login on Windows.
 *
 * There is no Keychain here, so it is a file, and `CLAUDE_CONFIG_DIR` does move
 * it: unlike the macOS Keychain entry, this one really is namespaced by that
 * variable. That makes the danger smaller and does not remove it, because a mint
 * run without the variable set writes exactly here. So the same question is asked
 * the same way, of the file's own date rather than the Keychain's.
 *
 * Attributes only. The file is never read, only asked when it last changed, so
 * this can neither leak the login nor depend on its shape.
 */
export function cliLoginFile(): string {
  const configured = process.env["CLAUDE_CONFIG_DIR"];
  return join(configured !== undefined && configured !== "" ? configured : join(homedir(), ".claude"), ".credentials.json");
}

/**
 * The same three answers, read off a file's date instead of a Keychain entry.
 *
 * Exported so it is testable on any machine. Both readers answer the same
 * question in the same three ways, and holding both to that on both machines is
 * what stops one of them quietly growing a fourth answer.
 */
export async function readCliLoginFromFile(file: string): Promise<CliLoginReading> {
  const found = await stat(file).then(
    (there) => there,
    (error: unknown) => error as NodeJS.ErrnoException,
  );

  if (found instanceof Error) {
    // Not being there is a machine where nothing can be lost. Anything else is a
    // question that could not be answered, which must never read as untouched.
    if (found.code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable", because: `${file} could not be read: ${found.message}` };
  }

  // To the millisecond, because two mints in one sitting are seconds apart and a
  // date to the second would compare equal across both.
  return { kind: "held", lastChanged: new Date(found.mtimeMs).toISOString() };
}

/**
 * The reading this machine's `claude` command actually answers to.
 *
 * One name above this line, so nothing that watches the CLI login learns which
 * machine it is on.
 */
export function readCliLogin(
  options: { ask?: AskSecurity; service?: string; account?: string; file?: string } = {},
): Promise<CliLoginReading> {
  return ON_WINDOWS ? readCliLoginFromFile(options.file ?? cliLoginFile()) : readCliLoginFromKeychain(options);
}

/** The macOS reader: one Keychain entry's attributes, and never its secret. */
export async function readCliLoginFromKeychain(
  options: { ask?: AskSecurity; service?: string; account?: string } = {},
): Promise<CliLoginReading> {
  const ask = options.ask ?? askTheKeychain;
  const service = options.service ?? CLI_LOGIN_SERVICE;
  const account = options.account ?? cliLoginAccount();

  const ran = await ask(["find-generic-password", "-s", service, "-a", account]);

  if (ran.code !== 0) {
    // 44 is `errSecItemNotFound`, and it is the only answer that means the entry
    // is not there. The wording is matched too, and matched narrowly: "the
    // specified keychain could not be found" is a machine whose keychain is
    // missing, which answers nothing, and reading that as "no entry" would let a
    // broken keychain wave a whole sitting through.
    const notThere = ran.code === 44 || /item could not be found in the keychain/i.test(ran.err);
    if (notThere) return { kind: "none" };
    return { kind: "unreadable", because: ran.err.trim() || `security exited ${ran.code}` };
  }

  // Duplicate entries across the keychain search list are ordinary, and
  // `security` prints the first one it finds while `claude setup-token` writes
  // the one in the default keychain. An entry that is not the one asked for
  // would sit there with an unchanging date and prove nothing about the login.
  const foundService = attribute(ran.out, "svce");
  const foundAccount = attribute(ran.out, "acct");
  if (foundService !== service || foundAccount !== account) {
    return {
      kind: "unreadable",
      because:
        `the Keychain answered with service "${foundService ?? "unnamed"}" and account ` +
        `"${foundAccount ?? "unnamed"}", which is not the entry that was asked for`,
    };
  }

  const lastChanged = lastChangedIn(ran.out);
  if (lastChanged === null) {
    return { kind: "unreadable", because: "the Keychain gave no modification date for that entry" };
  }
  return { kind: "held", lastChanged };
}
