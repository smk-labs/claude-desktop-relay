/**
 * Bring what is known up to date from the user's own Stats logins.
 *
 *   node scripts/relay.ts refresh
 *
 * Two things. A plan change is only ever seen this way, and it is rare: a Seat
 * quietly holding a stale Multiplier makes every comparison after it arithmetic on
 * the wrong number. And a Seat that is sitting idle has no reply to read, because a
 * Send token is inference-only and the allowance figures only ever arrive attached
 * to a real request. The relay asks the stale Seats itself every quarter hour now,
 * so that second one is a way to ask at once rather than the only way to ask.
 *
 * Its own process, and asked for rather than automatic, because it is one request
 * to claude.ai per Organization and it needs the Stats logins unlocked.
 */
import { relayHome, THE_USERS_DESKTOP_FOLDER } from "../src/home/index.ts";
import { machineVault, openSeatStore } from "../src/seats/index.ts";
import { readAccounts, WHERE_THE_STATS_LOGINS_ARE } from "../src/stats-login/index.ts";
import { bringUpToDate, changesBetween, describeChange, seatNameFor, seatsFrom } from "../src/worklist/index.ts";
import { openUsageMemory } from "../src/usage/index.ts";

const say = (line = "") => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`${line}\n`);

const home = relayHome();
const seats = openSeatStore({ file: home.seatsFile, vault: machineVault() });
const usage = openUsageMemory({ file: home.usageFile });
const folder = process.env["CLAUDE_RELAY_STATS_LOGINS"] ?? WHERE_THE_STATS_LOGINS_ARE;
const at = Math.trunc(Date.now() / 1000);

/**
 * The Windows on this machine are read as well, and they are the fresher copy.
 *
 * The backup folder is a snapshot taken once, so a login in it goes stale and the
 * Seat behind it reads "unknown" for ever. Measured 2026-08-24: `cy` read as
 * signed out from the snapshot while that very account sat signed in and current in
 * the Window the user works in, which is where its Cookies file had been rewritten
 * an hour earlier. A Claude Desktop folder holds the same three files a Stats login
 * needs, so it is simply read.
 *
 * Read only. Nothing here writes into a Window's folder, and a Window that holds no
 * login is reported as unread like any other rather than stopping the run.
 */
const alsoProfiles = [THE_USERS_DESKTOP_FOLDER, home.appSupport].filter(
  (one, which, all) => all.indexOf(one) === which,
);

say(`Reading your own Stats logins in ${folder}, and the Windows on this machine, and what each Seat has spent...`);
const read = await readAccounts({ folder, alsoProfiles, alsoKept: true, alsoWhatWasSpent: true });

for (const one of read.unread) complain(`  could not read the Stats login "${one.profile}": ${one.because}`);

/**
 * What each Seat has spent, folded in before anything else.
 *
 * Done for every Organization that answered, whether or not we hold a Send token
 * for it, because the memory is keyed by the Seat's name and that name is derived
 * from the account and the Organization rather than invented (ADR 0010). So a
 * reading taken today is still the right reading when the Seat is filled next
 * week.
 */
let learned = 0;
for (const account of read.accounts) {
  for (const organization of account.organizations) {
    if (organization.usage === null) continue;
    const name = seatNameFor(account.account, { id: organization.id, label: organization.label });
    await usage.rememberReading(name, organization.usage, at);
    learned += 1;
  }
}
say(`read what ${learned} Seats have spent. Type "relay seats" to see it.`);
say();

/**
 * What is no longer true about the Seats already held.
 *
 * Only the two safe changes are applied. A Seat that has vanished or was never
 * held is the user's decision: those two look identical from a login that could
 * not be read, and only one of them means the Seat is gone.
 */
const { wanted } = seatsFrom(read.accounts);
const changes = changesBetween({
  wanted,
  held: await seats.list(),
  accountsRead: read.accounts.map((one) => one.account),
});

if (changes.length === 0) {
  say(`Nothing has changed about the Seats themselves.`);
} else {
  for (const change of changes) {
    const now = bringUpToDate(change);
    if (now === null) {
      say(`  left alone: ${describeChange(change)}`);
      continue;
    }
    await seats.update(now);
    say(`  brought up to date: ${describeChange(change)}`);
  }
}
