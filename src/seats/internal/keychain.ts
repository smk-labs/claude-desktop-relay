import { spawn } from "node:child_process";

import type { Vault } from "./vault.ts";

/** Everything the machine keeps for us sits under this one service name. */
export const SERVICE = "claude-desktop-relay";

type Ran = { code: number; out: string; err: string };

/** Quote one word for `security`'s own command reader. */
function quote(word: string): string {
  return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Run `security` with these arguments.
 *
 * A command that carries a secret is fed to `security -i`, which reads its
 * commands from standard input, so the secret never appears in an argument where
 * anyone who can run `ps` would see it. Passing `-w` with no value does not read
 * standard input: it stores an empty secret, silently, which is how this was
 * found.
 */
function security(args: readonly string[], commandOnStdin?: readonly string[]): Promise<Ran> {
  return new Promise<Ran>((resolve) => {
    const input = commandOnStdin === undefined ? undefined : `${commandOnStdin.map(quote).join(" ")}\n`;
    const child = spawn("security", input === undefined ? [...args] : ["-i"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ code: -1, out: "", err: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * `security` prints a secret it cannot render as text as a hex dump instead, in
 * the form `0x0A0B  "\n\v"`. Read the hex, because that is the only form that
 * survives a byte for byte comparison.
 */
function decode(printed: string): string {
  const hex = /^0x([0-9A-Fa-f]+)\s/.exec(printed);
  if (hex?.[1] !== undefined) return Buffer.from(hex[1], "hex").toString("utf8");
  return printed.replace(/\n$/, "");
}

/** The machine's own Keychain, under one service name so removing it is one line. */
export function keychainVault(service: string = SERVICE): Vault {
  return {
    async put(name, secret) {
      // -U updates an existing entry rather than refusing. The secret is given to
      // -w here, and the whole command goes to `security -i` on standard input, so
      // it never reaches an argument anyone running `ps` could read.
      const ran = await security([], ["add-generic-password", "-U", "-s", service, "-a", name, "-w", secret]);
      if (ran.code !== 0) {
        throw new Error(`the Keychain would not hold "${name}": ${ran.err.trim() || `security exited ${ran.code}`}`);
      }
    },

    async get(name) {
      const ran = await security(["find-generic-password", "-s", service, "-a", name, "-w"]);
      if (ran.code !== 0) return null;
      return decode(ran.out);
    },

    async forget(name) {
      // Nothing to forget is not a failure.
      await security(["delete-generic-password", "-s", service, "-a", name]);
    },
  };
}

/**
 * Every Seat name the Keychain holds a Send token for, whatever any file says.
 *
 * The Keychain is the truth about which Send tokens exist, and it is shared by
 * every relay on this machine (ADR 0012). So an undo that went only by its own
 * list of Seats could leave real tokens behind with nothing naming them, and one
 * that forgot everything under the service name would take another Window's
 * tokens with it. Naming them is what lets a caller do neither.
 */
export async function everySeatHeldInTheKeychain(service: string = SERVICE): Promise<string[]> {
  const ran = await security(["dump-keychain"]).catch(() => ({ code: 1, out: "" }));
  if (ran.code !== 0) return [];

  const names = new Set<string>();
  let inOurs = false;
  for (const line of ran.out.split("\n")) {
    if (/^\s*"svce"/.test(line)) inOurs = line.includes(`"${service}"`);
    const account = /^\s*"acct"<blob>="([^"]*)"/.exec(line);
    if (inOurs && account !== null && account[1] !== undefined) names.add(account[1]);
  }
  return [...names];
}

/**
 * Remove every secret held under the service, whatever it is called.
 *
 * Nothing in this program calls this, and nothing should. It is here because
 * `security` offers it and because the reason not to use it is worth writing
 * down: the Keychain is shared by every relay on this machine, so "everything
 * under the service name" is never the same set as "everything this relay owns".
 * On 2026-08-22 an undo of a Proving Window called this and took every one of the
 * user's Send tokens, none of which could be rebuilt. Forget Seats by name.
 */
export async function forgetEverything(service: string = SERVICE): Promise<number> {
  let removed = 0;

  // Bounded so a `security` that always succeeds cannot spin forever.
  for (let attempt = 0; attempt < 500; attempt++) {
    const ran = await security(["delete-generic-password", "-s", service]);
    if (ran.code !== 0) break;
    removed += 1;
  }

  return removed;
}
