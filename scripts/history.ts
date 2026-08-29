/**
 * What every Seat has spent, and which project it went on.
 *
 *   relay history                    the last week, per Seat
 *   relay history --day              the last day
 *   relay history --month            the last thirty days
 *   relay history --projects         per project instead of per Seat
 *   relay history --projects --seats per project crossed with Seat
 *   relay history --tidy             name any project still unknown, and fold old rows
 *
 * Costs are what the work would have cost at API rates, and never what you paid: a
 * subscription is not per-token. The rates carry the month they were published.
 *
 * Its own process because naming a project means listing directories, and nothing
 * that reads a directory belongs on the request path.
 */
import { relayHome } from "../src/home/index.ts";
import {
  openHistory,
  openProjects,
  PUBLISHED,
  shortNameFor,
  type Period,
  type Total,
} from "../src/history/index.ts";

const say = (line = "") => process.stdout.write(`${line}\n`);
const flag = (name: string) => process.argv.includes(name);

const home = relayHome();
const history = openHistory({ file: home.historyFile });
const at = Math.trunc(Date.now() / 1000);

const period: Period = flag("--day") ? "day" : flag("--month") ? "month" : "week";
const called = { day: "the last day", week: "the last week", month: "the last thirty days" }[period];

if (flag("--tidy")) {
  /**
   * The two things that are worth doing on a timer and are done by hand instead.
   *
   * Naming a project reads 118 directories and folding rewrites the record, and
   * neither belongs anywhere near a request. Run it whenever; both are idempotent.
   */
  const named = await history.nameProjects((session) => openProjects().of(session));
  say(`named the project of ${named} row${named === 1 ? "" : "s"}`);

  const folded = await history.fold(at);
  say(
    folded.replaced === 0
      ? `nothing is old enough to fold into daily totals yet`
      : `folded ${folded.replaced} rows into ${folded.with} daily totals`,
  );
  process.exit(0);
}

const totals = flag("--projects")
  ? flag("--seats")
    ? await history.perProjectAndSeat(period, at)
    : await history.perProject(period, at)
  : await history.perSeat(period, at);

if (totals.length === 0) {
  say(`Nothing was spent in ${called}.`);
  say();
  say(`  relay history --month     look further back`);
  say(`  relay history --tidy      name any project still unknown`);
  process.exit(0);
}

/** Big numbers, made readable, because a row of nine digits is not a figure. */
const round = (tokens: number) =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;

const shown = (total: Total) => (flag("--projects") ? shortNameFor(total.of) : total.of);
const widest = Math.max(...totals.map((total) => shown(total).length), 4);
const pad = (text: string, width: number) => text.padEnd(width);

say(`What was spent in ${called}, ${flag("--projects") ? "per project" : "per Seat"}:`);
say();
say(
  `  ${pad("", widest)}  ${pad("calls", 7)}  ${pad("refused", 8)}  ${pad("in", 8)}  ${pad("out", 8)}  ${pad("cache", 8)}  at API rates`,
);

for (const total of totals) {
  const cost =
    total.wouldHaveCost === null
      ? "not priced"
      : `$${total.wouldHaveCost.toFixed(2)}${total.unpriced > 0 ? ` (+${total.unpriced} unpriced)` : ""}`;
  say(
    `  ${pad(shown(total), widest)}  ${pad(String(total.exchanges), 7)}  ${pad(String(total.refusals), 8)}  ` +
      `${pad(round(total.input), 8)}  ${pad(round(total.output), 8)}  ${pad(round(total.cacheWritten + total.cacheRead), 8)}  ${cost}`,
  );
}

say();
say(`"At API rates" is what this work would have cost through the API, at the rates`);
say(`published ${PUBLISHED.on}. It is not what you paid: a subscription is not per-token.`);
