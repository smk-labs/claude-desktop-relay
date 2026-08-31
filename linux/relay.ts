/**
 * The one command, on Linux.
 *
 *   relay-linux                 who is paying for this Window
 *   relay-linux seats           every Seat and the room it has left
 *   relay-linux auto            let the best Seat pay, weighed on every request
 *   relay-linux use <seat>      pay with that Seat and hold it there
 *   relay-linux manual          hold the Seat that is picked, whatever the ranking says
 *   relay-linux off             leave everything on the Window account
 *   relay-linux serve [port]    run the relay in this terminal
 *   relay-linux history         what every Seat has spent, and on which project
 *   relay-linux trust           let this Window's Code sessions trust the relay
 *   relay-linux launch          start Claude Desktop pointed at the relay
 *   relay-linux refresh         ask every stale Seat what it has spent
 *   relay-linux tray            the icon in the notification area
 *   relay-linux install-service the relay starts itself, the tray with the session
 *   relay-linux restore-seats   put the Send tokens back from a backup
 *
 * A surface of its own rather than the macOS `src/control`, on purpose: that one
 * carries doctor, install, uninstall, the page, collect-seats and back-up-seats,
 * none of which exist here, and a door with six handles that do nothing is worse
 * than a smaller door. The tray and the service do exist here, and they are two
 * lines above. Everything underneath this file is the same code.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openSeatStore } from "../src/seats/index.ts";
import { openUsageMemory } from "../src/usage/index.ts";
import { openVerdictLog } from "../src/verify/index.ts";
import { pickPayer, readChoice, readStanding, turnOff, writeChoice } from "../src/payer/index.ts";
import { latestBackup } from "../src/backup/index.ts";
import { linuxSeatLines } from "./internal/seat-lines.ts";
import { fileVault } from "./internal/file-vault.ts";
import { examineLinux } from "./internal/examine.ts";
import { linuxStatusLines } from "./internal/say-status.ts";
import { linuxHome, vaultFile, DESKTOP_FOLDER, TRIAL_LAUNCHER } from "./internal/where.ts";
import { trustTheRelay } from "./internal/trust.ts";

/**
 * A reader that goes away is not an error.
 *
 * `relay-linux status | head -3` closes the pipe after three lines, and the next
 * write raises EPIPE. Unhandled, that is a stack trace where the answer should be,
 * which makes a perfectly good command look broken the first time somebody pipes
 * it into anything.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const say = (line = "") => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`${line}\n`);

const home = linuxHome();
const seats = openSeatStore({ file: home.seatsFile, vault: fileVault(vaultFile(home)) });
const usage = openUsageMemory({ file: home.usageFile });
const at = Math.trunc(Date.now() / 1000);

const HELP = [
  `relay-linux                 who is paying for this Window`,
  `relay-linux seats           every Seat and the room it has left`,
  `relay-linux auto            let the best Seat pay, weighed on every request`,
  `relay-linux use <seat>      pay with that Seat and hold it there`,
  `relay-linux manual          hold the Seat that is picked, whatever the ranking says`,
  `relay-linux off             leave everything on the Window account`,
  `relay-linux serve [port]    run the relay in this terminal`,
  `relay-linux history         what every Seat has spent, and on which project`,
  `relay-linux trust           let this Window's Code sessions trust the relay`,
  `relay-linux launch          start Claude Desktop pointed at the relay`,
  `relay-linux refresh         ask every stale Seat what it has spent`,
  `relay-linux tray            the icon in the notification area`,
  `relay-linux install-service the relay starts itself, the tray with the session`,
  `relay-linux restore-seats   put the Send tokens back from a backup`,
];

/** Hand a flow that needs its own process this terminal, and give back its code. */
function handOff(script: string, args: readonly string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [join(here, script), ...args], { stdio: "inherit" });
    child.on("error", (error) => {
      complain(`${script} could not be started: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function status(): Promise<number> {
  const [choice, listed, known, verdict, standing] = await Promise.all([
    readChoice(home.choiceFile),
    seats.list(),
    usage.known(at),
    openVerdictLog({ file: home.verdictFile }).last(),
    readStanding(home.standingFile, at).catch(() => null),
  ]);

  const examination = await examineLinux({
    port: home.port,
    caCertificate: join(home.certificateFolder, "ca.crt"),
    seatsWithTokens: listed.filter((seat) => seat.hasSendToken).length,
  });

  for (const line of linuxStatusLines({ choice, seats: listed, usage: known, verdict, standing, examination, at })) {
    say(line);
  }
  // Non-zero when the mechanism is not working, so the one word that answers the
  // daily question is also the health check a script can use.
  return examination.working ? 0 : 1;
}

const argv = process.argv.slice(2);
const command = argv[0] ?? "status";

let code = 1;
try {
  switch (command) {
    case "status":
      code = await status();
      break;

    case "seats": {
      // The backup is asked for rather than assumed absent: told there is none,
      // the list ends by telling the reader to take one, and being nagged for a
      // backup that is sitting right there is how a screen loses its credibility.
      const [choice, listed, known, backup, standing] = await Promise.all([
        readChoice(home.choiceFile),
        seats.list(),
        usage.known(at),
        latestBackup().catch(() => null),
        readStanding(home.standingFile, at).catch(() => null),
      ]);
      for (const line of linuxSeatLines({
        choice,
        seats: listed,
        usage: known,
        standing: standing?.seat ?? null,
        backedUpOn: backup?.on ?? null,
        at,
      })) {
        say(line);
      }
      code = 0;
      break;
    }

    case "auto":
      await writeChoice(home.choiceFile, { mode: "auto", payer: (await readChoice(home.choiceFile)).payer });
      say(`Auto. The Seat with the most room pays, weighed again on every request.`);
      code = 0;
      break;

    case "manual": {
      // Manual with nobody picked pays nothing through a Seat, so the one thing
      // this must not do is leave the machine in that state silently.
      const held = (await readChoice(home.choiceFile)).payer;
      await writeChoice(home.choiceFile, { mode: "manual", payer: held });
      say(
        held === null
          ? `Manual, and no Seat is picked yet, so the Window account pays until one is.  relay-linux use <seat>`
          : `Manual. ${held} pays, and the ranking will not move it.`,
      );
      code = 0;
      break;
    }

    case "off":
      await turnOff(home.choiceFile);
      say(`Off. Every request lands on the Window account, exactly as if this were not installed.`);
      code = 0;
      break;

    case "use": {
      const wanted = argv[1];
      if (wanted === undefined) {
        complain(`Which Seat? Try:  relay-linux seats`);
        break;
      }
      // The same call the macOS page makes, and it sets manual for the same
      // reason: a deliberate choice is not to be overridden by the ranking.
      await pickPayer({ file: home.choiceFile, among: await seats.list(), name: wanted });
      say(`${wanted} pays from now on, including conversations already running.`);
      code = 0;
      break;
    }

    case "serve":
      code = await handOff("serve.ts", argv.slice(1));
      break;

    case "history":
      /**
       * The rows the relay keeps, read by the macOS command that reads them.
       *
       * `linux/serve.ts` has written a row per exchange since it was written, and
       * until now there was no way to read one back: the record existed and the
       * door to it did not. `scripts/history.ts` needs nothing macOS has. It finds
       * its home through `relayHome`, which reads the same `CLAUDE_RELAY_HOME` this
       * side does, so it opens the same file this relay writes. Out of `linux/`
       * rather than beside it, which is the one hop this hand-off makes that the
       * others do not.
       */
      code = await handOff(join("..", "scripts", "history.ts"), argv.slice(1));
      break;

    case "restore-seats":
      code = await handOff("restore-seats.ts", argv.slice(1));
      break;

    case "refresh": {
      const { refreshStaleSeats } = await import("../src/usage/index.ts");
      // Everything, when asked by hand: somebody typing this wants the numbers
      // now, not the ones that happen to be older than the round's threshold.
      const summary = await refreshStaleSeats({
        seats,
        usage,
        at,
        olderThan: 0,
        // Direct, which is what this machine does and what `linux/serve.ts` says
        // in the same words. Stated rather than defaulted: a Send token is a
        // Seat's credential, and how it leaves is never something to leave blank.
        route: { egress: async () => ({ kind: "direct" }) },
        say: complain,
      });
      say(`${summary.answered} of ${summary.asked} Seats answered.`);
      if (summary.failed > 0) say(`${summary.failed} could not be reached.`);
      say(`See them with:  relay-linux seats`);
      code = summary.failed === 0 ? 0 : 1;
      break;
    }

    case "install-service":
      code = await handOff("install-service.ts", argv.slice(1));
      break;

    case "tray": {
      code = await new Promise<number>((resolve) => {
        const child = spawn(join(here, "tray", "relay-tray.sh"), argv.slice(1), { stdio: "inherit" });
        child.on("error", (error) => {
          complain(`the tray could not be started: ${error.message}`);
          resolve(1);
        });
        child.on("close", (exit) => resolve(exit ?? 1));
      });
      break;
    }

    case "trust": {
      const armed = await trustTheRelay({
        desktopFolder: DESKTOP_FOLDER,
        caCertificate: join(home.certificateFolder, "ca.crt"),
        port: home.port,
      });
      say(`Claude Desktop's own store now carries the relay's address and our certificate.`);
      say(`Every Code session it starts comes to us, however the app was launched.`);
      say(`  ${armed.file}`);
      say(`A Window that is already open read its store when it started, so it needs restarting.`);
      code = 0;
      break;
    }

    case "launch": {
      /**
       * The certificate goes in before the app starts, every time, because the
       * app reads that store once at startup and never again. Doing it here
       * rather than leaving it to be remembered is the difference between a
       * Window that works and a Window whose Code sessions refuse the relay's
       * answer for a reason nothing on screen explains.
       */
      await trustTheRelay({
        desktopFolder: DESKTOP_FOLDER,
        caCertificate: join(home.certificateFolder, "ca.crt"),
        port: home.port,
      });

      // Ours wraps the isolated launcher rather than replacing it: that script
      // holds the display guard and the config isolation, and neither is ours to
      // reimplement.
      code = await new Promise<number>((resolve) => {
        const child = spawn(join(here, "bin", "claude-desktop-relayed"), argv.slice(1), { stdio: "inherit" });
        child.on("error", (error) => {
          complain(`Claude Desktop could not be started: ${error.message}`);
          complain(`The isolated launcher it wraps is ${TRIAL_LAUNCHER}`);
          resolve(1);
        });
        child.on("close", (exit) => resolve(exit ?? 1));
      });
      break;
    }

    case "help":
    case "--help":
      for (const line of HELP) say(line);
      code = 0;
      break;

    default:
      complain(`There is no "relay-linux ${command}". This is everything there is:`);
      for (const line of HELP) say(line);
  }
} catch (error) {
  complain(error instanceof Error ? error.message : String(error));
}

/** The code, not `process.exit`: a pipe that is still flushing loses its last lines. */
process.exitCode = code;
