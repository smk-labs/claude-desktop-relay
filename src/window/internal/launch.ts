import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ON_WINDOWS } from "../../home/index.ts";
import { pidsRunningOn, readProcessList } from "./running.ts";

/**
 * Where Claude Desktop is on Windows, looked for rather than written down.
 *
 * There are three ways it gets on to a machine and they put it in three different
 * places, and one of them puts a version number in the path, so a constant would
 * be wrong the first time the app updated. Looked for once and remembered.
 *
 * The Store build is the one on this machine: an MSIX package under
 * `WindowsApps`, whose folder name carries the version and the package identity.
 * The executable inside it can be started ordinarily, measured 2026-08-25.
 */
function findOnWindows(): string | null {
  const programs = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");

  // The plain installers, which put it at a fixed place.
  for (const plain of [
    join(local, "Programs", "claude-desktop", "Claude.exe"),
    join(local, "AnthropicClaude", "Claude.exe"),
    join(programs, "Claude", "Claude.exe"),
  ]) {
    if (existsSync(plain)) return plain;
  }

  // Squirrel keeps each version in its own `app-<version>` folder beside the
  // others, so the newest is the one to take.
  const anthropic = join(local, "AnthropicClaude");
  const versioned = (() => {
    try {
      return readdirSync(anthropic).filter((name) => name.startsWith("app-")).sort();
    } catch {
      return [];
    }
  })();
  for (const name of versioned.reverse()) {
    const candidate = join(anthropic, name, "claude.exe");
    if (existsSync(candidate)) return candidate;
  }

  /**
   * The Store build, which is what is on this machine.
   *
   * Its folder name carries the version, so it cannot be written down, and
   * `WindowsApps` refuses to be listed even by the user who owns the machine:
   * `readdirSync` on it fails outright here while reading a folder *inside* it
   * succeeds. Measured 2026-08-25. So Windows is asked where the package is
   * rather than the folder being searched.
   *
   * The listing is tried first anyway, because it costs nothing when it works and
   * because a machine that allows it needs no shell started at all.
   */
  const packages = join(programs, "WindowsApps");
  const listed = (() => {
    try {
      return readdirSync(packages).filter((name) => /^Claude_/i.test(name)).sort();
    } catch {
      return [];
    }
  })();
  for (const name of listed.reverse()) {
    const candidate = join(packages, name, "app", "Claude.exe");
    if (existsSync(candidate)) return candidate;
  }

  const installed = (() => {
    try {
      return execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name '*Claude*' | Select-Object -First 1).InstallLocation"],
        { encoding: "utf8", windowsHide: true, timeout: 30_000 },
      ).trim();
    } catch {
      return "";
    }
  })();
  if (installed !== "") {
    const candidate = join(installed, "app", "Claude.exe");
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Where Claude Desktop is, and nothing of ours is ever written inside it.
 *
 * A folder on macOS, where the executable is inside the bundle, and the
 * executable itself on Windows, where there is no bundle. `windowExecutable`
 * below is what turns one into the other, so nothing else has to know which
 * machine it is on.
 */
export const CLAUDE_DESKTOP: string = ON_WINDOWS ? (findOnWindows() ?? "Claude.exe") : "/Applications/Claude.app";

export function windowExecutable(bundle: string = CLAUDE_DESKTOP): string {
  return ON_WINDOWS ? bundle : `${bundle}/Contents/MacOS/Claude`;
}

/**
 * Start the Window with these variables in its environment.
 *
 * On macOS this is `/usr/bin/open`, and that is the whole of the fix for a Window
 * that came up slowly and would not load anything, measured 2026-08-26 with the
 * two Windows side by side. A Window started by running
 * `Claude.app/Contents/MacOS/Claude` ourselves is a child of whatever started it,
 * and the launcher is a launchd agent, so the app was left inside our job:
 * `XPC_SERVICE_NAME=com.claude-desktop-relay.agent.8980` and no
 * `__CFBundleIdentifier` at all. A Window the machine started has neither: it is
 * `application.com.anthropic.claudefordesktop.<numbers>` under launchd itself,
 * with the bundle identifier set, because LaunchServices gave it an application
 * job of its own. The app was never being launched as an application, only
 * executed, and the difference is not cosmetic: an application job is how macOS
 * decides what an app may do while it is not in front.
 *
 * `open` was what the first launcher used and it was dropped for two good reasons
 * that both have answers. It activated the Window already running instead of
 * starting the one asked for, which is `-n`. And it carried no environment, which
 * is `--env`, one per name, measured on this machine to arrive intact. What it
 * carries underneath is better than anything we can build: the launchd session's
 * own environment, which is what an app from the Dock has, so only `PATH` and
 * whatever the caller means to set are added on top.
 *
 * Falling back to running the executable ourselves if `open` will not do it, since
 * a Window that is slow beats no Window at all.
 *
 * Detached and with its streams let go, so the Window outlives the command that
 * started it. Nothing here closes anything: closing is `closeWindowOn`, which
 * refuses the Desktop folder the user works in. If a Window is already running
 * that is the caller's problem to notice, because the store is read at start and a
 * Window that is already up has already read it.
 */
export async function launchWindow(options: {
  executable: string;
  /**
   * The app itself, which is what macOS is asked to open.
   *
   * The executable inside it is what Windows starts and what the fallback runs.
   */
  bundle?: string;
  /**
   * The Desktop folder, so the pid can be read back after macOS has started it.
   *
   * `open` returns as soon as the launch is handed over and never says what it
   * started, which is the one thing given up by letting the machine do it.
   */
  folder?: string;
  variables: Readonly<Record<string, string>>;
  /**
   * The environment to start from, instead of this process's own.
   *
   * A Window inherits whatever started it, and what started it is sometimes a
   * service with launchd's bare `PATH` and sometimes a relayed Code session
   * carrying a proxy and our certificate. Neither is what the app would have had
   * from the Dock, and both broke a Window that was only supposed to be opened.
   * See `src/profiles/internal/environment.ts`.
   */
  environment?: Readonly<Record<string, string>>;
  /**
   * Arguments handed to the app itself.
   *
   * The one that matters is `--user-data-dir`, which is what makes a second
   * Claude Desktop a second Window rather than a second view of the same one: its
   * own login, its own environment store, its own Payer. ADR 0012.
   */
  args?: readonly string[];
}): Promise<number> {
  await access(options.executable).catch(() => {
    throw new Error(`there is no Claude Desktop at ${options.executable}`);
  });

  if (!ON_WINDOWS && (await askMacOSToOpen(options))) {
    // Started as an application, by the machine. The pid is read back rather than
    // returned, and a Window that is up but not yet in the process list is worth
    // waiting a moment for rather than reporting as a failure.
    return options.folder === undefined ? 0 : await pidOn(options.folder, options.bundle);
  }

  const child = spawn(options.executable, [...(options.args ?? [])], {
    env: { ...(options.environment ?? process.env), ...options.variables },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  if (child.pid === undefined) throw new Error(`${options.executable} would not start`);
  return child.pid;
}

/**
 * What `--env` is for, and what it is not for.
 *
 * Measured 2026-08-26, and it is the opposite of what the flag's existence
 * suggests: `open` hands the application the environment `open` itself was run
 * with. A Window opened this way from a Code session came up holding that
 * session's `ANTHROPIC_BASE_URL`, `CLAUDECODE`, `API_TIMEOUT_MS` and both `MCP_`
 * names, with not one of them named on the command line. So the environment the
 * caller built is given to `open` as its own, which is the thing the app inherits,
 * and `--env` carries only what is being set on purpose: the proxy variables and
 * the certificate of a Proving Window, which have to arrive whatever the
 * environment underneath says.
 */
export function whatToAdd(options: {
  variables: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
  return { ...options.variables };
}

/**
 * The command line, built where it can be read back.
 *
 * `-n` is the whole reason the first launcher gave up on `open`: without it macOS
 * treats any Claude Desktop already running as the answer and activates that one,
 * so the profile asked for never starts. `--args` last, because everything after
 * it belongs to the app.
 */
export function openArguments(options: {
  bundle: string;
  variables: Readonly<Record<string, string>>;
  args?: readonly string[];
}): string[] {
  const added = Object.entries(whatToAdd(options)).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  return ["-n", "-a", options.bundle, ...added, ...(options.args === undefined ? [] : ["--args", ...options.args])];
}

/** `open -n -a <bundle> --env NAME=VALUE ... --args ...`, and whether it worked. */
function askMacOSToOpen(options: {
  bundle?: string;
  variables: Readonly<Record<string, string>>;
  environment?: Readonly<Record<string, string>>;
  args?: readonly string[];
}): Promise<boolean> {
  const bundle = options.bundle;
  if (bundle === undefined) return Promise.resolve(false);

  const args = openArguments(
    options.args === undefined
      ? { bundle, variables: options.variables }
      : { bundle, variables: options.variables, args: options.args },
  );

  return new Promise<boolean>((resolve) => {
    const child = spawn("/usr/bin/open", args, {
      stdio: "ignore",
      // What the application inherits, because `open` passes its own environment
      // on. This is the whole reason the launcher builds one.
      env: { ...(options.environment ?? process.env) },
    });
    const stop = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, AN_OPEN_HAS_THIS_LONG);
    child.once("error", () => {
      clearTimeout(stop);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(stop);
      resolve(code === 0);
    });
  });
}

/** `open` has this long to hand the launch over, then it is treated as refused. */
const AN_OPEN_HAS_THIS_LONG = 20_000;

/** How long a Window may take to appear in the process list before it is not read. */
const A_WINDOW_APPEARS_WITHIN = 10_000;

async function pidOn(folder: string, bundle?: string): Promise<number> {
  const until = Date.now() + A_WINDOW_APPEARS_WITHIN;
  for (;;) {
    const [pid] = pidsRunningOn(await readProcessList(), folder, bundle);
    if (pid !== undefined) return pid;
    if (Date.now() >= until) return 0;
    await new Promise((wait) => setTimeout(wait, 400));
  }
}
