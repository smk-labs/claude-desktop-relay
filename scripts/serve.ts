/**
 * The relay itself. This is what the service runs, and what `relay serve` starts
 * by hand in a terminal.
 *
 *   relay serve [port]
 *
 * It listens on a fixed port, because the app's store names that address and is
 * read once. It writes nothing to the store: putting the address into the app is
 * `relay install`, and this only answers there. The one thing it does start is a
 * Claude Desktop profile, when somebody clicks Open on the page, and that starts
 * a Window rather than changing anything about how one is set up.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { relayHome } from "../src/home/index.ts";
import { ensureAuthority } from "../src/certificate/index.ts";
import { startRelay } from "../src/relay/index.ts";
import { machineVault, openSeatStore } from "../src/seats/index.ts";
import { openPayer, writeStanding } from "../src/payer/index.ts";
import { openUsageMemory, refreshStaleSeats, STALE_AFTER_SECONDS } from "../src/usage/index.ts";
import { describePick } from "../src/chooser/index.ts";
import { openJournal } from "../src/journal/index.ts";
import { openHistory } from "../src/history/index.ts";
import { describeVerdict, watchExchanges } from "../src/verify/index.ts";
import { machineEgress } from "../src/window/index.ts";
import { openLogPane, pageHandler, RELAYING_ROW } from "../src/page/index.ts";
import { openProfile, openProfiles } from "../src/profiles/index.ts";
import { readChoice, writeChoice, readStanding, pickPayer } from "../src/payer/index.ts";
import { latestBackup } from "../src/backup/index.ts";
import { openVerdictLog } from "../src/verify/index.ts";
import { thisMachine } from "../src/control/index.ts";
import type { Egress } from "../src/relay/index.ts";

const OPEN_HOST = "api.anthropic.com";
const home = relayHome();
/** Home-relative, because `~/...` is how a person says where a folder is. */
function shorten(path: string): string {
  const home = process.env["HOME"] ?? "";
  return home !== "" && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Every Claude Desktop profile on this machine, held for half a minute.
 *
 * ADR 0012 makes a profile a Desktop folder, and there are several: the page has to
 * say which one is relayed, because a screen that says only "Claude Desktop is
 * running" cannot tell you which of them it means, and the whole point of the split
 * is that one of them is untouched. Whether a profile is relayed comes out of that
 * profile's own store, which needs the Keychain, so it is read at most every half
 * minute rather than on every page refresh.
 */
const profiles = openProfiles({ port: home.port });

/**
 * The port is part of which Window this serves, not an argument to it.
 *
 * An argument is still honoured, because `relay serve <port>` is how a second one
 * is tried by hand, but the environment is the answer the service is given and
 * the two must not disagree quietly. ADR 0012.
 */
const port = process.argv[2] === undefined ? home.port : Number(process.argv[2]);

/**
 * Said twice on purpose, and to two different places.
 *
 * The terminal is for whoever started this by hand with `relay serve`; the
 * journal is the only place a service has to say anything, and it is the one that
 * is bounded. Neither can be dropped in favour of the other: launchd holds the
 * terminal's file open, which is exactly what cannot be rotated.
 */
const journal = openJournal({ file: home.logFile });
/**
 * The pane the page shows, in memory and bounded, beside the journal on disk.
 * Every line the relay says reaches both: the journal is the record, the pane is
 * what somebody watching the page is watching.
 */
const pane = openLogPane();
const now = () => Math.trunc(Date.now() / 1000);
/** `verb  the rest`, which is the shape everything here already says. */
const paneLine = (line: string, exchange = false) => {
  const [verb, ...rest] = line.split(/\s{2,}|:\s/);
  const said = { at: now(), event: (verb ?? "").trim(), text: rest.join(" ").trim() || (verb ?? "") };
  if (exchange) pane.exchange(said.at, said.event, said.text);
  else pane.say(said.at, said.event, said.text);
};
const say = (line: string) => {
  process.stdout.write(`${new Date().toTimeString().slice(0, 8)}  ${line}\n`);
  journal.say(line);
  paneLine(line);
};
const seats = openSeatStore({ file: home.seatsFile, vault: machineVault() });
const usage = openUsageMemory({ file: home.usageFile });
const history = openHistory({ file: home.historyFile });
const payer = openPayer({
  file: home.choiceFile,
  seats,
  usage,
  onProblem: say,
  /**
   * Said once per change, after the fact.
   *
   * A switch is in force the moment it is made, including inside conversations
   * already running, so what is worth saying is what it cost: those conversations
   * are re-sent uncached to the new Organization. Stated here, never gated.
   */
  onSwitch: (pick, recached) => {
    const conversations = recached === 1 ? "1 conversation" : `${recached} conversations`;
    say(`switched  ${describePick(pick)} In force now, ${conversations} re-cached.`);
    // Put where another process can read it, because "what is paying right now"
    // is asked by the command a person types and by the page, not by the relay.
    void writeStanding(home.standingFile, payer.standing()).catch((error: unknown) =>
      say(`what is paying could not be written down: ${describeError(error)}`),
    );
  },
});
const authority = await ensureAuthority(home.certificateFolder, OPEN_HOST);

/**
 * How traffic leaves, asked again every minute rather than once.
 *
 * A VPN that comes up after login has to be honoured, and reading the setting
 * once means every request after that goes round it without saying so. A minute
 * is short enough to matter and long enough not to spawn `scutil` per request.
 *
 * The answer is one of four, never a bare address, because "the machine names a
 * way out we cannot use" has to be told apart from "the machine names none".
 * Direct, an HTTP proxy, a SOCKS proxy, or a refusal.
 * Going direct on the first of those is a bypass of the user's own tunnel.
 * ADR 0011.
 */
let known: Egress | null = null;
let readAt = 0;

/**
 * Forget what we last read, so the next request asks the machine again.
 *
 * Called the moment a dial through the proxy fails. Without it, a VPN that comes
 * back keeps being ignored for up to a minute, and a VPN that goes away keeps
 * being dialled for up to a minute. Both make the order of "toggle the VPN" and
 * "use the app" matter, and it should not: the relay is meant to be the thing
 * you never have to sequence around.
 */
function readItAgain(): void {
  known = null;
}

async function egressNow(): Promise<Egress> {
  if (known === null || Date.now() - readAt > 60_000) {
    known = await machineEgress();
    readAt = Date.now();
  }
  return known;
}

const judgeIt = watchExchanges({
  file: home.verdictFile,
  onVerdict: (verdict) => say(`${verdict.kind}: ${describeVerdict(verdict)}`),
  onProblem: say,
});

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The machine, for the page's own account of itself.
 *
 * It hands nothing off: a page must not be able to start an interactive sitting
 * in a service's process, so the one capability that would allow it is refused
 * here rather than guarded downstream.
 */
const machine = thisMachine({
  home,
  repo: join(dirname(fileURLToPath(import.meta.url)), ".."),
  node: process.execPath,
  handOff: async () => {
    throw new Error("the relay does not run the long flows; they need a terminal");
  },
});

/**
 * Everything the page shows, gathered when it is asked for.
 *
 * The figures are not cached: the page asks every few seconds and every one of
 * them is about right now. Each read is a handful of small files this process
 * already owns, so the cheapest correct thing is to read them.
 *
 * Two things are cached, and only because they cost more than a file read. The
 * profile list is held for half a minute, as the comment above it says, and the
 * account a profile is signed in as is held for half an hour. Both go through the
 * Keychain, and neither answer changes at the pace the page refreshes.
 */
const source = {
  read: async ({ every, period }: { every: boolean; period: "day" | "week" | "month" }) => {
    const at = now();
    const [choice, listed, known, verdict, examination, windowRunning, backup, standing, rows, found] = await Promise.all([
      readChoice(home.choiceFile),
      seats.list(),
      usage.known(at),
      openVerdictLog({ file: home.verdictFile }).last(),
      machine.examine(),
      machine.windowRunning(),
      latestBackup().catch(() => null),
      readStanding(home.standingFile, at).catch(() => null),
      history.since(at - 45 * 24 * 3600).catch(() => []),
      profiles.list(at).catch(() => []),
    ]);

    return {
      choice,
      seats: listed,
      usage: known,
      verdict,
      standing,
      examination,
      windowRunning,
      // What the Window is signed in as is Claude Desktop's business, and reading
      // it would mean opening its login. The masthead says what it can prove.
      windowAccount: null,
      backedUpOn: backup?.on ?? null,
      history: rows,
      perProjectAndSeat: await history.perProjectAndSeat(period, at).catch(() => []),
      period,
      log: pane.lines({ every }),
      statsLogins: null,
      profiles: found,
      machine: [
        { key: "Relay", value: `listening on 127.0.0.1:${port}` },
        {
          key: "Service",
          value: examination.service.installed
            ? examination.service.running
              ? `launchd agent, running as ${examination.service.pid}`
              : "launchd agent, installed but not running"
            : "not installed as a service",
        },
        { key: "Claude Desktop", value: windowRunning ? "running" : "not running" },
        { key: RELAYING_ROW, value: `${shorten(home.appSupport)} · every Code session in it` },
        { key: "Profiles", value: `${found.length} Claude Desktop profiles on this machine` },
        { key: "History", value: `${rows.length} rows over the last 45 days` },
      ],
      readAt: at,
      port,
      at,
    };
  },
  /** The same call `relay use` makes, and it sets Manual for the same reason. */
  use: async (seat: string) => {
    await pickPayer({ file: home.choiceFile, among: await seats.list(), name: seat });
    say(`switched  ${seat}, picked from the page, in force now.`);
  },
  /**
   * Open a profile by the name the page and the menu show.
   *
   * Opening only, and it says which folder it opened rather than only that it did:
   * "opened Main" is not checkable, and which Desktop folder started is the one
   * fact that settles which Claude Desktop is now in front of the user.
   */
  open: async (name: string) => {
    const wanted = (await profiles.list(now())).find((one) => one.name === name);
    if (wanted === undefined) {
      say(`no profile is called ${name} on this machine, so nothing was opened.`);
      return;
    }
    const done = await openProfile(wanted.folder);
    say(`profile  ${done.saying}`);
  },
  mode: async (mode: "auto" | "manual" | "off") => {
    const choice = await readChoice(home.choiceFile);
    await writeChoice(home.choiceFile, { mode, payer: choice.payer });
    say(`switched  Mode is ${mode}, chosen from the page, in force now.`);
  },
};

const relay = await startRelay({
  listen: { host: "127.0.0.1", port },
  onPlainRequest: pageHandler(source),
  openHost: OPEN_HOST,
  certificate: authority.leaf,
  egress: egressNow,
  chargeFor: (request) => payer.decide(request),
  whenRefused: (refused, request) => payer.insteadOf(refused, request),
  onExchange: (exchange) => {
    judgeIt(exchange);
    // Never awaited and never able to take the relay down: what is known about an
    // allowance is worth less than the request it was learned from.
    void usage.rememberExchange(exchange, Math.trunc(Date.now() / 1000)).catch((error: unknown) => {
      say(`what ${exchange.chargedTo?.seat ?? "nobody"} has spent could not be remembered: ${describeError(error)}`);
    });
  },
  onExchangeFinished: (exchange, tokens) => {
    // Behind the toggle, never in the default log: one line per exchange is
    // debugging, and debugging is not the daily path.
    pane.exchange(
      now(),
      exchange.refused ? "refused" : "exchange",
      `${exchange.chargedTo?.seat ?? "the Window account"}, ${exchange.about.model ?? "no model named"}, ${exchange.status}`,
    );
    // Only what a Seat actually paid for. An exchange nobody was charged for is
    // the Window account's own spending and not ours to keep a record of.
    if (exchange.chargedTo === null) return;
    void history
      .keep({
        at: Math.trunc(Date.now() / 1000),
        seat: exchange.chargedTo.seat,
        organizationId: exchange.paidBy,
        model: exchange.about.model,
        status: exchange.status,
        refused: exchange.refused,
        tokens,
        utilization: exchange.utilization,
        // Named later, because resolving a project means reading a directory and
        // nothing is allowed to delay a request. The session id is the link.
        project: null,
        session: exchange.about.session,
      })
      .catch((error: unknown) => say(`a history row could not be kept: ${describeError(error)}`));
  },
  onNotice: (notice) => {
    // A proxy that would not answer is the one piece of news that makes our
    // cached reading worthless, so it is thrown away rather than waited out.
    if (notice.kind === "machine-proxy-unreachable") readItAgain();
    say(`${notice.kind}: ${notice.summary}`);
  },
});

/**
 * Keep what is known about the Seats current, rather than explaining that it is old.
 *
 * The figures only exist attached to a reply, so a Seat nobody is spending has no
 * news, and the menu bar ends up carrying an apology in brackets where an answer
 * belongs. This asks: one cheap request per stale Seat, folded in as the exchange
 * it is. What it costs is written down in `src/usage/internal/refresh.ts`.
 *
 * Set `RELAY_REFRESH_MINUTES=0` to switch it off; then the numbers are whatever
 * live traffic last taught, and the screens say how old that is.
 */
const REFRESH_EVERY_MINUTES = Number(process.env["RELAY_REFRESH_MINUTES"] ?? 15);

async function refreshRound(): Promise<void> {
  const summary = await refreshStaleSeats({
    seats,
    usage,
    at: now(),
    olderThan: STALE_AFTER_SECONDS,
    say,
  }).catch((error: unknown) => {
    say(`what the Seats have spent could not be brought up to date: ${describeError(error)}`);
    return null;
  });

  // Said only when there was something to do. A line every quarter of an hour
  // saying nothing happened is a log nobody reads, and then the line that matters
  // is not read either.
  if (summary !== null && summary.asked > 0) {
    say(
      `refreshed  ${summary.answered} of ${summary.asked} Seats answered` +
        `${summary.failed === 0 ? "" : `, ${summary.failed} could not be reached`}` +
        `, ${summary.skipped} were already current`,
    );
  }
}

if (Number.isFinite(REFRESH_EVERY_MINUTES) && REFRESH_EVERY_MINUTES > 0) {
  // The first round is delayed: the relay has just started, something may be
  // waiting on it, and one request per stale Seat is not what it should be doing
  // in its first second.
  setTimeout(() => {
    void refreshRound();
    setInterval(() => void refreshRound(), REFRESH_EVERY_MINUTES * 60_000).unref();
  }, 30_000).unref();
}

const choice = await payer.now();
say(`relay listening on http://${relay.address.host}:${relay.address.port}`);
say(
  choice.mode === "auto"
    ? `Mode: auto. The best Seat is chosen at each conversation's first request.`
    : `Mode: ${choice.mode}, Payer: ${choice.payer ?? "the Window account"}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // The journal is settled before leaving, so the last thing the relay said
    // about why it is going is on disk rather than in a buffer.
    void relay
      .close()
      .then(() => journal.close())
      .then(() => process.exit(0));
  });
}
