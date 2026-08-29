import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ensureAuthority } from "../../certificate/index.ts";
import { inspect, type Finding } from "../../mechanism/index.ts";
import { machineService, nameTheLauncher, serviceLabelFor, type ServiceState } from "../../service/index.ts";
import { isWindowRunning, proxyVariables } from "../../window/index.ts";
import {
  certificateVariables,
  codeConfigVariables,
  openAppStore,
} from "../../app-store/index.ts";
import {
  APP_SUPPORT_VARIABLE,
  HOME_VARIABLE,
  ON_WINDOWS,
  PORT_VARIABLE,
  RELAY_PORT,
  isTheUsersOwnDesktopFolder,
  sameFolder,
  type Home,
} from "../../home/index.ts";

/** One line, as it should be shown. Injected, because nothing under src prints. */
export type Report = (line?: string) => void;

/** Everything that has to be true for a Code session to reach a Seat. */
export type Examination = {
  readonly findings: readonly Finding[];
  /** True only when every finding holds. Nothing may claim a Seat is paying otherwise. */
  readonly working: boolean;
  readonly service: ServiceState;
};

/**
 * Everything the control surface does that touches this machine.
 *
 * A seam with two adapters that both exist: the real one below, and a stand-in in
 * the tests. Without it, testing "off and on again is live" would mean writing a
 * launchd job and an encrypted store belonging to an app that is running, and the
 * one rule nothing here may break is going near a live Window.
 */
export type Machine = {
  /** Put the relay on this machine. Says what it did as it goes. */
  install(say: Report): Promise<void>;
  /**
   * Take it off this machine: the service, our variables, the folder.
   *
   * It cannot forget a Send token, and that absence is the design. The Keychain is
   * shared by every relay on this machine (ADR 0012), so nothing that undoes one
   * relay may be able to reach it: on 2026-08-22 this call forgot everything under
   * our service name while tearing down a Proving Window, and took every one of
   * the user's Send tokens. Each was an interactive sign-in as its own account and
   * none could be rebuilt.
   *
   * Forgetting a Send token now belongs to the surface alone, right beside the
   * refusal that asks whether the user meant it, and there is no second way in.
   *
   * Returns false when it stopped short, having said why.
   */
  uninstall(say: Report): Promise<boolean>;
  /** Whether every part of the mechanism holds, and which part does not. */
  examine(): Promise<Examination>;
  /** Whether a Window is running. Nothing anywhere here ever closes one. */
  windowRunning(): Promise<boolean>;
  /** Hand an address to whatever the user opens addresses with. */
  open(where: string): Promise<void>;
  /** Run one of the long flows in its own process, and give back its exit code. */
  handOffTo(script: string, args: readonly string[]): Promise<number>;
};

/** How a flow in its own process is started. Injected so no test spawns anything. */
export type HandOff = (script: string, args: readonly string[]) => Promise<number>;

const OPEN_HOST = "api.anthropic.com";

/**
 * The real machine: launchd, the app's own encrypted store, and the Keychain.
 *
 * All three of the old install, undo and doctor commands are in here now. They
 * were three scripts that each rebuilt the same four objects from the same four
 * modules, and the fourth copy of that wiring was where a wrong path would have
 * gone unnoticed.
 */
export function thisMachine(options: {
  /**
   * Everything about the Window this relay serves: where it writes, which Desktop
   * folder is its own, and which port it answers on. ADR 0012.
   */
  home: Home;
  /** The repository, so the service can be told which script to run. */
  repo: string;
  /** The Node binary the service should run. */
  node: string;
  handOff: HandOff;
}): Machine {
  const { home, repo } = options;
  const address = { host: "127.0.0.1", port: home.port };
  const store = () => openAppStore(home.appSupport);

  /**
   * The service, described the same way every time.
   *
   * `uninstall` and `status` need only the label to find the job, but the plan is
   * one shape and inventing a half-filled one per caller is how the installed job
   * and the job we look for stop being the same job.
   */
  const service = (node: string) =>
    machineService({
      plan: {
        label: serviceLabelFor(home.port, RELAY_PORT),
        node,
        script: join(repo, "scripts", "serve.ts"),
        args: [String(home.port)],
        workingDirectory: repo,
        /**
         * Which Window this service serves, handed over rather than inherited.
         *
         * A launchd job gets no login shell and no environment of ours, so a
         * Proving Window's service would otherwise start up pointed at the
         * Window the user works in: the same port, the same Desktop folder, the
         * same home. That is the one mistake in this area that would be both
         * silent and awful. ADR 0012.
         */
        environment: {
          [HOME_VARIABLE]: home.folder,
          [PORT_VARIABLE]: String(home.port),
          [APP_SUPPORT_VARIABLE]: home.appSupport,
        },
        // Not our log. The relay writes that itself so it can be bounded; this
        // one only ever holds the reason the process could not start at all.
        logFile: home.serviceLogFile,
        /**
         * Thrown away, because the relay already says all of it to its own log.
         *
         * Kept here rather than folded into `logFile` so that file stays empty in
         * ordinary life. It held the two ordinary startup lines when both streams
         * went to it, which made `relay doctor` report a healthy service as broken.
         */
        outFile: ON_WINDOWS ? "NUL" : "/dev/null",
      },
    });

  const certificateFile = join(home.certificateFolder, "ca.crt");

  /**
   * A Window on a Desktop folder of its own gets a Claude Code configuration of
   * its own; the Window the user works in keeps the one they already have.
   *
   * Without this a relayed Window reads `~/.claude` like every other Window, so
   * the user's plugins and MCP servers start as children of a relayed session and
   * inherit the relay's address. That is the whole failure ADR 0014 removes, and
   * it would come back silently. Deciding it from the Desktop folder rather than
   * from a flag means there is no way to install the isolated case without it.
   */
  const isTheUsersOwnWindow = isTheUsersOwnDesktopFolder(home.appSupport);

  const ourVariables = (caCertificatePath: string) => ({
    ...proxyVariables(address),
    ...certificateVariables(caCertificatePath),
    ...(isTheUsersOwnWindow ? {} : codeConfigVariables(home.codeConfigFolder)),
  });

  return {
    windowRunning: isWindowRunning,
    handOffTo: options.handOff,

    /**
     * `open` and nothing cleverer. Which browser, which profile and which window
     * is the user's own arrangement, and a program that reached past `open` to
     * decide it would be overriding a choice it cannot see.
     */
    async open(where) {
      await new Promise<void>((resolve, reject) => {
        /**
         * `start` is a builtin of the command interpreter rather than a program,
         * so it is reached through `cmd`. The empty string after it is the window
         * title, and it is not optional: without it `start` reads the first
         * quoted argument as the title and opens nothing at all.
         */
        const child = ON_WINDOWS
          ? spawn("cmd.exe", ["/c", "start", "", where], { stdio: "ignore", windowsHide: true })
          : spawn("/usr/bin/open", [where], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
    },

    async install(say) {
      const authority = await ensureAuthority(home.certificateFolder, OPEN_HOST);
      say(`certificate authority at ${authority.caCertificatePath}`);

      // So the user sees "claude-desktop-relay" in Login Items, or in Task
      // Scheduler, rather than "node".
      const launcher = await nameTheLauncher({ at: home.launcherFile, to: options.node });
      say(`this relay serves the Claude Desktop in ${home.appSupport}, on port ${home.port}`);
      /**
       * Emptied before the job is installed, not after.
       *
       * The file holds only the reason the relay could not start. Emptying it
       * afterwards means a genuine startup failure from the new job is thrown away
       * along with the old noise; emptying it first means whatever is in it belongs
       * to this install.
       */
      await writeFile(home.serviceLogFile, "", { mode: 0o600 }).catch(() => {});

      // On Windows the service runs the real node and the launcher is the two-line
      // script that keeps its console off the screen, so the node it is given is
      // the node, not the launcher.
      const job = service(ON_WINDOWS ? options.node : launcher);
      await job.install();
      say(`the relay is a service now, at ${job.file}`);
      say(
        ON_WINDOWS
          ? `it runs with no console window on your desktop, which is what that file is for`
          : `it appears as "claude-desktop-relay" rather than "node", which is what ${launcher} is for`,
      );
      say(`it starts at login, comes back if it dies, and says what it does in ${home.logFile}`);

      // Everything through the store, because the Window is opened from the UI
      // and there is no launch of ours to hand anything to. ADR 0009.
      const ours = ourVariables(authority.caCertificatePath);
      // Pointed at a folder that exists, because Claude Code is being told where
      // its configuration is before it has ever run there.
      if (!isTheUsersOwnWindow) {
        await mkdir(home.codeConfigFolder, { recursive: true, mode: 0o700 });
        say(`this Window's Code sessions read their own configuration in ${home.codeConfigFolder}`);
        say(`so none of your plugins, skills or MCP servers are loaded in it`);
      }
      const held = store();
      await held.put(ours);
      say(`wrote ${Object.keys(ours).length} variables into ${held.file}`);
    },

    async uninstall(say) {
      const job = service(ON_WINDOWS ? options.node : home.launcherFile);
      await job.uninstall();
      say(`the service is gone, and so is ${job.file}`);

      // Derived from the writer rather than listed again: a name added to one and
      // not the other is a variable left behind in somebody's store for ever.
      const ours = Object.keys(ourVariables(certificateFile));
      const held = store();
      try {
        await held.forget(ours);
        say(`removed our ${ours.length} variables from ${held.file}`);
      } catch (error) {
        say(
          `could NOT change ${held.file}, so our variables may still be set there: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }

      say(`no Send tokens were touched: nothing on this path can reach them.`);

      /**
       * A guard against a home that was pointed somewhere it should not be. The
       * one folder we made is the only thing this is allowed to remove.
       *
       * "Not a path at all" is a different shape on the two machines: macOS has
       * one root and one separator, and Windows has a root per drive and two
       * separators. So the question asked is the one that matters on both: is
       * this the user's own home, is it the root of anything, and does it name a
       * folder inside something rather than being a bare word.
       */
      const bare = home.folder.replace(/[/\\]+$/, "");
      const isARoot = bare === "" || /^[a-zA-Z]:$/.test(bare) || !/[/\\]/.test(bare);
      if (sameFolder(home.folder, homedir()) || isARoot) {
        say(`refusing to remove ${home.folder}: that is not a folder this program made`);
        return false;
      }
      await rm(home.folder, { recursive: true, force: true });
      say(`removed ${home.folder}`);
      return true;
    },

    async examine() {
      const held = store();
      const found = await inspect({
        storeFile: held.file,
        wanted: ourVariables(certificateFile),
        reading: () => held.read(),
        certificateFile,
        relay: address,
      });

      const state = await service(options.node).status();
      /**
       * A pid when there is one to give, and no invented one when there is not.
       *
       * The Windows login item is a script host supervising the relay, so the pid
       * the machine would report is the supervisor's rather than the relay's, and
       * saying it would be answering a different question than the one asked.
       */
      const saying = state.installed
        ? state.running
          ? state.pid === null
            ? `running`
            : `running as pid ${state.pid}`
          : "installed but not running"
        : "not installed";

      /**
       * Anything the service itself had to say is a finding.
       *
       * That file is empty whenever the relay got far enough to open its own log,
       * so a single byte in it means the process could not start, and that is the
       * one failure nothing else here can see.
       */
      const startupSaid = await stat(home.serviceLogFile).then(
        (found) => found.size,
        () => 0,
      );

      // The service is a finding like any other, so `working` means the whole
      // mechanism rather than most of it.
      const findings: Finding[] = [
        ...found.findings,
        { what: "the service", ok: state.running, saying },
        ...(startupSaid === 0
          ? []
          : [
              {
                what: "the service's own log",
                ok: false,
                saying:
                  `${home.serviceLogFile} is ${startupSaid} bytes, and it is only written when the relay ` +
                  `cannot start at all. Read it: that is the reason.`,
              },
            ]),
      ];
      return { findings, working: findings.every((one) => one.ok), service: state };
    },
  };
}
