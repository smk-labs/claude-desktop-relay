import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Ran, Run, Service, ServiceState } from "./launchd.ts";
import type { ServicePlan } from "./plist.ts";

const reallyRun: Run = (command, args) =>
  new Promise<Ran>((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ code: -1, out: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });

/** The user's own Startup folder, which is where a per-user login item goes. */
export function startupFolder(): string {
  const roaming = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  return join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/**
 * How long the supervisor waits before starting the relay again.
 *
 * Long enough that a relay which cannot start at all — a port already taken, a
 * syntax error — is retried at a human pace rather than in a loop, and short
 * enough that a crash is invisible to whoever is working in that Window.
 */
const WAIT_BEFORE_TRYING_AGAIN_MS = 5_000;

/**
 * The whole service, as one script Windows runs when the user logs in.
 *
 * Three things have to be true, and this is the only arrangement found that gets
 * all three on a machine where the user is not an administrator.
 *
 * It has to start at login. A Startup item does, and writing one needs no rights
 * beyond the user's own folder. The Task Scheduler would have been the closer
 * match to launchd, and it is refused outright here: `schtasks /Create` and
 * `Register-ScheduledTask` both answer "Access is denied" for this account, for a
 * task as trivial as `echo`, at the root and in a folder of its own. Measured
 * 2026-08-25.
 *
 * It has to come back if it dies. Nothing outside is going to do that here, so
 * the script does it itself: it starts the relay, waits for it, and starts it
 * again. That is what `KeepAlive` is on the other machine.
 *
 * And it has to leave no window on the screen. `node.exe` is a console program,
 * so anything that runs it directly puts a black window on the user's desktop and
 * leaves it there for as long as the relay lives. `wscript.exe`, which is what
 * Windows opens a `.vbs` with, is the windowless script host, and `Run` with a
 * window style of 0 starts the relay with no console at all.
 *
 * The environment is written in for the same reason it is written into the
 * launchd job on macOS: a login item gets no login shell and nothing of ours, so
 * a Proving Window's service would otherwise start up pointed at the Window the
 * user works in. ADR 0012.
 */
/**
 * A VBScript string literal, which doubles the quotes inside it.
 *
 * Whatever it wraps is a command line with quoted paths in it already, so every
 * one of those quotes is doubled once here and once only. Doubling them while
 * building the command and then again here produced four quotes around every
 * path, a command line Windows could not parse, and a relay that started at login
 * and immediately did nothing.
 */
export function asVbsText(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * A whole `sh.Run` line: this command, with no window, waiting or not.
 *
 * One function because there are two login items — the relay's and the tray's —
 * and they were quoting their command lines by two different rules. The tray's
 * quoted only the parts that held a space, so it worked on a machine whose paths
 * happened not to, and would have handed Windows half a path on one whose did.
 * That is not a thing to have two opinions about.
 *
 * Every part is quoted, always, including the program. A path with no space in it
 * loses nothing by being quoted, and a rule with no exception has no edge for a
 * path to fall off.
 */
export function aWindowlessRun(command: readonly string[], options: { wait: boolean }): string {
  const line = command.map((one) => `"${one}"`).join(" ");
  // 0 is "no window". The second is whether this script waits for what it started.
  return `sh.Run ${asVbsText(line)}, 0, ${options.wait ? "True" : "False"}`;
}

export function supervisorScriptFor(plan: ServicePlan): string {
  const quoted = asVbsText;

  return [
    `' The claude-desktop-relay relay. Written by "relay install"; delete it and`,
    `' the relay stops starting at login. Everything it needs is in this file.`,
    `Set sh = CreateObject("WScript.Shell")`,
    `Set env = sh.Environment("Process")`,
    ...Object.entries(plan.environment ?? {}).map(([name, value]) => `env(${quoted(name)}) = ${quoted(value)}`),
    ``,
    `sh.CurrentDirectory = ${quoted(plan.workingDirectory)}`,
    ``,
    `' Waiting for it is what makes the loop below a supervisor rather than a way`,
    `' to start a great many relays at once.`,
    `Do`,
    `  ${aWindowlessRun([plan.node, plan.script, ...plan.args], { wait: true })}`,
    `  WScript.Sleep ${WAIT_BEFORE_TRYING_AGAIN_MS}`,
    `Loop`,
    ``,
  ].join("\r\n");
}

/**
 * The relay as a Windows login item that keeps itself up.
 *
 * Per user and needing no administrator rights, which is the same promise the
 * launchd side makes. Nothing outside this file knows that the Startup folder
 * exists.
 */
export function startupItemService(options: {
  plan: ServicePlan;
  /** Where the item goes. Its name is what the user will see in that folder. */
  itemFile?: string;
  /** The test seam. Leave it alone in real use. */
  run?: Run;
}): Service {
  const run = options.run ?? reallyRun;
  const plan = options.plan;
  const file = options.itemFile ?? join(startupFolder(), `${plan.label}.vbs`);

  /**
   * The processes running this item, from their command lines.
   *
   * Both halves are wanted: the script host that is supervising, and the relay it
   * started. Stopping only the first leaves a relay nothing will ever stop; only
   * the second and the supervisor starts another five seconds later.
   */
  async function ours(): Promise<number[]> {
    const asking =
      `Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe' or Name = 'node.exe'" | ` +
      `ForEach-Object { $_.ProcessId.ToString() + [char]9 + $_.CommandLine }`;
    const asked = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", asking]);
    if (asked.code !== 0) return [];

    const ourItem = file.toLowerCase();

    // The relay's own command line, quoted by the rule that wrote it, arguments
    // and all. The arguments are the whole point: a machine with a Proving Window
    // has two relays running the same `serve.ts`, so matching the script on its
    // own matched both, and `relay uninstall` for one Window killed the relay of
    // every Window on the machine, including the one the user was working in.
    // ADR 0012 says a second Window never disturbs the first, and launchd holds
    // that by keying on the per-port label; this is how it is held here.
    const ourRelay = [plan.script, ...plan.args].map((one) => `"${one}"`).join(" ").toLowerCase();

    const pids: number[] = [];
    for (const line of asked.out.split(/\r?\n/)) {
      const [pid, ...rest] = line.split("\t");
      const command = rest.join("\t").toLowerCase();
      const id = Number(pid);
      if (!Number.isInteger(id) || id <= 0 || command === "") continue;
      if (command.includes(ourItem) || command.includes(ourRelay)) pids.push(id);
    }
    return pids;
  }

  async function stop(): Promise<void> {
    // The supervisor first, so it is not still watching when the relay goes and
    // does the one thing it exists to do.
    for (const pid of await ours()) {
      try {
        process.kill(pid);
      } catch {
        // Already gone between reading the list and signalling it, which is fine.
      }
    }
  }

  async function start(): Promise<void> {
    const child = spawn("wscript.exe", [file], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }

  return {
    file,

    async install() {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, supervisorScriptFor(plan), "utf8");

      // Started now as well as at the next login, because the person who just
      // typed `install` is not going to sign out to find out whether it worked.
      await stop();
      await start();
    },

    async uninstall() {
      await rm(file, { force: true });
      await stop();
    },

    async status() {
      const installed = existsSync(file);
      const running = (await ours()).length > 0;
      return { installed, running, pid: null };
    },

    async restart() {
      await stop();
      await start();
    },
  };
}
