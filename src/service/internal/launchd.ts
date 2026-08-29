import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { plistFor, type ServicePlan } from "./plist.ts";

export type Ran = { readonly code: number; readonly out: string };

/**
 * Keep asking until it is true, or give up.
 *
 * A ceiling rather than a wait, because launchd is asynchronous in both directions
 * and a poll with no end is a command that hangs on a machine having a bad day.
 * Five seconds is far longer than either transition has ever taken.
 */
const GIVE_UP_AFTER_MS = 5_000;
const ASK_EVERY_MS = 50;

async function until(yet: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + GIVE_UP_AFTER_MS;
  for (;;) {
    if (await yet()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, ASK_EVERY_MS));
  }
}

/** How a command is run. Injected so no test ever reaches the real launchd. */
export type Run = (command: string, args: readonly string[]) => Promise<Ran>;

const reallyRun: Run = (command, args) =>
  new Promise<Ran>((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ code: -1, out: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });

export type ServiceState = {
  readonly installed: boolean;
  readonly running: boolean;
  readonly pid: number | null;
};

export type Service = {
  /** Where the job description lives, so it can be shown and removed. */
  readonly file: string;
  install(): Promise<void>;
  /** Removes the job and its description. Not being there is not a failure. */
  uninstall(): Promise<void>;
  status(): Promise<ServiceState>;
  /** Stop and start it again, for when the relay's own code has changed. */
  restart(): Promise<void>;
};

/**
 * The relay as a per-user service.
 *
 * Per-user on purpose: a login agent needs no administrator rights, which keeps
 * installing this from being a security decision. Nothing here writes outside the
 * user's own home.
 */
export function launchdService(options: {
  plan: ServicePlan;
  /** Defaults to the user's own LaunchAgents folder. */
  plistFile?: string;
  /** The test seam. Leave it alone in real use. */
  run?: Run;
  /** The user id launchd addresses the job by. */
  uid?: number;
}): Service {
  const run = options.run ?? reallyRun;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const file = options.plistFile ?? join(homedir(), "Library", "LaunchAgents", `${options.plan.label}.plist`);
  const target = `gui/${uid}/${options.plan.label}`;

  return {
    file,

    async install() {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, plistFor(options.plan), { mode: 0o644 });

      /**
       * Booted out first, and then waited for.
       *
       * `bootout` returns before launchd has finished unloading, so bootstrapping
       * straight afterwards hits a job that is still there and fails with
       * `Bootstrap failed: 5: Input/output error`. Measured on 2026-08-22 by
       * reinstalling over a running job: the install threw, and left the service
       * booted out and the machine with no relay listening at all, which is the
       * worst of the three possible outcomes.
       */
      await run("launchctl", ["bootout", target]);
      await until(async () => (await run("launchctl", ["print", target])).code !== 0);

      const started = await run("launchctl", ["bootstrap", `gui/${uid}`, file]);
      if (started.code !== 0) {
        throw new Error(`launchd would not take the job: ${started.out.trim() || `exited ${started.code}`}`);
      }

      /**
       * Proved rather than promised.
       *
       * A zero from `bootstrap` says launchd accepted the job description, not that
       * anything is running. An install command that says "the relay is a service
       * now" while nothing is listening is the claim this repository exists not to
       * make.
       */
      const up = await until(async () => (await run("launchctl", ["print", target])).code === 0);
      if (!up) {
        throw new Error(
          `launchd took the job but it is not running. Read ${options.plan.logFile}: that is where it says why.`,
        );
      }
    },

    async uninstall() {
      await run("launchctl", ["bootout", target]);
      await rm(file, { force: true });
    },

    async restart() {
      await run("launchctl", ["kickstart", "-k", target]);
    },

    async status() {
      const held = await readFile(file, "utf8").catch(() => null);
      const printed = await run("launchctl", ["print", target]);
      const pid = /\bpid = (\d+)/.exec(printed.out)?.[1];

      return {
        installed: held !== null,
        running: printed.code === 0 && pid !== undefined,
        pid: pid === undefined ? null : Number(pid),
      };
    },
  };
}
