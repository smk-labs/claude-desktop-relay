/**
 * Starting a profile, and nothing else.
 *
 * Every variable a relayed profile needs is in its own store already, which the
 * app reads at startup (ADR 0009), so starting one is `--user-data-dir` and an
 * environment built to look like the Dock's. What that means, and the two failures
 * that made it necessary, are in `environment.ts`.
 *
 * A profile that is already running is never started again, and that is the whole
 * of what was wrong with the first version of this file. Claude Desktop holds no
 * single-instance lock on its Desktop folder: measured 2026-08-25, a second start
 * on a folder that already had a Window gave two live applications writing one
 * store. So a profile that is open is raised, not started.
 *
 * `open -a` is not how a profile is started either, for the same measurement: with
 * any Claude Desktop already running, macOS treats it as "the app is open" and
 * activates that one instead, so clicking Open on the user's own profile while a
 * relayed Window was up did nothing at all. Every profile is started by its folder,
 * the user's own included.
 *
 * Nothing here closes anything. Closing is `closeWindowOn`, which refuses the
 * Window the user works in.
 */
import { spawn } from "node:child_process";

import { CLAUDE_DESKTOP, launchWindow, pidsRunningOn, readProcessList, windowExecutable } from "../../window/index.ts";
import { ON_WINDOWS } from "../../home/index.ts";
import { asFromTheDock, loginPath } from "./environment.ts";
import { openNow } from "./find.ts";

export type Opened = { readonly opened: boolean; readonly saying: string };

/**
 * Bring a Window that is already open to the front, without starting anything.
 *
 * `open -a` on macOS hands the whole question to the system. Windows has no such
 * command, so the app is asked for by the pid of its own main process and raised
 * through the same shell object a script would use. Best effort on both: a raise
 * that does not work leaves a Window open where it was, which is the state the
 * caller is being told about anyway.
 */
async function raise(folder: string, bundle: string): Promise<void> {
  if (!ON_WINDOWS) {
    await new Promise<void>((resolve) => {
      const child = spawn("/usr/bin/open", ["-a", bundle], { stdio: "ignore" });
      child.once("error", () => resolve());
      child.once("exit", () => resolve());
    });
    return;
  }

  const [pid] = pidsRunningOn(await readProcessList(), folder, bundle);
  if (pid === undefined) return;

  await new Promise<void>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(New-Object -ComObject WScript.Shell).AppActivate(${pid})`],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

export async function openProfile(folder: string, bundle: string = CLAUDE_DESKTOP): Promise<Opened> {
  if (folder.trim() === "") return { opened: false, saying: "no profile was named" };

  if (openNow(await readProcessList(), folder, bundle)) {
    // Already open: raise the app rather than start a second one on its store.
    await raise(folder, bundle);
    return { opened: false, saying: `${folder} is already open, so it was raised rather than started again` };
  }

  const pid = await launchWindow({
    executable: windowExecutable(bundle),
    // The app itself and the folder it is being started on, because macOS is
    // asked to open the application rather than run the executable, and then says
    // nothing about what it started. See `src/window/internal/launch.ts`.
    bundle,
    folder,
    variables: {},
    environment: asFromTheDock(process.env, await loginPath()),
    args: [`--user-data-dir=${folder}`],
  });
  return {
    opened: true,
    saying: pid === 0 ? `started Claude Desktop on ${folder}` : `started Claude Desktop on ${folder} as ${pid}`,
  };
}
