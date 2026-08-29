/**
 * Make the relay come up on its own, and the tray with the desktop session.
 *
 *   relay-linux install-service    write both, enable both, start the relay
 *   relay-linux install-service --off   take both away again
 *
 * Two jobs, and one mechanism for both: each is a `systemd --user` unit, and
 * neither is a daemon of our own invention. The relay must be up whether or not
 * anybody is logged in at a screen, because a Code session started from a Window
 * finds nothing listening otherwise and fails every request; lingering is what
 * makes that true before login rather than after it. The tray is part of a desktop
 * session and meaningless without one, so it is supervised rather than run once.
 * An autostart entry was the first answer for it and was wrong; `trayUnit` carries
 * why, and the entry is deleted here rather than left to fight the unit.
 *
 * Nothing here needs root, and nothing here is written outside this user's own
 * home.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME_VARIABLE, PORT_VARIABLE } from "../src/home/index.ts";
import { linuxHome, serviceNameFor, trayNameFor, TRIAL_ROOT_VARIABLE } from "./internal/where.ts";

const here = dirname(fileURLToPath(import.meta.url));
const home = linuxHome();
const say = (line = "") => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`${line}\n`);

/**
 * The unit names, keyed on the port so a second relay never replaces the first.
 * `serviceNameFor` carries why, and everything else that names these units reads
 * it too.
 *
 * Not `SERVICE_LABEL` from `src/service`, which is `com.claude-desktop-relay.agent`.
 * That spelling is launchd's convention; this is the name a person types after
 * `systemctl --user` and reads back in `status`. Renaming it would also leave every
 * existing install with an enabled unit under the old name that this command could
 * no longer disable, restarting for ever and holding the port against the new one.
 */
const SERVICE = serviceNameFor(home.port);
const TRAY = trayNameFor(home.port);
const serviceFile = join(homedir(), ".config", "systemd", "user", `${SERVICE}.service`);
const trayFile = join(homedir(), ".config", "systemd", "user", `${TRAY}.service`);
/** The old way the tray was started. Removed rather than left to fight the service. */
const autostartFile = join(homedir(), ".config", "autostart", "claude-relay-tray.desktop");
/** So it has a name and a face in the applications menu, like anything else installed. */
const menuFile = join(homedir(), ".local", "share", "applications", `${SERVICE}.desktop`);

/** Run one command with a ceiling, and give back what it said. */
function ran(command: string, args: readonly string[], atMostMs = 30_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const givingUp = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, out: `${command} did not finish within ${atMostMs / 1000}s` });
    }, atMostMs);
    child.on("error", (error) => {
      clearTimeout(givingUp);
      resolve({ code: -1, out: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(givingUp);
      resolve({ code: code ?? -1, out });
    });
  });
}

/**
 * Which Window this relay serves, carried into the unit.
 *
 * systemd starts a unit from a clean environment, and the whole identity of a
 * relay is these variables (ADR 0012). Without them a second relay's unit is the
 * first one's word for word: same home, same port, same Desktop folder, two units
 * fighting over one address. Only what is actually set is written, so installing
 * for the Window the user works in writes the unit it always wrote.
 *
 * Quoted, because these are paths and a path may hold a space. systemd reads the
 * quotes and the value keeps them out.
 */
function identity(): string {
  return [HOME_VARIABLE, PORT_VARIABLE, TRIAL_ROOT_VARIABLE]
    .map((name) => ({ name, value: process.env[name] }))
    .filter((one): one is { name: string; value: string } => one.value !== undefined)
    .map((one) => `Environment="${one.name}=${one.value}"\n`)
    .join("");
}

/**
 * The unit.
 *
 * `Restart=always` because the one failure that matters here is silence: a relay
 * that died leaves every Code session failing with a connection refused, and
 * nothing on screen says why. `WantedBy=default.target` with lingering enabled is
 * what makes it start at boot rather than at login.
 */
function unit(): string {
  return `[Unit]
Description=Claude Desktop Relay: which subscription pays for each Code session
Documentation=file://${join(here, "..", "docs", "linux.md")}

[Service]
ExecStart=${process.execPath} ${join(here, "serve.ts")}
${identity()}Restart=always
RestartSec=2
# The relay writes its own log and rotates it; this is only for a death before it
# gets that far, which is the case that would otherwise leave no trace at all.
StandardOutput=append:${home.serviceLogFile}
StandardError=append:${home.serviceLogFile}

[Install]
WantedBy=default.target
`;
}

/**
 * The tray, supervised like anything else that has to be there.
 *
 * An autostart entry was the first answer and it was the wrong one: it runs once
 * at login, so the icon was gone for good the moment the panel restarted or the
 * remote session was reconnected, and the way back was a command nobody should
 * have to know. `Restart=always` with a short delay is the whole fix. The tray
 * exits by itself when its icon dies or when no display of ours is open, which
 * turns "keep trying" into the ordinary path rather than an error.
 */
function trayUnit(): string {
  return `[Unit]
Description=Claude Desktop Relay: the icon in the notification area
# The relay first, so the icon never comes up saying the mechanism is broken
# when the truth is that it is three seconds early.
After=${SERVICE}.service
Wants=${SERVICE}.service

[Service]
ExecStart=${join(here, "tray", "relay-tray.sh")}
${identity()}Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** A name and a face in the applications menu, so it is findable like anything else. */
function menuEntry(): string {
  // From the home this relay was told to use, never from a spelling of its own:
  // a second relay draws its icons under its own folder, and an entry pointing at
  // the first one's would put one relay's face on the other's name.
  const icon = join(home.folder, "icons", "on.png");
  return `[Desktop Entry]
Type=Application
Name=${SERVICE === "claude-relay" ? "Relay" : `Relay (port ${home.port})`}
GenericName=Claude subscription switcher
Comment=Which subscription pays for each Claude Code session
Exec=${join(here, "tray", "open.sh")} ${TRAY}
Icon=${icon}
Terminal=false
Categories=Utility;
Keywords=claude;relay;seat;subscription;
StartupNotify=false
`;
}

const taking = process.argv.includes("--off");

if (taking) {
  await ran("systemctl", ["--user", "disable", "--now", TRAY]);
  await ran("systemctl", ["--user", "disable", "--now", SERVICE]);
  await rm(serviceFile, { force: true });
  await rm(trayFile, { force: true });
  await rm(autostartFile, { force: true });
  await rm(menuFile, { force: true });
  await ran("systemctl", ["--user", "daemon-reload"]);
  say(`The relay, the tray and the menu entry are gone.`);
  say(`Nothing else was touched: the Seats, the certificate and the Window's store are all still there.`);
  process.exitCode = 0;
} else {
  await mkdir(dirname(serviceFile), { recursive: true });
  await mkdir(dirname(menuFile), { recursive: true });
  await writeFile(serviceFile, unit(), { mode: 0o600 });
  await writeFile(trayFile, trayUnit(), { mode: 0o600 });
  await writeFile(menuFile, menuEntry(), { mode: 0o644 });
  // The entry replaces it, and two things starting one tray is one thing too many.
  await rm(autostartFile, { force: true });
  // So the menu notices without a logout. Missing on some systems, and its
  // absence is not a failure: the entry is read at the next login regardless.
  await ran("update-desktop-database", [dirname(menuFile)]).catch(() => undefined);

  await ran("systemctl", ["--user", "daemon-reload"]);
  const enabled = await ran("systemctl", ["--user", "enable", "--now", SERVICE]);
  if (enabled.code !== 0) {
    complain(`the service was written to ${serviceFile} but would not start: ${enabled.out.trim()}`);
    process.exitCode = 1;
  } else {
    /**
     * Lingering is the difference between "starts when you log in" and "is
     * already up when you get there". Asked for rather than assumed, and a
     * refusal is said out loud rather than swallowed: without it the relay is
     * down until somebody opens a session, which is exactly when they need it.
     */
    const lingering = await ran("loginctl", ["show-user", process.env["USER"] ?? "", "-p", "Linger"]);
    const lingers = /Linger=yes/.test(lingering.out);
    if (!lingers) {
      const asked = await ran("loginctl", ["enable-linger"]);
      if (asked.code !== 0) {
        say(`The relay is up, and it will start when you log in rather than at boot.`);
        say(`To have it up before then:  sudo loginctl enable-linger ${process.env["USER"] ?? ""}`);
      }
    }

    const trayUp = await ran("systemctl", ["--user", "enable", "--now", TRAY]);

    say(`The relay is a service now. It starts itself, and starts again if it dies.`);
    say(`  ${serviceFile}`);
    say(
      trayUp.code === 0
        ? `The tray is a service too, so the icon comes back by itself after a reconnect.`
        : `The tray service was written but would not start: ${trayUp.out.trim()}`,
    );
    say(`  ${trayFile}`);
    say(`It has a name in the applications menu as well.`);
    say(`  ${menuFile}`);
    say();
    say(`  systemctl --user status ${SERVICE} ${TRAY}    are they up`);
    say(`  systemctl --user restart ${SERVICE} ${TRAY}   after changing the code`);
    say(`  relay-linux install-service --off            undo all of this`);
    process.exitCode = 0;
  }
}
