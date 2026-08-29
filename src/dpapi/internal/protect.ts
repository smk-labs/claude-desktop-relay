import { spawn } from "node:child_process";

/** One secret as it sits on disk: base64 of what `CryptProtectData` gave back. */
export type Protected = string;

/** Whether this machine has the thing at all. Only Windows does. */
export const DPAPI_AVAILABLE = process.platform === "win32";

/**
 * How long PowerShell gets. Starting it is the slow part and it is under a second
 * on a machine that is not thrashing; without a ceiling a wedged host would hang
 * whatever asked, including the page.
 */
const CEILING_MS = 30_000;

/**
 * Run one PowerShell script, handing it everything on standard input.
 *
 * `-Command -` reads the script itself from standard input, so neither the script
 * nor anything in it is ever an argument. A Send token on a command line would be
 * a Send token in every process listing on this machine, once for every Seat.
 */
function powershell(script: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let out = "";
    let err = "";
    let settled = false;
    const finish = (answer: { code: number; out: string; err: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(ceiling);
      resolve(answer);
    };

    const ceiling = setTimeout(() => {
      child.kill();
      finish({ code: -1, out: "", err: `PowerShell did not answer within ${CEILING_MS / 1000} seconds` });
    }, CEILING_MS);

    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", (error) => finish({ code: -1, out: "", err: error.message }));
    child.on("close", (code) => finish({ code: code ?? -1, out, err }));

    /**
     * The blank line at the end is load-bearing and looks like formatting.
     *
     * `-Command -` reads standard input the way the prompt does, so a `foreach`
     * block is held until something ends it. Without the empty line the script is
     * never run at all: PowerShell exits 0, says nothing on either stream, and the
     * only symptom is an answer about no secrets. Measured 2026-08-25.
     */
    child.stdin.end(`${script}\n\n`);
  });
}

/**
 * The two halves of the round trip, written once so they cannot drift.
 *
 * Every line in is one base64 value and every line out is one base64 value, in the
 * same order, and a value that could not be turned is the empty line. Keeping the
 * positions is what lets the caller say which Seat failed rather than only that
 * something did.
 */
function script(direction: "Protect" | "Unprotect", values: readonly string[]): string {
  /**
   * The values are written into the script, and the script goes down standard
   * input, so nothing here is ever an argument. They are base64 and nothing else,
   * which is checked rather than assumed: a quote in one of them would end the
   * string it sits in and turn the rest of a Send token into PowerShell.
   */
  for (const value of values) {
    if (!/^[A-Za-z0-9+/=]*$/.test(value)) throw new Error(`a secret was not base64, so it was not handed to Windows`);
  }

  return [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -AssemblyName System.Security`,
    `$lines = @(${values.map((one) => `'${one}'`).join(",")})`,
    `foreach ($line in $lines) {`,
    `  if ($line -eq '') { Write-Output ''; continue }`,
    `  try {`,
    `    $bytes = [Convert]::FromBase64String($line)`,
    `    $turned = [System.Security.Cryptography.ProtectedData]::${direction}($bytes, $null, 'CurrentUser')`,
    `    Write-Output ([Convert]::ToBase64String($turned))`,
    `  } catch { Write-Output '' }`,
    `}`,
  ].join("\n");
}

/** Run one direction over a whole list, in one process. */
async function turn(direction: "Protect" | "Unprotect", values: readonly string[]): Promise<(string | null)[]> {
  if (values.length === 0) return [];
  if (!DPAPI_AVAILABLE) {
    throw new Error(`this machine has no DPAPI: it is Windows' own secret store and this is ${process.platform}`);
  }

  const ran = await powershell(script(direction, values));
  if (ran.code !== 0) {
    throw new Error(`Windows would not ${direction.toLowerCase()} these secrets: ${ran.err.trim() || `PowerShell exited ${ran.code}`}`);
  }

  const answered = ran.out.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== "");
  if (answered.length !== values.length) {
    throw new Error(
      `Windows answered about ${answered.length} secrets when ${values.length} were given, ` +
        `so which answer belongs to which is not knowable. Nothing was taken from it.`,
    );
  }
  return answered.map((line) => (line === "" ? null : line));
}

/**
 * Lock these secrets to this user. A secret that could not be locked comes back
 * null rather than as a value that looks locked and is not.
 */
export async function protectAll(secrets: readonly string[]): Promise<(Protected | null)[]> {
  return turn(
    "Protect",
    secrets.map((secret) => Buffer.from(secret, "utf8").toString("base64")),
  );
}

/**
 * Open them again, as the bytes they were.
 *
 * The bytes, not text, because not everything locked this way is text: the key
 * Claude Desktop locks its own state with is thirty-two random bytes, and reading
 * those as UTF-8 gives back whatever survives the decoding. That mistake produced
 * a two byte key and a sentence claiming the scheme had changed.
 */
export async function unprotectAllBytes(blobs: readonly Protected[]): Promise<(Buffer | null)[]> {
  const opened = await turn("Unprotect", blobs);
  return opened.map((one) => (one === null ? null : Buffer.from(one, "base64")));
}

/** The same, for the secrets that really are text. Null for one this user cannot open. */
export async function unprotectAll(blobs: readonly Protected[]): Promise<(string | null)[]> {
  return (await unprotectAllBytes(blobs)).map((one) => (one === null ? null : one.toString("utf8")));
}
