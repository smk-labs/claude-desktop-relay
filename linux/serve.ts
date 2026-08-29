/**
 * The relay, on Linux. This is the process that swaps the credential.
 *
 *   relay-linux serve [port]
 *
 * It is the macOS `scripts/serve.ts` with everything macOS-only taken out and
 * nothing put in: the same `src/relay`, the same Payer, the same Chooser, the same
 * verdict. That reuse is the point rather than a convenience. The relay module
 * carries the bound on how many exchanges may be in the air at once and the idle
 * bound on reused upstream connections, which are what stand between a Claude Code
 * loop and the collapse this hit on macOS in August; a Linux relay written fresh
 * would have had to learn that again.
 *
 * What is gone from it here: the page and its log pane, launchd, VPN and SOCKS
 * egress. Egress is direct, which is what this machine does.
 *
 * The tray is not gone, it is simply not this process: `linux/tray` draws it with
 * `yad` and reads what it needs for itself. Nor is the app's own encrypted store,
 * which `linux/internal/app-store-linux.ts` opens with Chromium's Linux scheme.
 */
import { startRelay, type Egress } from "../src/relay/index.ts";
import { ensureAuthority } from "../src/certificate/index.ts";
import { openSeatStore } from "../src/seats/index.ts";
import { openPayer, writeStanding } from "../src/payer/index.ts";
import { openUsageMemory } from "../src/usage/index.ts";
import { openJournal } from "../src/journal/index.ts";
import { openHistory } from "../src/history/index.ts";
import { describePick } from "../src/chooser/index.ts";
import { describeVerdict, watchExchanges } from "../src/verify/index.ts";
import { fileVault } from "./internal/file-vault.ts";
import { refreshStaleSeats, STALE_AFTER_SECONDS } from "../src/usage/index.ts";
import { linuxHome, vaultFile } from "./internal/where.ts";

const OPEN_HOST = "api.anthropic.com";
const home = linuxHome();
/** The first thing after this script's own name, whoever started it. */
const port = process.argv[2] === undefined ? home.port : Number(process.argv[2]);

const journal = openJournal({ file: home.logFile });
const say = (line: string) => {
  process.stdout.write(`${new Date().toTimeString().slice(0, 8)}  ${line}\n`);
  journal.say(line);
};
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const now = () => Math.trunc(Date.now() / 1000);

const seats = openSeatStore({ file: home.seatsFile, vault: fileVault(vaultFile(home)) });
const usage = openUsageMemory({ file: home.usageFile });
const history = openHistory({ file: home.historyFile });

const payer = openPayer({
  file: home.choiceFile,
  seats,
  usage,
  onProblem: say,
  onSwitch: (pick, recached) => {
    const conversations = recached === 1 ? "1 conversation" : `${recached} conversations`;
    say(`switched  ${describePick(pick)} In force now, ${conversations} re-cached.`);
    // Written where another process can read it: "what is paying right now" is
    // asked by the command a person types, which is not this process.
    void writeStanding(home.standingFile, payer.standing()).catch((error: unknown) =>
      say(`what is paying could not be written down: ${describeError(error)}`),
    );
  },
});

const authority = await ensureAuthority(home.certificateFolder, OPEN_HOST);

/**
 * How traffic leaves: straight out.
 *
 * Measured on this machine rather than assumed: no proxy is set in any case or
 * scheme in a login shell, and a plain `curl` to the upstream is answered. The
 * macOS side asks `scutil` every minute because a VPN there can come up after
 * login; there is nothing here to ask, and inventing a reader for a setting this
 * machine does not have would be a module with no behaviour to test.
 */
const egressNow = async (): Promise<Egress> => ({ kind: "direct" });

const judgeIt = watchExchanges({
  file: home.verdictFile,
  onVerdict: (verdict) => say(`${verdict.kind}: ${describeVerdict(verdict)}`),
  onProblem: say,
});

const relay = await startRelay({
  listen: { host: "127.0.0.1", port },
  openHost: OPEN_HOST,
  certificate: authority.leaf,
  egress: egressNow,
  chargeFor: (request) => payer.decide(request),
  whenRefused: (refused, request) => payer.insteadOf(refused, request),
  onExchange: (exchange) => {
    judgeIt(exchange);
    void usage.rememberExchange(exchange, now()).catch((error: unknown) => {
      say(`what ${exchange.chargedTo?.seat ?? "nobody"} has spent could not be remembered: ${describeError(error)}`);
    });
  },
  onExchangeFinished: (exchange, tokens) => {
    if (exchange.chargedTo === null) return;
    void history
      .keep({
        at: now(),
        seat: exchange.chargedTo.seat,
        organizationId: exchange.paidBy,
        model: exchange.about.model,
        status: exchange.status,
        refused: exchange.refused,
        tokens,
        utilization: exchange.utilization,
        project: null,
        session: exchange.about.session,
      })
      .catch((error: unknown) => say(`a history row could not be kept: ${describeError(error)}`));
  },
  onNotice: (notice) => say(`${notice.kind}: ${notice.summary}`),
});

/**
 * Keep what is known about the Seats current, rather than explaining that it is old.
 *
 * The figures only exist attached to a reply, so a Seat nobody is spending has no
 * news and every screen ends up carrying an apology in brackets instead of an
 * answer. This asks: one cheap request per stale Seat, folded in as the exchange
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
  //
  // Both timers are unreferenced, so a relay with nothing else to do still exits
  // when it is asked to. A referenced interval holds the loop open for a quarter
  // of an hour after the last socket closes, which reads as a hang.
  setTimeout(() => {
    void refreshRound();
    setInterval(() => void refreshRound(), REFRESH_EVERY_MINUTES * 60_000).unref();
  }, 30_000).unref();
}

const choice = await payer.now();
say(`relay listening on http://${relay.address.host}:${relay.address.port}`);
say(`serving the Claude Desktop in ${home.appSupport}`);
say(
  choice.mode === "auto"
    ? `Mode: auto. The best Seat is chosen at each conversation's first request.`
    : `Mode: ${choice.mode}, Payer: ${choice.payer ?? "the Window account"}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void relay
      .close()
      .then(() => journal.close())
      .then(() => process.exit(0));
  });
}
