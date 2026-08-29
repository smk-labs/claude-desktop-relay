/**
 * Which Window this relay serves on Linux, and where our own files go.
 *
 * The macOS side derives the Desktop folder from `~/Library/Application Support`.
 * On Linux there is no such place, and the Window that matters here is not the
 * distribution's default one: it is the isolated Claude Desktop under a trial
 * root, launched with a `CLAUDE_CONFIG_DIR` of its own. So the identity is read
 * from that root, and everything else in `src/home` is used unchanged.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { HOME_VARIABLE, RELAY_PORT, relayHome, whichWindow, type Home } from "../../src/home/index.ts";

/**
 * The isolated Claude Desktop root: its Desktop folder, its Claude Code
 * configuration and its own launcher all sit under this.
 *
 * An environment variable rather than a constant, because a second root is how
 * anything about this is tried without touching the Window somebody is using.
 */
export const TRIAL_ROOT_VARIABLE = "CLAUDE_DESKTOP_TRIAL_ROOT";

export const TRIAL_ROOT = process.env[TRIAL_ROOT_VARIABLE] ?? join(homedir(), "desktop-trial");

/** Where that Claude Desktop keeps its own state. Electron's `--user-data-dir`. */
export const DESKTOP_FOLDER = join(TRIAL_ROOT, "profile");

/** The launcher that starts it, isolated, which ours wraps rather than replaces. */
export const TRIAL_LAUNCHER = join(TRIAL_ROOT, "bin", "claude-desktop-trial");

/**
 * What this relay's `systemd --user` unit is called, told apart by its port.
 *
 * systemd keys a user unit by its file name exactly as launchd keys a job by its
 * label, so two relays sharing one name are one job: installing a Proving Window's
 * relay would take the unit of the Window the user works in, and the first anybody
 * would know of it is a Code session paying for itself. ADR 0012, and the same
 * thing `serviceLabelFor` does in `src/service`. The relay for the Window the user
 * works in keeps the plain name, so nothing already installed has to be
 * reinstalled to gain this.
 *
 * Here rather than in `install-service.ts` because three other things name this
 * unit: the health check tells the reader how to start it, the tray offers to
 * restart it, and the applications entry hands it to `open.sh`. A name spelled in
 * four places is a name that is wrong in three of them.
 */
export function serviceNameFor(port: number): string {
  return port === RELAY_PORT ? "claude-relay" : `claude-relay.${port}`;
}

/** The tray's own unit, named after the relay it belongs to, the way macOS names it. */
export function trayNameFor(port: number): string {
  return `${serviceNameFor(port)}-tray`;
}

/**
 * Where the Send tokens live on Linux.
 *
 * On macOS this is the Keychain and no file. Linux has no equivalent this program
 * can rely on: the only secret store here is the login keyring, which is unlocked
 * by the desktop session and is therefore unreadable to a relay started over ssh
 * or from a boot job. A file the relay can always read is worth more than a store
 * it can read only while somebody is logged in at a screen. What that costs is
 * written down in docs/linux.md and nowhere else.
 */
export function vaultFile(home: Home): string {
  return join(home.folder, "send-tokens.json");
}

/**
 * Everything, for one Window, on this machine.
 *
 * The folder and the port are read the way `src/home` reads them, names and all,
 * rather than spelled again here. The port especially: `Number(...)` turned a
 * mistyped `CLAUDE_RELAY_PORT` into `NaN` and the relay then failed to listen with
 * nothing on screen naming the variable that caused it. `whichWindow` refuses
 * nonsense out loud. Only the Desktop folder is ours, for the reason above.
 */
export function linuxHome(): Home {
  return relayHome({
    folder: process.env[HOME_VARIABLE] ?? join(homedir(), ".claude-desktop-relay"),
    appSupport: DESKTOP_FOLDER,
    port: whichWindow().port,
  });
}
