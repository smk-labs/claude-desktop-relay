/**
 * Prove the whole chain against the real server, with the server's own answer as
 * the evidence.
 *
 *   relay check
 *
 * Not part of `npm test`: this one reaches the network and spends a little of the
 * chosen Seat's allowance. Run it by hand.
 *
 * The trick that makes it proof rather than a demonstration: the Code session is
 * handed a Send token that is deliberately invalid. If the session works, the only
 * thing that can have made it work is the relay putting the chosen Seat's token on
 * the request. The server then names the Organization that paid, and that is
 * compared with the Seat that was picked.
 *
 * It starts nothing you have to clean up, and it never touches a running Window.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

import { ensureAuthority } from "../src/certificate/index.ts";
import { ON_WINDOWS, relayHome } from "../src/home/index.ts";
import { isOff, openPayer } from "../src/payer/index.ts";
import { startRelay } from "../src/relay/index.ts";
import { machineVault, openSeatStore } from "../src/seats/index.ts";
import { machineProxy, proxyVariables } from "../src/window/index.ts";
import { describeVerdict, watchExchanges, type Verdict } from "../src/verify/index.ts";

const OPEN_HOST = "api.anthropic.com";
const NOT_A_REAL_TOKEN = "sk-ant-oat01-deliberately-invalid-so-only-the-swap-can-work";

const say = (line: string) => process.stdout.write(`${line}\n`);

/**
 * The `claude` command, by a path rather than by a name.
 *
 * On macOS the name on `PATH` is the program. On Windows there are two things on
 * `PATH` under that name and only one of them can be started: `claude.exe` is a
 * program, and `claude.cmd` is a batch file that Node refuses outright with
 * `EINVAL` unless it is run through a shell. Running it through a shell would put
 * the environment below through that shell's own rules, which is exactly what the
 * bare environment exists to avoid.
 *
 * So the executable is looked for by itself, everywhere on `PATH`, before
 * anything else is considered, and the copy Claude Desktop keeps beside its own
 * profile is the fallback.
 */
function whereClaudeIs(): string {
  if (!ON_WINDOWS) return "claude";

  for (const where of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(where, "claude.exe");
    if (where !== "" && existsSync(candidate)) return candidate;
  }

  const beside = join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude-code");
  const versions = (() => {
    try {
      return readdirSync(beside).sort();
    } catch {
      return [];
    }
  })();
  for (const version of versions.reverse()) {
    const candidate = join(beside, version, "claude.exe");
    if (existsSync(candidate)) return candidate;
  }

  return "claude";
}

/**
 * The little a Code session needs from this machine, and nothing else.
 *
 * A bare environment on purpose: a Code session started from a Code session
 * inherits a dozen variables that confuse it, and none of them belong here. The
 * two machines need different names for the same three things — where the program
 * is, where the user's own home is, and somewhere to write scratch files — so
 * both lists are here rather than one list that happens to work on one of them.
 */
function theBareMinimum(): Record<string, string> {
  const named = ON_WINDOWS
    ? ["PATH", "SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "USERNAME"]
    : ["PATH"];

  const env: Record<string, string> = { HOME: homedir(), TERM: "dumb" };
  for (const name of named) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (env["PATH"] === undefined) env["PATH"] = ON_WINDOWS ? "" : "/usr/bin:/bin";
  return env;
}

const home = relayHome();
const seats = openSeatStore({ file: home.seatsFile, vault: machineVault() });
const payer = openPayer({ file: home.choiceFile, seats });

const choice = await payer.now();
if (isOff(choice)) {
  say(`Off, or no Payer picked. Run "relay use <seat>" first: there is nothing to prove yet.`);
  process.exit(1);
}

const authority = await ensureAuthority(home.certificateFolder, OPEN_HOST);
const verdicts: Verdict[] = [];

const relay = await startRelay({
  openHost: OPEN_HOST,
  certificate: authority.leaf,
  machineProxy: await machineProxy(),
  chargeFor: (request) => payer.decide(request),
  // The same watcher the start command uses, so what this proves is also what
  // `relay verdict` reads afterwards. A check that proved something and
  // left no record would disagree with the app a moment later.
  onExchange: watchExchanges({
    file: home.verdictFile,
    onVerdict: (verdict) => {
      if (verdict.path.startsWith("/v1/messages")) verdicts.push(verdict);
    },
    onProblem: (summary) => say(summary),
  }),
  onNotice: (notice) => say(`${notice.kind}: ${notice.summary}`),
});

/**
 * In Auto there is no Payer until a request arrives, so `choice.payer` is null and
 * printing it read as `Payer "null"`. The Seat that actually paid is in the
 * verdict, which is the honest place to read it from anyway: it is what the server
 * said rather than what was intended.
 */
const asked = choice.payer ?? `${choice.mode}, so the Seat is chosen per request`;
say(`relay on http://${relay.address.host}:${relay.address.port}, Payer ${choice.payer === null ? asked : `"${asked}"`}`);
say("running one Code session through it, with a Send token that cannot work...");

/**
 * The session gets a ceiling, because a wait without one is the failure this
 * repository has already paid for twice.
 *
 * Measured on this machine: a tool-free `claude -p` answers in about five seconds
 * through the relay. Two minutes is not a performance limit, it is the line
 * between "busy" and "not coming back", and hitting it is reported as a failure
 * rather than waited out. The whole process group is killed, because a killed
 * `claude` leaves its own children behind.
 */
const AT_MOST_MS = 120_000;

const said = await new Promise<string>((resolve) => {
  const child = spawn(whereClaudeIs(), ["-p", "Reply with exactly: relay proof ok"], {
    cwd: homedir(),
    // Its own group on macOS, so the whole group can be ended at the ceiling
    // below. Windows has no process groups to detach into and would only put a
    // console window on the screen, so it is not asked for there.
    detached: !ON_WINDOWS,
    env: {
      ...theBareMinimum(),
      ...proxyVariables(relay.address),
      NODE_EXTRA_CA_CERTS: authority.caCertificatePath,
      NODE_USE_SYSTEM_CA: "1",
      CLAUDE_CODE_OAUTH_TOKEN: NOT_A_REAL_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));

  const clock = setTimeout(() => {
    try {
      // The whole group where there is one, because a killed `claude` leaves its
      // own children behind. Windows has no group to signal, so the process it
      // started is what can be ended, and its children go with the console.
      if (child.pid !== undefined) {
        if (ON_WINDOWS) child.kill();
        else process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      // Already gone, which is the outcome this wanted anyway.
    }
    resolve(`TIMED OUT: no answer in ${AT_MOST_MS / 1000}s, so the session was killed`);
  }, AT_MOST_MS);

  child.on("error", (error) => {
    clearTimeout(clock);
    resolve(`could not run claude: ${error.message}`);
  });
  child.on("close", () => {
    clearTimeout(clock);
    resolve(out.trim());
  });
});

await relay.close();

say("");
say(`the session said: ${said.split("\n")[0] ?? "(nothing)"}`);
say("");

if (verdicts.length === 0) {
  say("no request reached the message endpoint, so nothing was proved either way.");
  process.exit(1);
}

let worst = 0;
for (const verdict of verdicts) {
  say(`${verdict.kind}: ${describeVerdict(verdict)}`);
  if (verdict.kind !== "verified") worst = 1;
}

say("");
say(
  worst === 0
    ? `proved. The Code session could only have worked because the relay charged ` +
        `"${verdicts[verdicts.length - 1]?.seat ?? choice.payer}", and the server named that ` +
        `Seat's own Organization as the one that paid.`
    : "not proved. Read the verdicts above.",
);
process.exit(worst);
