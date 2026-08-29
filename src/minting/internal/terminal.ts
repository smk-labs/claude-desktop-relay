import { spawn } from "node:child_process";

import { ON_WINDOWS } from "../../home/index.ts";
import { underAWindowsTerminal } from "./windows-terminal.ts";

/**
 * Running a program with a real terminal, and being able to type into it.
 *
 * `claude setup-token` writes to a terminal or it writes nothing: measured on
 * 2026-08-23, piped stdio produced zero bytes in eight seconds, and
 * `setup-token --help` offers no flag to ask for anything else. So driving it
 * needs a pseudo-terminal rather than a pipe.
 *
 * Node has no pseudo-terminal of its own and the packages that add one are native
 * builds. macOS ships two programs that already have one. `script` is the obvious
 * choice and cannot be used: it calls `tcgetattr` on its own standard input and
 * fails with "operation not supported on socket" the moment that is a pipe, which
 * it always is here. `/usr/bin/expect` allocates the pty itself, needs nothing of
 * ours to be a terminal, and is part of the operating system rather than a
 * dependency.
 *
 * Windows has neither, and its answer is in `windows-terminal.ts`: a real console
 * window, a child handed that same console, and the console's own buffer read
 * back. `underATerminal` at the foot of this file is the one of the two this
 * machine has.
 */
const EXPECT = "/usr/bin/expect";

/**
 * The command to drive, handed over through the environment rather than as
 * arguments.
 *
 * `expect -c` treats every remaining argument as a script file, so a command
 * cannot be passed after it, and building one Tcl line out of a program and its
 * arguments means inventing a quoting rule. One variable holding newline separated
 * parts has no quoting rule to get wrong, and a part that itself held a newline
 * would be split, so that is refused rather than mangled.
 */
const ARGV_VARIABLE = "RELAY_MINT_ARGV";

/**
 * The pty is made wide before the child says anything.
 *
 * `claude` lays its output out to the terminal's own width, so an authorization
 * link of about four hundred characters arrives from an eighty column terminal
 * with newlines in the middle of it, and a newline the program put there cannot be
 * told from one it meant. There is no unwrapping that afterwards, so the wrapping
 * is prevented instead. `stty_init` is expect's own way to size the pty;
 * `stty ... < $spawn_id` is not, and fails with "couldn't open exp5" on macOS.
 */
const DRIVER = [
  "set timeout -1",
  "log_user 1",
  'set stty_init "rows 60 columns 1000"',
  `set parts [split $env(${ARGV_VARIABLE}) "\\n"]`,
  "spawn -noecho {*}$parts",
  "interact { -input $user_spawn_id -output $spawn_id -input $spawn_id -output $user_spawn_id }",
].join("\n");

/** How a run under a terminal ended. */
export type TerminalEnd = {
  readonly code: number;
  /** Set when the run was ended from this side rather than by the child. */
  readonly stoppedBecause: string | null;
};

export type TerminalSession = {
  /** Type into the child, as a person at the keyboard would. */
  readonly type: (text: string) => void;
  /** End it now, taking the whole process group. */
  readonly stop: (because: string) => void;
  readonly finished: Promise<TerminalEnd>;
};

export type OpenATerminal = (options: {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Every byte the child said, as it arrives. */
  readonly onSaid: (text: string) => void;
}) => TerminalSession;

/**
 * Run a command with a terminal of its own.
 *
 * The whole process group is killed on the way out, because a child killed on its
 * own leaves the ones it started, and here the child is expect and the program
 * that matters is expect's child.
 */
const underAUnixTerminal: OpenATerminal = ({ command, env, onSaid }) => {
  const offending = command.find((part) => part.includes("\n"));
  if (offending !== undefined) {
    throw new Error(`a command to mint with cannot contain a newline, and one part does: ${JSON.stringify(offending)}`);
  }

  const child = spawn(EXPECT, ["-c", DRIVER], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: { ...env, [ARGV_VARIABLE]: command.join("\n") },
  });

  let ended: ((end: TerminalEnd) => void) | null = null;
  let stoppedBecause: string | null = null;
  const finished = new Promise<TerminalEnd>((resolve) => (ended = resolve));

  const settle = (end: TerminalEnd) => {
    ended?.(end);
    ended = null;
  };

  child.stdout.on("data", (chunk: Buffer) => onSaid(chunk.toString("utf8")));
  // expect says its own troubles here, and a missing /usr/bin/expect or a Tcl
  // error is the difference between "the mint failed" and "this machine cannot
  // run the mint at all", so it is heard rather than dropped.
  child.stderr.on("data", (chunk: Buffer) => onSaid(chunk.toString("utf8")));
  child.on("error", (error) => settle({ code: -1, stoppedBecause: error.message }));
  child.on("close", (code) => settle({ code: code ?? -1, stoppedBecause }));
  // A stdin that goes away when the child does must not take the process with it.
  child.stdin.on("error", () => {});

  return {
    type: (text) => child.stdin.write(text),
    stop: (because) => {
      stoppedBecause = because;

      // There is no group to kill if the spawn never got a pid, and the obvious
      // default is the worst line in the file: `process.kill(-0, ...)` is defined
      // as every process in the *caller's* group, so a failed spawn would kill
      // the relay and the shell that started it.
      const pid = child.pid;
      if (pid === undefined) {
        settle({ code: -1, stoppedBecause: because });
        return;
      }

      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
    finished,
  };
};

/**
 * The terminal this machine has.
 *
 * One name above this line, so `src/minting` never learns which machine it is on
 * and the two drivers are held to the same interface.
 */
export const underATerminal: OpenATerminal = (options) =>
  (ON_WINDOWS ? underAWindowsTerminal : underAUnixTerminal)(options);
