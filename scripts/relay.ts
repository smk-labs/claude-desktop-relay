/**
 * The one command.
 *
 *   node scripts/relay.ts              what is paying for this Window
 *   node scripts/relay.ts use <seat>   pay with that Seat instead
 *   node scripts/relay.ts help         everything there is
 *
 * Put it on your path once and the daily question is one word:
 *
 *   alias relay='node <this repo>/scripts/relay.ts'
 *
 * Everything is in `src/control`. This file exists to hold the three things a
 * program is not allowed to hide from: where it writes, where this repository is,
 * and how a flow that needs its own process is started.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { relayHome } from "../src/home/index.ts";
import { runControl, thisMachine } from "../src/control/index.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const code = await runControl({
  argv: process.argv.slice(2),
  machine: thisMachine({
    home: relayHome(),
    repo,
    node: process.execPath,
    /**
     * The long flows run in their own process, sharing this terminal.
     *
     * `inherit` on all three streams, because two of them are interactive
     * sittings: `collect-seats` mints a Send token per account by driving
     * `claude setup-token` at a terminal, and there is no version of that which
     * works through a pipe.
     */
    handOff: (script, args) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [join(repo, "scripts", script), ...args], { stdio: "inherit" });
        child.on("error", (error) => {
          process.stderr.write(`${script} could not be started: ${error.message}\n`);
          resolve(1);
        });
        child.on("close", (exit) => resolve(exit ?? 1));
      }),
  }),
  out: {
    say: (line) => process.stdout.write(`${line ?? ""}\n`),
    complain: (line) => process.stderr.write(`${line}\n`),
  },
});

/**
 * The code, not `process.exit`.
 *
 * Writing to a pipe is asynchronous, and exiting outright throws away whatever
 * has not been flushed. `relay seats | head` losing its last lines is exactly the
 * kind of thing nobody reports and everybody works around.
 */
process.exitCode = code;
