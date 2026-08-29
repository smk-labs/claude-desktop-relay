/**
 * Every path this program owns, in one place.
 *
 * All of it sits under a single folder, so the undo command is one removal plus
 * one Keychain service, and so nothing of ours is ever written anywhere else. In
 * particular nothing is written inside the Claude Desktop bundle.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The port the relay answers on, for the Window the user works in.
 *
 * Fixed, and it has to be. The app's store names this address and is read once
 * when the app starts, so a port chosen at random could never be written there.
 * ADR 0009. A Proving Window sets `CLAUDE_RELAY_PORT` and gets its own, because a
 * relay serves exactly one Desktop folder. ADR 0012.
 */
export const RELAY_PORT = 8978;

export type Home = {
  /** The one folder everything of ours lives in. */
  readonly folder: string;
  /**
   * The Desktop folder this relay serves: where that Claude Desktop keeps its own
   * state, and where our address is written.
   *
   * One relay, one Desktop folder, one port (ADR 0012). Unset, it is the folder
   * the Window the user works in uses, so nothing about the ordinary case changes.
   */
  readonly appSupport: string;
  /**
   * Where this relay answers. Part of the identity of the Window it serves rather
   * than a setting: the address is written into that Window's store and read once.
   */
  readonly port: number;
  /** The Seats: identity and Multiplier, never a credential. */
  readonly seatsFile: string;
  /** The last verdict, so who paid is answerable without running a session. */
  readonly verdictFile: string;
  /** Where the local certificate authority is minted. */
  readonly certificateFolder: string;
  /**
   * The Claude Code configuration this Window's sessions read: its plugins, its
   * skills, its settings, its own MCP servers.
   *
   * Only used for a Window on a Desktop folder of its own. Claude Code defaults
   * this to `~/.claude`, which is one directory shared by every Window on the
   * machine, so a relayed Window would otherwise start the user's own ten MCP
   * servers as children of a relayed session and put this program back in front
   * of all of them. That is the failure ADR 0014 exists to remove, so the
   * isolation is part of the identity rather than something switched on. ADR 0014.
   */
  readonly codeConfigFolder: string;
  /** The Mode and the Seat the user picked by hand. */
  readonly choiceFile: string;
  /**
   * What is known about every Seat's allowance, and how old each figure is.
   *
   * Kept apart from the Seats because it changes on every reply where the Seats
   * change once a year, and because losing it costs a ranking decision where
   * losing the Seats costs a sitting of interactive sign-ins.
   */
  readonly usageFile: string;
  /**
   * Which Seat each conversation is sitting on, as the relay decided it.
   *
   * The relay decides and holds it in memory; the command a person types and the
   * page the service serves are other processes. This is how they see it.
   */
  readonly standingFile: string;
  /**
   * Every exchange a Seat ever paid for, one row per line.
   *
   * Kept apart from everything else because it is the only file here that is meant
   * to grow, and because bounding the log must never be able to lose it: the log is
   * for a person reading what just happened, and this is the record.
   */
  readonly historyFile: string;
  /**
   * The Worklist as it was discovered: every Seat the user owns.
   *
   * A file rather than a fresh reading each time, so the user can edit it and run
   * the flow again. It holds identity and Multiplier and never a credential.
   */
  readonly worklistFile: string;
  /**
   * Everything the relay has said, as a service has nowhere else to say it.
   *
   * The relay writes this itself rather than letting the service capture its
   * output, because a file the service holds open cannot be rotated: renaming it
   * leaves the service writing to a name that is gone. Owning it is what makes
   * the bound in `src/journal` possible.
   */
  readonly logFile: string;
  /**
   * What the service says when the relay could not get far enough to say it.
   *
   * A missing Node binary, or a syntax error: the process dies before it opens
   * its own log, and without this the only symptom is a service that is installed
   * and not running. It is empty in ordinary life, so anything in it at all is
   * the diagnosis, which is how `relay doctor` reads it.
   */
  readonly serviceLogFile: string;
  /**
   * The name macOS shows this program by, in Login Items and in Activity Monitor.
   *
   * A launchd job is shown by the executable it runs, so a job that runs `node`
   * directly appears to the user as "node", which tells them nothing and looks
   * like something they did not install. This is a link to the same binary under
   * a name that says what it is.
   */
  readonly launcherFile: string;
};

/**
 * The three variables that say which Window a relay serves. ADR 0012.
 *
 * Unset, they name the Window the user works in. Set, they describe a Proving
 * Window completely, which is the only way to prove anything on a real Claude
 * Desktop without going near the one somebody is working in.
 */
export const HOME_VARIABLE = "CLAUDE_RELAY_HOME";
export const PORT_VARIABLE = "CLAUDE_RELAY_PORT";
export const APP_SUPPORT_VARIABLE = "CLAUDE_RELAY_APP_SUPPORT";

/**
 * Which machine this is running on.
 *
 * Named once, here, because nine modules ask and a scattered
 * `process.platform === "win32"` is how one of them ends up asking a different
 * question. Everything that differs between the two is a leaf: the relay, the
 * Chooser, the Payer, the usage memory and the history are one body of code on
 * both.
 */
export const ON_WINDOWS = process.platform === "win32";

/**
 * Where the Window the user works in keeps its own state.
 *
 * Claude Desktop keeps this beside its other Electron state, which is
 * `~/Library/Application Support/Claude` on macOS and `%APPDATA%\Claude` on
 * Windows. Measured on this machine 2026-08-25: the running app's own
 * `--user-data-dir` is exactly that folder.
 */
export const THE_USERS_DESKTOP_FOLDER = ON_WINDOWS
  ? join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "Claude")
  : join(homedir(), "Library", "Application Support", "Claude");

/**
 * One folder path in the one spelling everything here compares against.
 *
 * Two spellings of one folder are the same folder, and treating them as two is
 * how a store written under one of them is never found under the other. On
 * Windows there are three ways to differ rather than one: the separator, a
 * trailing one, and the case, because the file system does not care about any of
 * them and string comparison does.
 */
export function sameFolder(one: string, other: string): boolean {
  const bare = (path: string) => {
    const flat = ON_WINDOWS ? path.replace(/\\/g, "/").toLowerCase() : path;
    return flat.replace(/[/]+$/, "");
  };
  return bare(one) === bare(other);
}

/**
 * Is this the Desktop folder the user works in, rather than a Window of its own?
 *
 * The one thing that turns on this answer is whether the Window's Code sessions
 * read their own Claude Code configuration or the shared `~/.claude`. The user's
 * own Window keeps the plugins, skills and MCP servers they already have; a Window
 * of its own gets none of them, because those servers would start as children of a
 * relayed session and inherit the relay's address. ADR 0014.
 *
 * Compared with any trailing slash removed, because the two spellings name one
 * folder and a store written under one of them would not be found under the other.
 */
export function isTheUsersOwnDesktopFolder(appSupport: string): boolean {
  return sameFolder(appSupport, THE_USERS_DESKTOP_FOLDER);
}

/**
 * Which Window a relay serves. All three or none: never a mixture.
 *
 * Kept as one value on purpose, and the reason is a real mistake rather than a
 * hypothetical. When the folder could be overridden on its own while the Desktop
 * folder and the port still came from the environment, setting up a Proving Window
 * wrote its address into the store of the Window the user was working in and
 * installed its service under the plain label. Nothing was lost, and only because
 * a running Window has already read its store. An identity is one thing.
 */
export type WhichWindow = {
  /** Where this relay keeps its Seats, its choice, its usage memory and its log. */
  readonly folder: string;
  /** The Desktop folder it serves: where that Claude Desktop keeps its own state. */
  readonly appSupport: string;
  /** Where it answers. Written into that Desktop folder's store and read once. */
  readonly port: number;
};

/**
 * The Proving Window, described once so nothing anywhere invents its own version.
 *
 * A Window kept only to prove the mechanism: its own home, its own Desktop folder,
 * its own port, its own Payer. Everything about it is derived rather than
 * configured, because a proof run on a Window nobody can find again is not
 * re-runnable, and re-runnable is the point (ticket 21).
 */
export const PROVING_WINDOW: WhichWindow = {
  folder: join(homedir(), ".claude-desktop-relay-proving"),
  appSupport: join(homedir(), ".claude-desktop-relay-proving", "desktop"),
  port: RELAY_PORT + 1,
};

/** A port from the environment, or the fixed one. Nonsense is not silently zero. */
function portFrom(stated: string | undefined): number {
  if (stated === undefined || stated.trim() === "") return RELAY_PORT;
  const port = Number(stated);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error(`${PORT_VARIABLE} is "${stated}", which is not a port. Unset it, or give it a number.`);
  }
  return port;
}

/**
 * A Window that keeps everything in one folder of its own.
 *
 * For a test, and for anything that only cares where files land. It is honest
 * about the other two rather than leaving them to be picked up from elsewhere:
 * the Desktop folder is under the same roof and the port is nobody's.
 */
export function aWindowUnder(folder: string): WhichWindow {
  return { folder, appSupport: join(folder, "desktop"), port: 0 };
}

/**
 * Which Window this process serves, from its environment.
 *
 * Unset, all three name the Window the user works in, so nothing about the
 * ordinary case changes. The variables are also what lets a test run one of our
 * commands as its own process without going anywhere near the real one.
 */
export function whichWindow(): WhichWindow {
  return {
    folder: process.env[HOME_VARIABLE] ?? join(homedir(), ".claude-desktop-relay"),
    appSupport: process.env[APP_SUPPORT_VARIABLE] ?? THE_USERS_DESKTOP_FOLDER,
    port: portFrom(process.env[PORT_VARIABLE]),
  };
}

/**
 * Where everything lives, for one Window.
 *
 * Takes the whole identity or none of it. A folder on its own is deliberately not
 * accepted: see `WhichWindow` for what that cost.
 */
export function relayHome(which: WhichWindow = whichWindow()): Home {
  const under = which.folder;
  return {
    folder: under,
    appSupport: which.appSupport,
    port: which.port,
    seatsFile: join(under, "seats.json"),
    verdictFile: join(under, "verdict.json"),
    certificateFolder: join(under, "ca"),
    codeConfigFolder: join(under, "code-config"),
    choiceFile: join(under, "choice.json"),
    usageFile: join(under, "usage.json"),
    standingFile: join(under, "standing.json"),
    historyFile: join(under, "history.jsonl"),
    worklistFile: join(under, "worklist.json"),
    logFile: join(under, "relay.log"),
    serviceLogFile: join(under, "service.log"),
    /**
     * The name this program is shown by in Login Items on macOS.
     *
     * A path is named for both machines so nothing above has to branch to read it,
     * but only macOS ever gets a file: `nameTheLauncher` writes nothing on Windows
     * and the install there hands the service `node.exe` itself. Nothing needs
     * naming there, because the login item is a `.vbs` the windowless script host
     * opens, so the user sees that file rather than "node" and sees no console
     * window at all. See `src/service`.
     */
    launcherFile: ON_WINDOWS
      ? join(under, "bin", "claude-desktop-relay.vbs")
      : join(under, "bin", "claude-desktop-relay"),
  };
}

/**
 * Why a home has nothing in it, when the reason is a missing variable.
 *
 * A relay that serves a Window of its own keeps its Seats under its own home, so
 * a command typed without `CLAUDE_RELAY_HOME` reads the default home instead. If
 * that folder was never made, everything downstream reports the truth about a
 * folder nobody meant to read: no Seats, no choice, no Send token. The Keychain is
 * shared and still holds every token, which is what makes the reading so
 * convincing and so wrong. So say which folder was read, rather than only what was
 * not found in it.
 *
 * Null when there is nothing to explain: the folder exists, or the home was named
 * on purpose and being empty is its own answer.
 */
export function whyThisHomeLooksEmpty(home: Home = relayHome()): string | null {
  if (process.env[HOME_VARIABLE] !== undefined) return null;
  if (existsSync(home.folder)) return null;
  return (
    `Nothing of ours is at ${home.folder}, so this read an empty home. ` +
    `A relay on a Window of its own keeps its Seats elsewhere: name it with ` +
    `${HOME_VARIABLE}, the way the README does, and try again.`
  );
}
