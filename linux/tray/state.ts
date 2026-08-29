/**
 * What the tray needs, in the plainest form a shell script can read.
 *
 * A format of its own rather than parsing the screens a person reads: those are
 * written for a person and change when a sentence reads better, and a tray that
 * broke every time a word moved would be worse than no tray. Tab-separated,
 * one thing per line, nothing to quote.
 *
 *   mode       auto|manual|off
 *   paying     <seat or ->  <room spelled out>
 *   icon       off|on|strained|broken
 *   relaying   <which Claude Desktop these figures are about>
 *   refreshed  <when the figures were last read, in one sentence>
 *   working    yes|no
 *   window     running|closed
 *   service    <this relay's systemd unit, for the menu item that restarts it>
 *   seat       <name>  <plan>  <room in brief>  <paying: yes|no>
 *
 * The plan is `20x` rather than a bare `20`, because that is the word the macOS
 * and Windows trays put beside a Seat and the three menus are one menu.
 *
 * Seats come back worth-the-most first, the same order the list a person reads
 * uses, so the tray's short list is the top of that one rather than a different
 * opinion.
 */
import { openSeatStore } from "../../src/seats/index.ts";
import { openUsageMemory } from "../../src/usage/index.ts";
import { readChoice, readStanding } from "../../src/payer/index.ts";
import { roomBrief, roomSpelled } from "../../src/control/index.ts";
import { sayRefreshed } from "../../src/tray/index.ts";
import { asAgo, asClock, asMultiplier, type Icon } from "../../src/page/index.ts";
import { fileVault } from "../internal/file-vault.ts";
import { examineLinux } from "../internal/examine.ts";
import { linuxHome, serviceNameFor, vaultFile } from "../internal/where.ts";
import { join } from "node:path";

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

const home = linuxHome();
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = Math.trunc(Date.now() / 1000);
const seats = openSeatStore({ file: home.seatsFile, vault: fileVault(vaultFile(home)) });
const usage = openUsageMemory({ file: home.usageFile });

const [choice, listed, known, standing] = await Promise.all([
  readChoice(home.choiceFile),
  seats.list(),
  usage.known(at),
  readStanding(home.standingFile, at).catch(() => null),
]);

const examination = await examineLinux({
  port: home.port,
  caCertificate: join(home.certificateFolder, "ca.crt"),
  seatsWithTokens: listed.filter((seat) => seat.hasSendToken).length,
});

const heldFor = (seat: string | null) => known.find((held) => held.seat === seat);

/** Who is paying, as the relay would decide it right now. */
const paying = choice.mode === "off" ? null : choice.mode === "auto" ? (standing?.seat ?? null) : choice.payer;

const out: string[] = [];
out.push(`mode\t${choice.mode}`);
// Spelled out in whole words, because this is the tooltip: one line, nobody
// squinting at a column of them, and no legend on screen to lean on.
out.push(`paying\t${paying ?? "-"}\t${paying === null ? "the Window account" : roomSpelled(heldFor(paying), at)}`);

/**
 * Past this share of its week spent, the Seat paying is running out.
 *
 * The same three quarters `src/page/internal/tray.ts` calls `STRAINED`, written
 * again because that constant is private to the page and this machine has no page
 * to ask. It is a threshold in two places and one number: if it moves there, it
 * moves here, and the four names either side of it are that file's `Icon` type,
 * imported, so the three trays cannot drift into different vocabularies.
 */
const STRAINED = 0.75;

/**
 * Which of the four the icon should draw, decided here and not in the shell.
 *
 * The shell used to work this out again from `working`, `mode` and `paying`, and
 * got three states where the other two trays have four: a Seat past three quarters
 * of its week looked exactly like a healthy one, so the panel said everything was
 * fine right up to the request that was refused. Two places deciding one thing is
 * also how the panel and the relay come to disagree.
 *
 * Waiting is on, not off. Auto picks per request, so between a restart and the
 * next request there is genuinely no Seat yet, and drawing that as Off says the
 * relay is doing nothing when it is about to pay for everything.
 */
const spentOfWeek = paying === null ? null : heldFor(paying)?.sevenDay ?? null;
const icon: Icon = !examination.working
  ? "broken"
  : paying !== null
    ? spentOfWeek !== null && !spentOfWeek.hasReset && spentOfWeek.utilization >= STRAINED
      ? "strained"
      : "on"
    : choice.mode === "off"
      ? "off"
      : "on";
out.push(`icon\t${icon}`);

/**
 * Which Claude Desktop these figures are about. ADR 0014.
 *
 * The other two trays draw this as a heading. A `yad` menu has no disabled row, so
 * on this machine it goes in the tooltip, and the words are the page's own machine
 * row so all three name the same thing the same way.
 */
const shorten = (path: string) => {
  const under = process.env["HOME"] ?? "";
  return under !== "" && path.startsWith(under) ? `~${path.slice(under.length)}` : path;
};
out.push(`relaying\t${shorten(home.appSupport)} · every Code session in it`);

/**
 * When the figures were last read, said the way the other two trays say it.
 *
 * Taken from the freshest reading there is: every number in this menu is a reading
 * from some earlier moment, and a panel that never dates itself looks equally
 * current an hour later.
 */
const ages = known.map((one) => Math.min(...[one.fiveHour?.ageSeconds, one.sevenDay?.ageSeconds].filter((age): age is number => age !== undefined)));
const freshest = ages.filter((age) => Number.isFinite(age)).sort((a, b) => a - b)[0];
out.push(
  `refreshed\t${freshest === undefined ? sayRefreshed("never", "") : sayRefreshed(asClock(at - freshest, at, zone), `read ${asAgo(freshest)}`)}`,
);
out.push(`working\t${examination.working ? "yes" : "no"}`);
out.push(`window\t${examination.windowPid === null ? "closed" : "running"}`);
// Named here rather than in the shell, because which unit this tray belongs to is
// decided by the port this relay serves. `serviceNameFor` carries why.
out.push(`service\t${serviceNameFor(home.port)}`);

// Worth the most first, ties by name so the order never changes between reads.
const sorted = [...listed]
  .filter((seat) => seat.hasSendToken)
  .sort((a, b) => b.multiplier - a.multiplier || a.name.localeCompare(b.name));

for (const seat of sorted) {
  out.push(`seat\t${seat.name}\t${asMultiplier(seat.multiplier)}\t${roomBrief(heldFor(seat.name), at)}\t${seat.name === paying ? "yes" : "no"}`);
}

process.stdout.write(`${out.join("\n")}\n`);
