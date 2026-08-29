import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where `openssl` is on this machine.
 *
 * macOS ships it and it is on the path. Windows does not ship it and does not put
 * it on the path, but every machine that has Git for Windows has one, so the
 * places Git puts it are looked in by name. Found once and remembered, because
 * this is asked on every relay start.
 */
let found: string | null = null;

/** The places Git for Windows keeps it, in the order they are worth trying. */
function whereWindowsKeepsIt(): readonly string[] {
  const programs = [
    process.env["ProgramFiles"] ?? "C:\\Program Files",
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    process.env["LOCALAPPDATA"] === undefined ? "" : join(process.env["LOCALAPPDATA"], "Programs"),
  ].filter((one) => one !== "");

  const inside = [join("Git", "usr", "bin"), join("Git", "mingw64", "bin"), join("Git", "bin")];
  return programs.flatMap((program) => inside.map((where) => join(program, where, "openssl.exe")));
}

/**
 * The binary, or a sentence saying it is not here.
 *
 * A missing `openssl` is worth naming plainly: without it there is no local
 * authority, and without that no Code session can trust the relay. The symptom
 * otherwise is `spawn openssl ENOENT`, which says nothing about what to install.
 */
export function whereOpenSslIs(): string {
  if (found !== null) return found;

  if (process.platform !== "win32") return (found = "openssl");

  for (const candidate of whereWindowsKeepsIt()) {
    if (existsSync(candidate)) return (found = candidate);
  }

  // Still worth trying the bare name: a machine may have it on the path from
  // somewhere this does not know about, and failing there says the same thing.
  return (found = "openssl");
}

/**
 * Run `openssl` with these arguments and nothing else. No shell, so no argument
 * is ever interpreted; a host name with a space in it stays one argument.
 *
 * On Windows the binary is usually the one Git ships, which is built against the
 * MSYS runtime, and that runtime rewrites any argument that looks like a Unix
 * path into a Windows one before `openssl` ever sees it. `-subj /CN=...` then
 * arrives as `-subj C:/Program Files/Git/CN=...` and the certificate is minted
 * with a subject nobody asked for. `MSYS2_ARG_CONV_EXCL=*` turns that off, and it
 * is harmless on a binary that is not an MSYS one.
 */
export async function openssl(args: readonly string[]): Promise<void> {
  const binary = whereOpenSslIs();

  const failure = await new Promise<string | null>((resolve) => {
    const child = spawn(binary, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" },
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve(
        error.message.includes("ENOENT")
          ? `there is no openssl on this machine. It is what mints the local certificate authority, ` +
            `and without one no Code session can trust the relay. On Windows it comes with Git for Windows.`
          : error.message,
      ),
    );
    child.on("close", (code) => resolve(code === 0 ? null : stderr.trim() || `openssl exited ${code}`));
  });

  if (failure !== null) {
    throw new Error(`openssl ${args[0]} failed: ${failure}`);
  }
}
