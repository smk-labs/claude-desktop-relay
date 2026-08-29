import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenATerminal, TerminalEnd, TerminalSession } from "./terminal.ts";

/**
 * Running `claude setup-token` with a real terminal on Windows.
 *
 * The same measurement as macOS, taken again here on 2026-08-25: piped stdio
 * produced zero bytes in ten seconds. That command writes to a terminal or it
 * writes nothing, on both machines, and `setup-token --help` offers no flag to
 * ask for anything else.
 *
 * macOS solves it with `/usr/bin/expect`, which allocates a pseudo-terminal.
 * Windows has no `expect` and no pseudo-terminal Node can allocate without a
 * native build, and adding one would be the first native dependency this program
 * has. What Windows does have is a console and a shell that can read it:
 * PowerShell in a real console window can hand a child that same console with
 * `-NoNewWindow`, and can then read back what the child drew with
 * `GetBufferContents`. That is a terminal, and the reading is what a person would
 * see on the screen.
 *
 * Three things follow from it and each one is load-bearing.
 *
 * The console window is visible. It has to be: a console nobody can see is a
 * console the window station will not give a real screen buffer, and this needs
 * the buffer. It is also the right behaviour rather than a concession, because
 * `claude setup-token` is an interactive authorization and the person is at the
 * keyboard by definition (`src/minting` refuses to run when nobody is).
 *
 * The buffer is made a thousand columns wide before the child says anything.
 * `claude` lays its output out to the terminal's own width, so an authorization
 * link of about four hundred characters arrives from an eighty column terminal
 * with newlines in the middle of it, and a newline the program put there cannot
 * be told from one it meant. There is no unwrapping that afterwards, so the
 * wrapping is prevented instead. This is `stty_init "columns 1000"` on the other
 * machine, and the same number for the same reason.
 *
 * And the buffer is a screen rather than a stream, so what is new has to be worked
 * out here. Each reading is the whole screen; what is passed on is the part that
 * was not there last time.
 */

/** How often the screen is read. Fast enough that a link appears at once. */
const LOOK_EVERY_MS = 300;

/** Wide enough that the authorization link is never wrapped. */
const COLUMNS = 1000;

/**
 * Tall enough that a whole mint fits without scrolling.
 *
 * Scrolling is what would break the diff below: the top of the buffer would move
 * and the common prefix would vanish, so the whole screen would be passed on
 * again as though it were new. A mint is a few dozen lines, so this is far more
 * than it can need.
 */
const ROWS = 3000;

/**
 * One argument as the child will read it back.
 *
 * `Start-Process -ArgumentList` joins its list with spaces and quotes nothing, so
 * an argument that holds a space arrives at the child as two. The rule Windows
 * itself parses by is the one applied here: wrap in double quotes, double any
 * backslashes that run up to a quote, and escape the quotes.
 */
export function asOneArgument(part: string): string {
  // A run of backslashes is literal on its own and an escape in front of a quote,
  // so each run that meets one is doubled and the quote is escaped, and a run at
  // the very end is doubled because the closing quote follows it.
  const escaped = part.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

/** The same string, as a PowerShell single-quoted literal. */
function asPowerShellText(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * The driver, which is the whole Windows half of this module.
 *
 * `-NoNewWindow` is the one that matters: it hands the child this console rather
 * than opening a second one, which is what makes the child's output land in the
 * buffer this script can read.
 */
function driver(options: { command: readonly string[]; saidTo: string; endedTo: string }): string {
  const [program, ...rest] = options.command;
  const argv = rest.map((one) => asPowerShellText(asOneArgument(one)));

  return [
    `$ErrorActionPreference = 'Continue'`,
    // Anything that goes wrong in here has to be sayable, or the only symptom is
    // a console window that appears and does nothing at all.
    `trap { Set-Content -Path '${options.endedTo}' -Value "-1 $($_.Exception.Message)" -Encoding UTF8; exit 1 }`,
    `$raw = $Host.UI.RawUI`,
    `try {`,
    `  $raw.BufferSize = New-Object System.Management.Automation.Host.Size(${COLUMNS}, ${ROWS})`,
    `} catch {`,
    `  # A host that will not be resized still works; the link may arrive wrapped.`,
    `}`,
    ``,
    `function Read-Screen {`,
    `  $size = $Host.UI.RawUI.BufferSize`,
    `  $from = New-Object System.Management.Automation.Host.Rectangle(0, 0, ($size.Width - 1), ($Host.UI.RawUI.CursorPosition.Y))`,
    `  $held = $Host.UI.RawUI.GetBufferContents($from)`,
    `  $lines = New-Object System.Text.StringBuilder`,
    `  for ($y = 0; $y -lt $held.GetLength(0); $y++) {`,
    `    $line = New-Object System.Text.StringBuilder`,
    // `GetValue` rather than `$held[$y, $x]`: what comes back is a rectangular
    // array, and PowerShell reads that index form as a slice of a flat one and
    // refuses to parse it. The symptom is a console window that opens and does
    // nothing at all, which is why the trap above exists.
    `    for ($x = 0; $x -lt $held.GetLength(1); $x++) { [void]$line.Append($held.GetValue($y, $x).Character) }`,
    `    [void]$lines.AppendLine($line.ToString().TrimEnd())`,
    `  }`,
    `  return $lines.ToString()`,
    `}`,
    ``,
    /**
     * One line, and no line continuations anywhere in this script.
     *
     * PowerShell's continuation is a backtick that is the last character on the
     * line, and this file is written with CRLF because that is what Windows reads
     * it back as. The carriage return between the backtick and the newline is
     * enough to break it: the script then fails to parse, PowerShell exits, and
     * the only symptom is a console window that appears and does nothing.
     */
    `$child = Start-Process -FilePath ${asPowerShellText(program ?? "")}${argv.length === 0 ? "" : ` -ArgumentList @(${argv.join(", ")})`} -NoNewWindow -PassThru`,
    ``,
    `while (-not $child.HasExited) {`,
    `  try { Set-Content -Path '${options.saidTo}' -Value (Read-Screen) -Encoding UTF8 } catch { }`,
    `  Start-Sleep -Milliseconds ${LOOK_EVERY_MS}`,
    `}`,
    `try { Set-Content -Path '${options.saidTo}' -Value (Read-Screen) -Encoding UTF8 } catch { }`,
    `Set-Content -Path '${options.endedTo}' -Value $child.ExitCode -Encoding UTF8`,
    // Unused, and named so nobody wonders: the console closes with this script.
    `exit $child.ExitCode`,
  ].join("\r\n");
}

/** What was said that was not said before. The buffer is a screen, not a stream. */
function whatIsNew(before: string, now: string): string {
  let same = 0;
  while (same < before.length && same < now.length && before[same] === now[same]) same += 1;
  return now.slice(same);
}

export const underAWindowsTerminal: OpenATerminal = ({ command, env, onSaid }) => {
  const offending = command.find((part) => part.includes("\n"));
  if (offending !== undefined) {
    throw new Error(`a command to mint with cannot contain a newline, and one part does: ${JSON.stringify(offending)}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "relay-mint-"));
  const saidTo = join(scratch, "screen.txt");
  const endedTo = join(scratch, "ended.txt");
  const script = join(scratch, "driver.ps1");
  writeFileSync(script, driver({ command, saidTo, endedTo }), "utf8");

  /**
   * Started through `cmd /c start`, because that is what gives it a console
   * window of its own, and a console window is the whole point. The title after
   * `start` is not optional: `start` reads the first quoted argument as the window
   * title, so with none of its own it would take the program's own path for the
   * title and open nothing at all.
   */
  const child = spawn(
    "cmd.exe",
    ["/c", "start", "Claude authorization", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { stdio: "ignore", env, windowsHide: false, detached: true },
  );

  let ended: ((end: TerminalEnd) => void) | null = null;
  let stoppedBecause: string | null = null;
  const finished = new Promise<TerminalEnd>((resolve) => (ended = resolve));

  let seen = "";
  const settle = (end: TerminalEnd) => {
    clearInterval(looking);
    rmSync(scratch, { recursive: true, force: true });
    ended?.(end);
    ended = null;
  };

  const looking = setInterval(() => {
    const screen = (() => {
      try {
        return readFileSync(saidTo, "utf8");
      } catch {
        return null;
      }
    })();
    // `Set-Content -Encoding UTF8` writes a byte order mark on Windows PowerShell,
    // so the first reading starts with one. Taken off here rather than left for
    // whatever reads the text to trip over.
    const withoutTheMark = screen === null ? null : screen.replace(/^﻿/, "");
    if (withoutTheMark !== null && withoutTheMark !== seen) {
      const fresh = whatIsNew(seen, withoutTheMark);
      seen = withoutTheMark;
      if (fresh !== "") onSaid(fresh);
    }

    const code = (() => {
      try {
        return Number(readFileSync(endedTo, "utf8").trim());
      } catch {
        return null;
      }
    })();
    if (code !== null) settle({ code: Number.isInteger(code) ? code : -1, stoppedBecause });
  }, LOOK_EVERY_MS);

  child.on("error", (error) => settle({ code: -1, stoppedBecause: error.message }));

  return {
    /**
     * Not supported here, and refused rather than silently ignored.
     *
     * Nothing in this program types into a mint: `claude setup-token` runs its own
     * callback on this machine and finishes when the browser reaches it. If that
     * ever changes, this has to be written rather than discovered to be missing.
     */
    type: () => {
      throw new Error(`typing into a mint is not supported on Windows, and nothing here does it`);
    },
    stop: (because) => {
      stoppedBecause = because;
      // The whole tree, because the process started here is `cmd`, the one that
      // matters is PowerShell's child, and killing the first leaves both.
      const killing = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${script.replace(/\\/g, "\\")}*' -or ` +
            `$_.CommandLine -like '*setup-token*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { stdio: "ignore", windowsHide: true },
      );
      killing.once("exit", () => settle({ code: -1, stoppedBecause: because }));
      killing.once("error", () => settle({ code: -1, stoppedBecause: because }));
    },
    finished,
  } satisfies TerminalSession;
};
