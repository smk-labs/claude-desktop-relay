/**
 * The tray, built and run, and installed if asked.
 *
 *   relay tray              build if needed, then run it in this terminal
 *   relay tray --install    put it where it survives a restart
 *
 * A tray item is a native window server client, so it cannot be a Node process on
 * either machine. It is one Swift file compiled by the `swiftc` that ships with
 * the Command Line Tools on macOS, and one PowerShell file run by the PowerShell
 * that ships with Windows. Both keep the promise this project makes about
 * dependencies: nothing is installed, nothing is downloaded, nothing is vendored.
 *
 * The macOS one is compiled on demand into the relay's own folder and kept, so the
 * wait happens once rather than every login. The source's own modification time
 * is what decides, so editing the shell rebuilds it and nothing else does. The
 * Windows one is a script and there is nothing to build.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, copyFile, constants, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ON_WINDOWS, RELAY_PORT, relayHome } from "../src/home/index.ts";
import { aWindowlessRun, serviceLabelFor, startupFolder } from "../src/service/index.ts";
import { trayBundle, TRAY_APP_NAME } from "../src/tray/index.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = relayHome();
const source = join(repo, "src/tray/relay-tray.swift");
const built = join(home.folder, "tray", "relay-tray");

/**
 * How long a build may take before it is a failure rather than a wait.
 *
 * Measured on this machine: a working toolchain compiles this file in well under
 * a minute. Four is generous enough that a cold module cache is not mistaken for
 * a broken one, and short enough that nobody sits watching a terminal.
 */
const A_BUILD_HAS_THIS_LONG = 4 * 60_000;

const say = (line: string) => process.stdout.write(`${line}\n`);

async function modified(file: string): Promise<number | null> {
  return stat(file)
    .then((found) => found.mtimeMs)
    .catch(() => null);
}

/**
 * Everything `swiftc` said, and whether it worked.
 *
 * The output is kept rather than streamed, because the one failure worth naming
 * is buried in it and a person should be told what to do rather than handed a
 * compiler transcript.
 */
function compile(): Promise<{ ok: boolean; saying: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/swiftc", ["-O", "-o", built, source], { stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    child.stdout.on("data", (chunk: Buffer) => (said += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (said += String(chunk)));

    // Every wait has a ceiling. A compiler that has hung is a failure to report,
    // not a reason to keep waiting, and the whole process group goes with it.
    const ceiling = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, saying: `${said}\nswiftc was still going after four minutes, so it was stopped.` });
    }, A_BUILD_HAS_THIS_LONG);

    child.once("error", (error) => {
      clearTimeout(ceiling);
      resolve({ ok: false, saying: String(error) });
    });
    child.once("exit", (code) => {
      clearTimeout(ceiling);
      resolve({ ok: code === 0, saying: said });
    });
  });
}

/**
 * The failures this machine actually has, named rather than dumped.
 *
 * Re-measured 2026-08-24, and the earlier reading was too vague to act on. There
 * are two distinct failures here, not one:
 *
 * - Against the current SDK (26.0) the error is `redefinition of module
 *   'SwiftBridging'`. The cause is one stale file:
 *   `/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap`,
 *   dated 17 August 2023, left behind by an older Command Line Tools. The current
 *   toolchain already defines that module in `bridging.modulemap` beside it, dated
 *   August 2025, so it is defined twice. Moving the 2023 file aside is the whole
 *   fix, and it is one command.
 * - Against an older SDK (15.5) the error is the one this used to report: the SDK
 *   was built by swiftlang-6.1.2 while the compiler is 6.2. That is real, but it is
 *   a dead end rather than the problem: `-sdk` is not the way out.
 *
 * There is no Xcode and no alternative toolchain on this machine, so those are the
 * only two routes. Both fixes write inside `/Library`, which needs rights this
 * program does not have, so the reader is sent to README.md for the command. It is
 * deliberately not spelled out in here: `test/window-and-store.test.ts` fails if
 * anything under `src/` or `scripts/` so much as names the tool that escalates,
 * and that invariant is worth more than the convenience of an inline command.
 */
function readTheFailure(saying: string): string[] {
  if (/redefinition of module 'SwiftBridging'/.test(saying)) {
    return [
      `The Command Line Tools have one stale file left behind by an older install, and it`,
      `defines a module the current toolchain already defines, so nothing that imports`,
      `AppKit can compile here. The file is`,
      ``,
      `  /Library/Developer/CommandLineTools/usr/include/swift/module.modulemap`,
      ``,
      `dated 17 August 2023. The file that replaced it sits beside it as`,
      `bridging.modulemap, dated August 2025. Moving the old one aside is the whole fix,`,
      `it is one command, and it is reversible.`,
      ``,
      `That command writes inside /Library, so it needs rights this program does not have`,
      `and never asks for. It is written out for you in README.md, under "The interface,`,
      `and what it is". Run it there, then run "relay tray" again.`,
      ``,
      `The page is unaffected: the relay serves it at http://127.0.0.1:${home.port}/ and the`,
      `tray is only a shell over that same address.`,
    ];
  }
  if (/this SDK is not supported by the compiler|failed to build module/.test(saying)) {
    return [
      `The Swift compiler and the macOS SDK beside it come from different builds, so nothing`,
      `that imports AppKit can be compiled here. That is the machine, not the tray, and`,
      `putting it right means reinstalling the Command Line Tools, which needs rights this`,
      `program does not have and never asks for. The command is in README.md, under "The`,
      `interface, and what it is".`,
      ``,
      `The page is unaffected: the relay serves it at http://127.0.0.1:${home.port}/ and the`,
      `tray is only a shell over that same address.`,
    ];
  }
  if (/no such file or directory|ENOENT/i.test(saying)) {
    return [
      `There is no swiftc on this machine, so the menu bar item cannot be built.`,
      `Install the Command Line Tools and try again:`,
      ``,
      `  xcode-select --install`,
    ];
  }
  return saying.split("\n");
}

/**
 * Windows, where there is nothing to build.
 *
 * The whole tray is one PowerShell file, so this either starts it or writes the
 * login item that starts it. It is handled before any of the Swift machinery
 * below, because none of that machinery has anything to say here.
 *
 * The login item is a `.vbs` in the user's own Startup folder, for exactly the
 * reasons the relay's own service is (`src/service/internal/startup-item.ts`):
 * the Task Scheduler refuses this account, and `wscript` is the one script host
 * on the machine that starts something without putting a console window on the
 * screen. A tray item that arrives with a black window behind it is not a tray
 * item.
 *
 * The port is written into that file, because a login item is given no arguments.
 * A second relay on a second port therefore gets its own file reading its own
 * relay, which is ADR 0012 as far as the tray is concerned.
 */
if (ON_WINDOWS) {
  const script = join(repo, "src", "tray", "relay-tray.ps1");
  await access(script).catch(() => {
    process.stderr.write(`relay: the tray's source is missing at ${script}\n`);
    process.exit(1);
  });

  const running = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Port", String(home.port)];

  if (process.argv.includes("--install")) {
    // The same label the relay's own service uses, so a second relay on a second
    // port gets a second tray beside it rather than replacing the first.
    const item = join(startupFolder(), `${serviceLabelFor(home.port, RELAY_PORT)}-tray.vbs`);

    await mkdir(dirname(item), { recursive: true });
    await writeFile(
      item,
      [
        `' The claude-desktop-relay tray. Written by "relay tray --install"; delete it`,
        `' and the tray stops appearing at login. It reads ${`http://127.0.0.1:${home.port}/tray`}.`,
        `Set sh = CreateObject("WScript.Shell")`,
        `' Not waiting: the tray is its own program from here, and this script has`,
        `' nothing left to do. The quoting is the service's own, because a login item`,
        `' with its own idea of quoting is one that works until a path has a space.`,
        `${aWindowlessRun(["powershell.exe", ...running], { wait: false })}`,
        ``,
      ].join("\r\n"),
      "utf8",
    );

    /**
     * Any tray already running is stopped first, so installing twice leaves one
     * item in the tray rather than two reading the same relay.
     *
     * Narrow on purpose: only a PowerShell whose command line names this tray's
     * own script, so nothing else the user is running can be caught by it.
     */
    const stopping =
      `Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | ` +
      // Never itself. This very command line names the script it is looking for,
      // so without the first test it stops itself and leaves the tray running.
      `Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*relay-tray.ps1*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    await once(
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopping], { stdio: "ignore", windowsHide: true }),
      "exit",
    );

    // Started now as well as at the next login, for the same reason install is.
    spawn("wscript.exe", [item], { detached: true, stdio: "ignore", windowsHide: true }).unref();

    say(`Installed ${item}`);
    say(`It reads http://127.0.0.1:${home.port}/tray, and has no window: it is a notification area item.`);
    say(`It is in the tray now, and comes back after a restart. Quit it from its own menu.`);
    process.exit(0);
  }

  say(`The tray is in the notification area. It reads http://127.0.0.1:${home.port}/tray. Quit it from its own menu.`);
  const running_ = spawn("powershell.exe", running, { stdio: "inherit", windowsHide: true });
  const [code] = await once(running_, "exit");
  process.exit(typeof code === "number" ? code : 0);
}

const [sourceAt, builtAt] = await Promise.all([modified(source), modified(built)]);
if (sourceAt === null) {
  process.stderr.write(`relay: the tray's source is missing at ${source}\n`);
  process.exit(1);
}

if (builtAt === null || builtAt < sourceAt) {
  say(`Building the menu bar item. This happens once.`);
  await mkdir(dirname(built), { recursive: true });
  const { ok, saying } = await compile();
  if (!ok) {
    process.stderr.write(`relay: the menu bar item could not be built.\n\n`);
    for (const line of readTheFailure(saying)) process.stderr.write(`${line}\n`);
    process.exit(1);
  }
}

/**
 * Installed rather than run, when asked.
 *
 * `/Applications` is group-writable by admin users, so this needs no more rights
 * than the user already has; a machine where it is not writable gets the folder in
 * the user's own home instead, which macOS looks in just the same. Nothing here
 * escalates and nothing asks.
 *
 * The check asks for `W_OK` and not for existence. `access` with no mode is
 * `F_OK`, which every Mac passes because `/Applications` is always there, so the
 * fallback could never be reached and an account without admin rights got an
 * EACCES from the copy instead of the folder in its own home.
 */
if (process.argv.includes("--install")) {
  const home_ = process.env["HOME"] ?? "";
  const writable = await stat("/Applications")
    .then(() => access("/Applications", constants.W_OK))
    .then(() => true)
    .catch(() => false);
  const into = writable ? "/Applications" : join(home_, "Applications");
  const app = join(into, `${TRAY_APP_NAME}.app`);

  const bundle = trayBundle({ port: home.port, version: "0.1.0" });

  // Replaced whole rather than written over, so a bundle left by an older version
  // cannot keep a file this one no longer uses.
  await rm(app, { recursive: true, force: true });
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await writeFile(join(app, bundle.infoPlistAt), bundle.infoPlist, "utf8");
  await copyFile(built, join(app, bundle.binaryAt));
  await chmod(join(app, bundle.binaryAt), 0o755);

  /**
   * The icon is rendered by the tray itself, from the same drawing its status item
   * uses, so there is one piece of artwork rather than two that can drift. Without
   * it the Finder draws the blank sheet of paper, which is what "the app has no
   * icon" looks like.
   */
  const iconset = join(home.folder, "tray", `${TRAY_APP_NAME}.iconset`);
  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  const drew = await once(spawn(built, ["--write-iconset", iconset], { stdio: "inherit" }), "exit");
  const packed = drew[0] === 0 ? await once(spawn("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(app, bundle.iconAt)]), "exit") : [1];
  if (drew[0] === 0 && packed[0] === 0) say(`and it has its own icon, drawn by the same code as the menu bar item`);
  else say(`(the icon could not be rendered, so the Finder will draw a blank one; everything else works)`);

  /**
   * Signed, because the reference that works on this machine is signed and the one
   * that did not was not. Ad-hoc (`-`) needs no certificate and no account: it
   * gives the bundle a stable identity, which is what the window server wants
   * before it hands out a place in the menu bar.
   */
  const signed = await once(spawn("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app], { stdio: "pipe" }), "exit");
  if (signed[0] === 0) say(`signed it ad-hoc, so macOS treats it as one stable app`);
  else say(`(could not sign it, which may be why the menu bar ignores it)`);

  say(`Installed ${app}`);
  say(`It reads http://127.0.0.1:${home.port}/tray, and has no Dock icon: it is a menu bar item.`);
  say(`Open it from the Finder, or with "open -a ${app}". It comes back after a restart.`);
  process.exit(0);
}

say(`The tray is in the menu bar. It reads http://127.0.0.1:${home.port}/tray. Quit it from its own menu.`);
const tray = spawn(built, [String(home.port)], { stdio: "inherit" });
tray.once("exit", (code) => process.exit(code ?? 0));
