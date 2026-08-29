/**
 * One door. Everything a person does with this program is typed here.
 *
 * Phase one grew a script per capability, nine of them, which is nine files to
 * remember and no single place that answers "what is going on". This adds no
 * capability: it gives the capabilities one entrance, and it comes before the
 * automatic modes on purpose, because a system that switches on its own is only
 * trustworthy once switching by hand is trivial and its state is one word away.
 *
 * Nothing here prints. Every line goes through an injected writer and every exit
 * is a returned number, so the whole surface — including install and undo — is
 * driven in tests without going near a live Window, the real Keychain or launchd.
 */
import { relayHome, whyThisHomeLooksEmpty, type Home } from "../home/index.ts";
import { isOff, pickPayer, readChoice, readStanding, writeChoice } from "../payer/index.ts";
import { openUsageMemory, type UsageMemory } from "../usage/index.ts";
import { describeVerdict, exitCodeFor, openVerdictLog } from "../verify/index.ts";
import { everySeatHeld, machineVault, openSeatStore, type SeatStore } from "../seats/index.ts";
import { latestBackup } from "../backup/index.ts";
import { commandFrom, CALLED, help } from "./internal/surface.ts";
import { seatLines, statusLines } from "./internal/status.ts";

import type { Machine, Report } from "./internal/machine.ts";

export type { Machine, Report, Examination } from "./internal/machine.ts";
export { thisMachine } from "./internal/machine.ts";
export { CALLED, COMMANDS, help } from "./internal/surface.ts";
export { statusLines, seatLines } from "./internal/status.ts";
export type { WhatIsGoingOn } from "./internal/status.ts";
export { roomFor, roomBrief, roomColumns, roomSpelled, WHAT_THE_LETTERS_MEAN } from "./internal/room.ts";

/** Where the answers go, and where a failure goes, kept apart. */
export type Voice = {
  say: Report;
  /** A failure. Never only an exit code: a code with no sentence is a mystery. */
  complain: (line: string) => void;
};

/**
 * Run one command and give back the exit code it should leave with.
 *
 * Every subcommand exits non-zero when it failed, so any of this can be used in a
 * script. `status` is included in that: it fails when the mechanism is not
 * working, which makes the one word that answers the daily question also the
 * health check.
 */
export async function runControl(options: {
  readonly argv: readonly string[];
  readonly machine: Machine;
  readonly out: Voice;
  readonly home?: Home;
  /** Seconds since 1970. An argument, so every screen is a table in a test. */
  readonly now?: () => number;
  readonly seats?: SeatStore;
  readonly usage?: UsageMemory;
}): Promise<number> {
  const home = options.home ?? relayHome();
  const { say, complain } = options.out;
  const at = (options.now ?? (() => Math.trunc(Date.now() / 1000)))();
  const seats = options.seats ?? openSeatStore({ file: home.seatsFile, vault: machineVault() });
  const usage = options.usage ?? openUsageMemory({ file: home.usageFile });
  const argv = options.argv;

  const command = commandFrom(argv);
  if (command === null) {
    complain(`there is no "${CALLED} ${argv[0]}". This is everything there is:`);
    for (const line of help()) say(line);
    return 1;
  }

  // The long flows keep their own argument handling, in their own process. One
  // door, and not one place pretending to understand four other command lines.
  if (command.handsOff !== undefined) return options.machine.handOffTo(command.handsOff, argv.slice(1));

  try {
    switch (command.name) {
      case "help":
        for (const line of help()) say(line);
        return 0;

      case "status": {
        const [choice, listed, known, verdict, examination, windowRunning, backup, standing] = await Promise.all([
          readChoice(home.choiceFile),
          seats.list(),
          usage.known(at),
          openVerdictLog({ file: home.verdictFile }).last(),
          options.machine.examine(),
          options.machine.windowRunning(),
          latestBackup().catch(() => null),
          readStanding(home.standingFile, at).catch(() => null),
        ]);

        for (const line of statusLines({
          choice,
          seats: listed,
          usage: known,
          verdict,
          examination,
          windowRunning,
          backedUpOn: backup?.on ?? null,
          standing,
          at,
        })) {
          say(line);
        }
        return examination.working ? 0 : 1;
      }

      case "seats": {
        const [choice, listed, known, backup] = await Promise.all([
          readChoice(home.choiceFile),
          seats.list(),
          usage.known(at),
          latestBackup().catch(() => null),
        ]);
        const emptyHome = listed.length === 0 ? whyThisHomeLooksEmpty(home) : null;
        for (const line of seatLines({ choice, seats: listed, usage: known, backedUpOn: backup?.on ?? null, emptyHome, at })) {
          say(line);
        }
        return 0;
      }

      case "auto": {
        /**
         * In force now, including for conversations already running. Their history
         * is re-sent uncached to the new Organization, which is said plainly rather
         * than made into a gate.
         */
        const choice = await readChoice(home.choiceFile);
        await writeChoice(home.choiceFile, { mode: "auto", payer: choice.payer });
        say(`Auto. The Seat with the most room pays, weighed again on every request.`);
        say(`A switch is in force at once. Conversations already running are re-cached to it.`);
        return 0;
      }

      case "on": {
        /**
         * Back to the Seat that was picked, because Off remembers it.
         *
         * Refused rather than guessed at when there is nothing to go back to.
         * Choosing a Seat on the user's behalf here would be Auto mode arriving
         * by accident, three tickets early and with no ranking rule behind it.
         */
        const choice = await readChoice(home.choiceFile);
        if (choice.payer === null) {
          complain(`no Seat has been picked yet, so there is nothing to turn back on.`);
          say(`  ${CALLED} seats        every Seat you own`);
          say(`  ${CALLED} use <seat>   pay with one of them`);
          return 1;
        }

        // Checked before it is written, so a Seat that cannot pay leaves the
        // previous choice standing rather than becoming a Payer that fails.
        await pickPayer({ file: home.choiceFile, among: await seats.list(), name: choice.payer });
        say(`Paying: ${choice.payer}. It takes effect on the next request, with nothing restarted.`);
        return 0;
      }

      case "off": {
        const choice = await readChoice(home.choiceFile);
        await writeChoice(home.choiceFile, { mode: "off", payer: choice.payer });
        say(`Off. Every request lands on the Window account, as if this were not installed.`);
        if (choice.payer !== null) say(`  ${CALLED} on   go back to paying with ${choice.payer}`);
        return 0;
      }

      case "use": {
        const wanted = argv[1];
        if (wanted === undefined) {
          complain(`which Seat? Type "${CALLED} seats" to see them.`);
          return 1;
        }
        const chosen = await pickPayer({ file: home.choiceFile, among: await seats.list(), name: wanted });
        say(`Paying: ${chosen.payer}. It takes effect on the next request, with nothing restarted.`);
        return 0;
      }

      case "verdict": {
        const [choice, verdict] = await Promise.all([
          readChoice(home.choiceFile),
          openVerdictLog({ file: home.verdictFile }).last(),
        ]);
        if (verdict === null) {
          complain(
            isOff(choice)
              ? `Off: nothing is being swapped, so there is nothing to prove.`
              : `no request has been paid for by a Seat yet.`,
          );
          return 1;
        }
        say(`${verdict.kind}: ${describeVerdict(verdict)}`);
        return exitCodeFor(verdict);
      }

      case "page": {
        /**
         * The page is at the relay's own port, because that is the one address
         * the app was already told about. Opening it is the only thing this does:
         * if the relay is not listening, the browser says so better than a check
         * here would, and a check here would be a second opinion that can be
         * wrong.
         */
        const where = `http://127.0.0.1:${home.port}/`;
        say(`Opening ${where}`);
        await options.machine.open(where);
        return 0;
      }

      case "doctor": {
        const examination = await options.machine.examine();
        for (const finding of examination.findings) {
          say(`${finding.ok ? "ok  " : "NO  "}${finding.what}: ${finding.saying}`);
        }

        say("");
        const choice = await readChoice(home.choiceFile);
        /**
         * In Auto there is no Payer until a request arrives, so `choice.payer` is
         * null and this used to read `Payer: null`. Said in words instead, the
         * same words the status uses, because the two screens answering the one
         * question differently is how a reader learns to trust neither.
         */
        say(
          `Mode: ${choice.mode}, Payer: ${
            isOff(choice)
              ? "the Window account"
              : (choice.payer ?? "not chosen yet, because nothing has asked")
          }`,
        );
        const verdict = await openVerdictLog({ file: home.verdictFile }).last();
        say(verdict === null ? `No request has been paid for by a Seat yet.` : `Last: ${describeVerdict(verdict)}`);

        if (!examination.working) {
          say("");
          complain(`The mechanism is not working, so nothing here can tell you which Seat is paying.`);
        }
        return examination.working ? 0 : 1;
      }

      case "install": {
        // Said before anything is written, because the one cost of installing is
        // a restart of the app and the reader has to hear it from us.
        if (await options.machine.windowRunning()) {
          say(`Claude Desktop is running. Sessions in that Window are untouched by this and keep`);
          say(`working exactly as they are: it read its settings when it started, and nothing here`);
          say(`reaches a Window that is already open.`);
          say("");
        }

        await options.machine.install(say);

        say("");
        say(`One thing left, and only once: close Claude Desktop and open it again.`);
        say(`The app reads that store when it starts, so a Window already running cannot be`);
        say(`brought in. After that, open it however you like and it is always relayed.`);
        say("");
        for (const line of help()) say(line);
        return 0;
      }

      case "uninstall": {
        if (await options.machine.windowRunning()) {
          say(`Claude Desktop is running right now.`);
          say("");
          say(`It read this relay's address when it started and cannot be told otherwise, so Code`);
          say(`sessions in that Window will stop reaching the network the moment this finishes,`);
          say(`and stay that way until you close the app and open it again. The app itself is`);
          say(`unaffected: it uses the system proxy, not these variables.`);
          say("");
          say(`Carrying on. Restart Claude Desktop when this is done.`);
          say("");
        }

        /**
         * Stop before throwing away the one thing here that cannot be rebuilt.
         *
         * Every other thing this removes can be put back by installing again. A
         * Send token cannot: it comes from an interactive sign-in as its own
         * account with the right Organization active, and there is one for every
         * Seat. Losing them as a side effect of tidying up is what this exists to
         * prevent, so it is refused rather than warned about, and it is checked
         * before anything at all is taken away.
         */
        const meantIt = argv.includes("--and-forget-the-tokens");

        /**
         * A Seat list that could not be read is not a list with no tokens in it.
         *
         * It used to be treated as one, and that is the exact case where the
         * refusal below is most needed: a Keychain that will not answer takes the
         * guard off and then the tokens go anyway. Unreadable means
         * stop, unless the user has already said they mean it.
         */
        const holding = await seats.list().catch((error: unknown) => error as Error);
        if (holding instanceof Error && !meantIt) {
          complain(
            `the Seats could not be read, so this cannot tell whether it would throw away Send tokens: ` +
              `${holding.message}`,
          );
          complain(`Nothing has been changed.`);
          return 1;
        }

        const withTokens = holding instanceof Error ? [] : holding.filter((seat) => seat.hasSendToken);
        if (withTokens.length > 0 && !meantIt) {
          say();
          say(`STOP. ${withTokens.length} Seats have a Send token, and this would forget every one of them.`);
          say(`Each one is a sign-in by hand as its own account. Nothing here can mint them again for you.`);
          say();
          say(`Back them up first:`);
          say(`  ${CALLED} back-up-seats`);
          say();
          say(`Then, if you still want them gone:`);
          say(`  ${CALLED} uninstall --and-forget-the-tokens`);
          say();
          complain(`Nothing has been changed.`);
          return 1;
        }

        /**
         * Exactly the Seats this relay lists, by name, and nothing else.
         *
         * The Keychain is shared by every relay on this machine, so a Send token
         * held for a Seat this store does not list belongs to something else. It
         * is named rather than removed, because leaving a stray is recoverable and
         * removing somebody else's is not.
         */
        const forget = withTokens.map((seat) => seat.name);
        const alsoHeld = (await everySeatHeld().catch(() => [])).filter((name) => !forget.includes(name));
        if (alsoHeld.length > 0) {
          say(
            `${alsoHeld.length} Send tokens in the Keychain belong to Seats this relay does not list, ` +
              `so they are being left alone: ${alsoHeld.join(", ")}`,
          );
        }

        // Forgotten here and nowhere else, by name, one at a time, after the
        // refusal above. Nothing else in this program can reach a Send token.
        for (const name of forget) await seats.remove(name);
        say(
          forget.length === 0
            ? `no Send tokens were held by this relay, so none were forgotten.`
            : `forgot ${forget.length} Send token${forget.length === 1 ? "" : "s"}: ${forget.join(", ")}`,
        );

        const done = await options.machine.uninstall(say);
        if (!done) return 1;

        say("");
        say(`Done. Close Claude Desktop and open it again, and it behaves exactly as before.`);
        return 0;
      }
    }

    // Every command that does not hand off is answered above. Arriving here means
    // the table gained a name and this switch did not, which is worth saying
    // rather than exiting zero on a command that did nothing at all.
    complain(`"${CALLED} ${command.typed}" is listed but not wired up. That is a fault here, not a mistake of yours.`);
    return 1;
  } catch (error) {
    complain(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
