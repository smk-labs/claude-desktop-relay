import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import { CLAUDE_DESKTOP, windowExecutable } from "./launch.ts";
import { ON_WINDOWS, THE_USERS_DESKTOP_FOLDER, sameFolder } from "../../home/index.ts";

/**
 * Whether a Window is running right now.
 *
 * Read from the full process list rather than with `pgrep`, which was tried first
 * and quietly matched nothing here while the app was plainly running. A check
 * that answers "no" when the answer is "yes" is worse than no check at all: it was
 * the reason for a wrong statement about this very machine.
 *
 * Only ever used to say something useful to the user. Nothing in this program ever
 * closes the Window the user is working in: see `closeWindowOn` for what may be
 * closed and what may not.
 */
export function isWindowRunning(bundle: string = CLAUDE_DESKTOP): Promise<boolean> {
  return processList().then((out) => runningIn(out, bundle));
}

/**
 * Whether a Window is running on this Desktop folder in particular.
 *
 * One Claude Desktop is told from another by its Desktop folder and nothing else
 * (ADR 0012), so this is the only honest way to ask "is the Proving Window open".
 * Asking whether any Claude Desktop is running would answer yes because of the
 * Window the user works in, which is exactly the wrong answer.
 */
export function isWindowRunningOn(desktopFolder: string, bundle: string = CLAUDE_DESKTOP): Promise<boolean> {
  if (ON_WINDOWS) return Promise.resolve(holdingItsOwnLock(desktopFolder));
  return processList().then((out) => runningOn(out, desktopFolder, bundle));
}

/* --------------------------------------------- the Windows way to ask it ---- */

/**
 * On Windows, whether a Claude Desktop has this folder open, asked of the folder
 * rather than of the process list.
 *
 * Every Claude Desktop profile holds `lockfile` inside its own folder open for
 * writing for as long as it is running, which is how the app itself refuses to
 * open one folder twice. So trying to open that file for writing answers exactly
 * the question ADR 0012 asks, about exactly one folder, in no measurable time.
 *
 * The alternative is a process list, and on Windows that means starting
 * PowerShell: half a second, every time, for an answer the page asks for on every
 * refresh. It is still used where a pid is genuinely needed.
 *
 * Three answers collapse to two, and correctly. `EBUSY` is a Window holding it.
 * `ENOENT` is a folder no Claude Desktop has ever run in. Opening it means
 * nothing holds it, so nothing is running there.
 */
export function holdingItsOwnLock(desktopFolder: string): boolean {
  try {
    closeSync(openSync(join(desktopFolder, "lockfile"), "r+"));
    return false;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    return code === "EBUSY" || code === "EPERM" || code === "EACCES";
  }
}

/* ------------------------------------------------------- the process list ---- */

/**
 * The process list, whole, because `pgrep` quietly matched nothing here.
 *
 * One line per process, the pid then a space then the command line. That is what
 * `ps -ax -o pid=,command=` gives on macOS, and the pid is asked for rather than
 * left out because `closeWindowOn` has nothing to signal without it. Windows has
 * no such command any more: `wmic` is gone from Windows 11, so it is PowerShell
 * asking the same question of the same table the Task Manager reads.
 *
 * Exported as `readProcessList` too, so anything asking about several Windows at
 * once reads it once instead of starting a shell per folder.
 */
function processList(): Promise<string> {
  return ON_WINDOWS ? windowsProcessList() : unixProcessList();
}

function unixProcessList(): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawn("ps", ["-ax", "-o", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });
}

/**
 * Only Claude Desktop's own processes, because asking about all of them costs
 * seven hundred milliseconds here and about twenty-five costs five hundred.
 *
 * Narrowing it is safe for every question this list is asked: every one of them
 * is about a Claude Desktop. A question about anything else would need its own
 * reading rather than a wider one of this.
 */
function windowsProcessList(): Promise<string> {
  const asking =
    `Get-CimInstance Win32_Process -Filter "Name = 'Claude.exe'" | ` +
    `ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }`;

  return new Promise<string>((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", asking], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });
}

export { processList as readProcessList };

/**
 * One line of a process list, split into what started it and what it was given.
 *
 * Windows quotes the executable when its path has a space in it, which the path
 * to Claude Desktop always does, and it puts the pid in front. macOS puts neither
 * there. Both spellings arrive here and leave as the same two things, so the
 * questions below are asked once rather than twice.
 */
function readLine(line: string): { pid: number; executable: string; command: string } | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  const space = trimmed.indexOf(" ");
  if (space === -1) return null;
  const pid = Number(trimmed.slice(0, space));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const command = trimmed.slice(space + 1).trim();

  /**
   * macOS quotes nothing and its executable paths carry spaces of their own, so
   * the rest of the line is handed on whole. Every question asked of it below is
   * a prefix question, which is the one shape that stays right when the boundary
   * between the executable and its arguments cannot be found.
   */
  if (!ON_WINDOWS) return { pid, executable: command, command };

  const quoted = /^"([^"]+)"/.exec(command);
  const executable = quoted?.[1] ?? (command.split(" ")[0] ?? "");
  return { pid, executable, command };
}

/** Whether a line was started by Claude Desktop itself, in this machine's spelling. */
function startedByTheApp(line: { executable: string }, bundle: string): boolean {
  if (!ON_WINDOWS) return line.executable.startsWith(`${bundle}/Contents/MacOS/`);
  // Case-insensitively, because Windows spells the same executable `Claude.exe`
  // in one process and `claude.exe` in the next, on the same machine, in the same
  // minute. Measured 2026-08-25.
  return line.executable.toLowerCase() === windowExecutable(bundle).toLowerCase();
}

/** Whether a line names this Desktop folder, in a spelling the machine allows. */
function namesTheFolder(line: { command: string }, desktopFolder: string): boolean {
  const said = /--user-data-dir=("([^"]*)"|([^\s]*))/.exec(line.command);
  const folder = said?.[2] ?? said?.[3];
  return folder !== undefined && folder !== "" && sameFolder(folder, desktopFolder);
}

/**
 * The lines of a process list that Claude Desktop itself started.
 *
 * Exported because three questions were being asked of this list and each one had
 * its own idea of the shape of a line. `openNow` matched the executable at the
 * start of the raw line, which stopped being true the moment the pid was asked
 * for, and nothing said so: the answer just turned quietly into "nothing is
 * running". One reader, and the shape is agreed rather than assumed.
 */
export function appLinesIn(
  processList: string,
  bundle: string = CLAUDE_DESKTOP,
): { readonly pid: number; readonly command: string }[] {
  const lines: { pid: number; command: string }[] = [];
  for (const raw of processList.split("\n")) {
    const line = readLine(raw);
    if (line === null || !startedByTheApp(line, bundle)) continue;
    lines.push({ pid: line.pid, command: line.command });
  }
  return lines;
}

/** The pure half of the above, so a test owns the process list. */
export function runningOn(processList: string, desktopFolder: string, bundle: string = CLAUDE_DESKTOP): boolean {
  return processList
    .split("\n")
    .map(readLine)
    .some((line) => line !== null && startedByTheApp(line, bundle) && namesTheFolder(line, desktopFolder));
}

/**
 * The processes of the Window on one Desktop folder, from a process list.
 *
 * Pure, and deliberately narrow. A line counts only when it was started by the
 * Claude Desktop executable and names that Desktop folder, so a process that
 * merely mentions the folder somewhere in its arguments, which is what any of our
 * own commands looks like, is never one of them.
 */
export function pidsRunningOn(
  processList: string,
  desktopFolder: string,
  bundle: string = CLAUDE_DESKTOP,
): number[] {
  const pids: number[] = [];

  for (const raw of processList.split("\n")) {
    const line = readLine(raw);
    if (line === null) continue;
    if (!startedByTheApp(line, bundle)) continue;
    if (!namesTheFolder(line, desktopFolder)) continue;
    pids.push(line.pid);
  }

  return pids;
}

/** What happened when a Window was asked to close, and why when it did not. */
export type Closed = { readonly closed: boolean; readonly because: string };

/**
 * Ask the Window on one Desktop folder to quit.
 *
 * The rule this enforces, and it is enforced here rather than remembered: the
 * Window the user is working in is never closed by anything in this program. A
 * Window of its own, on a Desktop folder of its own, is another matter entirely,
 * and being able to close and reopen a Proving Window freely is the whole point of
 * having one.
 *
 * Three things make this narrow enough to trust. The Desktop folder the user works
 * in is refused outright, by comparing against the one place that names it. A
 * folder must be given, because a Window with no `--user-data-dir` at all is the
 * user's own. And only a process started by the Claude Desktop executable and
 * naming that folder is ever signalled, so our own commands, which mention the
 * folder in their arguments, can never be caught by it.
 *
 * `SIGTERM`, so the app closes itself and writes out its own state. Nothing here
 * escalates to `SIGKILL`: a Window that will not go is a fact to report, not a
 * fight to win. Windows has no signals and `process.kill` there is a hard stop
 * whatever it is asked for, which is said plainly rather than dressed up.
 */
export async function closeWindowOn(
  desktopFolder: string,
  bundle: string = CLAUDE_DESKTOP,
): Promise<Closed> {
  const wanted = desktopFolder.trim();
  if (wanted === "") {
    return { closed: false, because: "no Desktop folder was named, and a Window without one is the user's own" };
  }
  if (sameFolder(wanted, THE_USERS_DESKTOP_FOLDER)) {
    return {
      closed: false,
      because:
        `${wanted} is the Desktop folder the user works in. Nothing in this program closes that Window, ` +
        `whatever it is asked. Close it by hand if that is really what you want.`,
    };
  }

  const pids = pidsRunningOn(await processList(), wanted, bundle);
  if (pids.length === 0) return { closed: false, because: `no Window is running on ${wanted}` };

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone between reading the list and signalling it, which is fine.
    }
  }

  return { closed: true, because: `asked ${pids.length} process${pids.length === 1 ? "" : "es"} on ${wanted} to quit` };
}

/** The pure half, so a test can drive it without a process list of its own. */
export function runningIn(processList: string, bundle: string = CLAUDE_DESKTOP): boolean {
  return processList
    .split("\n")
    .map(readLine)
    .some((line) => line !== null && startedByTheApp(line, bundle));
}
