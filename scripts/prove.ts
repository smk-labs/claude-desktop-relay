/**
 * Prove which paths the relay actually covers, on a real Claude Desktop, without
 * going anywhere near the Window the user works in.
 *
 *   relay prove                       what is set up, and what to do next
 *   relay prove --set-up              make the Proving Window and its own relay
 *   relay prove --open                open it again
 *   relay prove --start <path>        note the moment, and say exactly what to type
 *   relay prove --finish <path> --worked
 *   relay prove --finish <path> --failed
 *   relay prove --not-applicable <path> "why"
 *   relay prove --matrix              write docs/coverage-matrix.md from the record
 *   relay prove --tear-down           remove the Proving Window and its relay
 *
 * The Proving Window is a second Claude Desktop with its own Desktop folder, its
 * own login, its own relay on its own port, and its own Payer (ADR 0012). It may
 * be opened and closed freely. The Window the user works in may not, and nothing
 * here touches it: every command refuses outright if it finds itself pointed at
 * the user's own Desktop folder.
 *
 * The negative control is the whole method. The Proving Window's own store carries
 * a Send token that cannot buy anything, so any request that goes round the relay
 * gets a 401 and any work that completes is proof the relay carried it. Counting
 * requests cannot prove this: a request that went direct is simply absent, and an
 * absence looks exactly like work that never happened.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  APP_SUPPORT_VARIABLE,
  PROVING_WINDOW,
  RELAY_PORT,
  THE_USERS_DESKTOP_FOLDER,
  relayHome,
} from "../src/home/index.ts";
import { readJsonFile, writeJsonFile } from "../src/json-file/index.ts";
import { asTable, judgePath, knownLimits, PATHS, type Record_, type Row } from "../src/coverage/index.ts";
import { environmentStoreFile, openAppStore, certificateVariables } from "../src/app-store/index.ts";
import {
  CLAUDE_DESKTOP,
  proxyVariables,
  launchWindow,
  windowExecutable,
  isWindowRunningOn,
  closeWindowOn,
} from "../src/window/index.ts";
import { ensureAuthority } from "../src/certificate/index.ts";
import { readChoice } from "../src/payer/index.ts";
import { loginIn } from "../src/stats-login/index.ts";
import { asFromTheDock, loginPath } from "../src/profiles/index.ts";
import { keptBeside } from "../src/journal/index.ts";

const say = (line = "") => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`${line}\n`);
const leave = (code: number) => process.exit(code);

/**
 * The credential the Proving Window is given, which cannot buy anything.
 *
 * This is the negative control. It is written into the Proving Window's own store
 * so that every Code session in it inherits it, and it is the reason a path that
 * completes its work is proved rather than merely observed.
 */
const CANNOT_BUY_ANYTHING = "sk-ant-oat01-deliberately-invalid-so-only-the-relay-can-work";
const THE_CONTROL = "CLAUDE_CODE_OAUTH_TOKEN";
const OPEN_HOST = "api.anthropic.com";

/**
 * The one guard that matters here.
 *
 * Writing a credential that cannot buy anything into the store of the Window
 * somebody is working in would break every Code session in it the moment the relay
 * was not up. Refused, always, whatever was asked for.
 */
if (PROVING_WINDOW.appSupport === THE_USERS_DESKTOP_FOLDER || PROVING_WINDOW.port === RELAY_PORT) {
  complain(`the Proving Window is not distinct from the Window you work in. Refusing to touch anything.`);
  leave(1);
}
if ((process.env[APP_SUPPORT_VARIABLE] ?? PROVING_WINDOW.appSupport) === THE_USERS_DESKTOP_FOLDER) {
  complain(`${APP_SUPPORT_VARIABLE} names the Window you work in. Refusing: this command arms a broken credential.`);
  leave(1);
}

const home = relayHome(PROVING_WINDOW);
const address = { host: "127.0.0.1", port: PROVING_WINDOW.port };
const recordFile = join(PROVING_WINDOW.folder, "coverage.json");
const startedFile = join(PROVING_WINDOW.folder, "started.json");
const matrixFile = join(process.cwd(), "docs", "coverage-matrix.md");

/**
 * The Proving Window's relay runs from its own checkout, not from this one.
 *
 * Editing the tree a running service runs from is how a relay gets its request
 * path changed underneath it, and on 2026-08-22 that happened and was harmless
 * only because the service never restarted. That was luck. So the service is
 * pointed at a clone of this repository at its committed HEAD, which also means
 * what is being proved is committed code rather than whatever is in the editor.
 */
const checkout = join(PROVING_WINDOW.folder, "checkout");

async function ran(command: string, args: readonly string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ code: -1, out: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

/** A fresh clone at HEAD, so the service never runs a file anybody is editing. */
async function freshCheckout(): Promise<void> {
  const dirty = await ran("git", ["-C", process.cwd(), "status", "--porcelain"]);
  if (dirty.out.trim() !== "") {
    say(`note: this checkout has uncommitted changes, and the service will not see them.`);
    say(`      commit first if what you are proving is not yet committed.`);
  }

  await rm(checkout, { recursive: true, force: true });
  const cloned = await ran("git", ["clone", "--quiet", "--local", process.cwd(), checkout]);
  if (cloned.code !== 0) throw new Error(`could not clone this repository into ${checkout}: ${cloned.out}`);

  const at = await ran("git", ["-C", checkout, "rev-parse", "--short", "HEAD"]);
  say(`the Proving Window's relay will run from ${checkout}, at ${at.out.trim()}`);
}

/**
 * What carries a login, and nothing else.
 *
 * The live Desktop folder is fourteen gigabytes, nearly all of it caches, Code
 * sessions and a virtual machine disk. What actually makes a Claude Desktop signed
 * in is a few small things, and copying only those is the difference between a
 * clone that takes a second and one that takes a quarter of an hour and fills the
 * disk.
 *
 * It works at all because of where the lock lives: the cookie store is encrypted
 * with a key from one Keychain entry that belongs to the application rather than to
 * a profile, so a cookie store copied into a second folder decrypts there. That is
 * measured, not assumed: `relay prove --copy-login` reads the session back out of
 * the copy with the same code `src/stats-login` uses, and refuses if it cannot.
 */
const WHAT_CARRIES_A_LOGIN = [
  // The claude.ai session itself.
  "Cookies",
  "Cookies-journal",
  // Chromium's own profile state.
  "Local State",
  "Preferences",
  // The app's device identity. Without these the clone looks like a new device and
  // is likely to ask to sign in anyway, which is the whole thing being avoided.
  "ant-did",
  "ant-device-registry.json",
  // Where the app keeps the signed-in account.
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "WebStorage",
  // A partitioned cookie jar, if the app uses one.
  "Partitions",
];

/**
 * What is deliberately left behind, and why each one.
 *
 * Written down because the temptation is to copy the whole folder, and every entry
 * here is a reason not to.
 */
const LEFT_BEHIND = [
  "claude-code-sessions", // 1.4 GB of somebody's actual work
  "claude-code-vm", // 1.5 GB of virtual machine disk
  "claude-code", // 302 MB of the CLI's own state
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache", // caches, all rebuilt on demand
  "config.json",
  "claude_desktop_config.json", // MCP servers, which carry credentials of their own
  "ca-bundle.pem", // the app computes its own; ours arrives through the store (ADR 0006)
];

const store = () =>
  openAppStore(PROVING_WINDOW.appSupport);

const flag = (name: string) => process.argv.includes(name);

/**
 * Keep asking until it is true, or give up. Every wait here has a ceiling.
 *
 * Ten seconds, because an app closing itself writes its state out and that is
 * measured in a second or two, never in a minute. Giving up is reported rather
 * than waited through.
 */
async function untilItIsTrue(yet: () => Promise<boolean>, atMostMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + atMostMs;
  for (;;) {
    if (await yet()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
const after = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

async function record(): Promise<Record_> {
  return (await readJsonFile<Record_>(recordFile)) ?? { rows: [], negativeControl: false };
}

async function keep(next: Record_): Promise<void> {
  await writeJsonFile(recordFile, next);
}

/** Replace a row of the same key, so a path can be measured again after an update. */
const withRow = (held: Record_, row: Row): Record_ => ({
  ...held,
  rows: [...held.rows.filter((one) => one.key !== row.key), row],
});

function pathNamed(key: string | undefined) {
  const path = PATHS.find((one) => one.key === key);
  if (path === undefined) {
    complain(`there is no path called "${key ?? ""}". There is:  ${PATHS.map((one) => one.key).join(", ")}`);
    leave(1);
  }
  return path!;
}

/** Whether the negative control is actually in that Window's store, read back. */
async function controlIsArmed(): Promise<boolean> {
  const held = await store().read().catch(() => ({}) as Record<string, string>);
  return held[THE_CONTROL] === CANNOT_BUY_ANYTHING;
}

/** The versions this was measured against, for the row. Read, never assumed. */
async function versions(): Promise<string> {
  const app = await readFile("/Applications/Claude.app/Contents/Info.plist", "utf8")
    .then((text) => /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? "unknown")
    .catch(() => "unknown");
  return `Claude Desktop ${app}`;
}

/**
 * What the relay said between two moments, read out of its own log.
 *
 * The log rather than a counter, because the log is what a person reads afterwards
 * and a second record that could disagree with it is worth less than none. Both
 * generations are read, since a busy run can rotate one.
 */
async function whatTheRelaySaw(since: string, until: string): Promise<Row["saw"]> {
  const text = (
    await Promise.all([home.logFile, keptBeside(home.logFile)].map((file) => readFile(file, "utf8").catch(() => "")))
  ).join("");

  const saw = { verified: 0, mismatch: 0, unverified: 0 };
  for (const line of text.split("\n")) {
    const stamp = line.slice(0, 24);
    if (stamp < since || stamp > until) continue;
    if (/ {2}verified: /.test(line)) saw.verified += 1;
    else if (/ {2}mismatch: /.test(line)) saw.mismatch += 1;
    else if (/ {2}unverified: /.test(line)) saw.unverified += 1;
  }
  return saw;
}

// ---- what to do -------------------------------------------------------------

if (flag("--tear-down")) {
  say(`Removing the Proving Window and its relay. The Window you work in is untouched.`);
  const { thisMachine } = await import("../src/control/index.ts");
  const machine = thisMachine({ home, repo: checkout, node: process.execPath, handOff: async () => 0 });
  /**
   * This cannot touch a Send token, and that is now true of the call itself rather
   * than of the argument passed to it.
   *
   * A Proving Window borrows the Seats rather than owning them. On 2026-08-22 this
   * line forgot everything under our service name and took every one of the
   * user's Send tokens, which are an hour of interactive sign-ins and cannot be
   * rebuilt from this repository. The capability is gone from `Machine` entirely.
   */
  await machine.uninstall(say);
  await rm(PROVING_WINDOW.folder, { recursive: true, force: true });
  say(`Done. Nothing of the Proving Window is left.`);
  leave(0);
}

if (flag("--set-up")) {
  await mkdir(PROVING_WINDOW.appSupport, { recursive: true, mode: 0o700 });
  await freshCheckout();
  const authority = await ensureAuthority(home.certificateFolder, OPEN_HOST);

  const { thisMachine } = await import("../src/control/index.ts");
  const machine = thisMachine({ home, repo: checkout, node: process.execPath, handOff: async () => 0 });
  await machine.install(say);

  // The control goes in last and is read back, because "wrote it" and "it is
  // there" are different claims and every path below rests on the second one.
  await store().put({ [THE_CONTROL]: CANNOT_BUY_ANYTHING });
  const armed = await controlIsArmed();
  await keep({ ...(await record()), negativeControl: armed });

  say();
  say(armed ? `negative control armed: that Window's own credential cannot buy anything.` : `THE CONTROL IS NOT ARMED.`);
  if (!armed) {
    complain(`the credential did not read back out of ${environmentStoreFile(PROVING_WINDOW.appSupport)}.`);
    complain(`Nothing measured against this Window would prove anything. Stopping.`);
    leave(1);
  }

  say(`certificate for that Window at ${authority.caCertificatePath}`);
  say();
  say(`Next, and only you can do these:`);
  say();
  say(`  1. relay prove --copy-login  # so it does not ask you to sign in again`);
  say(`  2. relay prove --open`);
  say(`  3. CLAUDE_RELAY_HOME=${PROVING_WINDOW.folder} relay use <seat>`);
  say(`  4. relay prove --start plain # and follow what it tells you`);
  leave(0);
}

if (flag("--copy-login")) {
  /**
   * Copied rather than signed in again, which is the point.
   *
   * Every sign-in is a thing the user has to do and a thing the far end notices, so
   * a Proving Window that inherits the live Window's login costs neither. The two
   * are still separate Windows in every way that matters here: their own stores,
   * their own relays, their own Payers.
   */
  const live = THE_USERS_DESKTOP_FOLDER;

  /**
   * Closed first, because copying into a running profile is undone when it exits.
   *
   * Closing this one is allowed and closing the Window the user works in is not,
   * and that line is drawn inside `closeWindowOn` rather than here: it refuses the
   * user's own Desktop folder whatever it is asked.
   */
  if (await isWindowRunningOn(PROVING_WINDOW.appSupport)) {
    const shut = await closeWindowOn(PROVING_WINDOW.appSupport);
    say(`the Proving Window was open, so it was closed first: ${shut.because}`);
    if (!shut.closed) {
      complain(`copying into a running profile would be undone when it exits. Quit that Window and try again.`);
      leave(1);
    }
    // Waited for rather than slept through: the app writes its own state out on
    // the way down, and copying over it half way through is the thing being
    // avoided in the first place.
    const gone = await untilItIsTrue(async () => !(await isWindowRunningOn(PROVING_WINDOW.appSupport)));
    if (!gone) {
      complain(`the Proving Window has not closed. Quit it and try again.`);
      leave(1);
    }
    say(`it is closed.`);
  }

  const held = await loginIn(live);
  if (!held.held) {
    complain(`the Window you work in has no readable claude.ai session: ${held.because ?? "no reason given"}`);
    leave(1);
  }
  say(`the Window you work in holds a session (${held.fingerprint}). Copying what carries it.`);

  /**
   * Ours is put back afterwards, because the copy would otherwise bring the live
   * Window's own environment store across, and with it the relay address and the
   * certificate belonging to the other Window.
   */
  const ourStore = environmentStoreFile(PROVING_WINDOW.appSupport);
  const ours = await readFile(ourStore, "utf8").catch(() => null);

  await mkdir(PROVING_WINDOW.appSupport, { recursive: true, mode: 0o700 });
  let copied = 0;
  for (const name of WHAT_CARRIES_A_LOGIN) {
    const from = join(live, name);
    const there = await stat(from).catch(() => null);
    if (there === null) continue;
    await rm(join(PROVING_WINDOW.appSupport, name), { recursive: true, force: true });
    await cp(from, join(PROVING_WINDOW.appSupport, name), { recursive: true });
    copied += 1;
  }
  say(`copied ${copied} of ${WHAT_CARRIES_A_LOGIN.length} things that carry a login, and none of the rest.`);
  say(`left behind on purpose: ${LEFT_BEHIND.slice(0, 4).join(", ")}, and the caches.`);

  if (ours !== null) {
    await writeFile(ourStore, ours, { mode: 0o600 });
    say(`put this Window's own environment store back, so it still points at its own relay.`);
  }

  /**
   * Read back out of the copy, with the same code that reads a Stats login.
   *
   * "Copied the files" and "the login works there" are different claims, and only
   * the second one is worth anything. If the key were per-profile rather than per
   * application this is where it would fail, and it would fail here rather than in
   * front of somebody wondering why the Window is asking them to sign in.
   */
  const inTheCopy = await loginIn(PROVING_WINDOW.appSupport);
  if (!inTheCopy.held) {
    complain(`the copy does not hold a readable session: ${inTheCopy.because ?? "no reason given"}`);
    complain(`Sign the Proving Window in by hand instead.`);
    leave(1);
  }
  const same = inTheCopy.fingerprint === held.fingerprint;
  say(`the copy holds the same session, read back with our own reader: ${same ? "yes" : "no, a different one"}`);

  const armed = await controlIsArmed();
  say(`negative control still armed: ${armed ? "yes" : "NO"}`);

  say();
  say(`Now open it:  relay prove --open`);
  leave(armed && same ? 0 : 1);
}

if (flag("--open")) {
  const already = await isWindowRunningOn(PROVING_WINDOW.appSupport);
  if (already) {
    say(`The Proving Window is already open. Nothing to do.`);
    leave(0);
  }

  const authority = await ensureAuthority(home.certificateFolder, OPEN_HOST);
  const pid = await launchWindow({
    executable: windowExecutable(),
    bundle: CLAUDE_DESKTOP,
    folder: PROVING_WINDOW.appSupport,
    args: [`--user-data-dir=${PROVING_WINDOW.appSupport}`],
    // The Dock's environment underneath, the same as the profiles launcher gets,
    // so what this Window is proving is the relay and not whatever the terminal
    // that ran this command happened to be carrying. See
    // `src/profiles/internal/environment.ts`.
    environment: asFromTheDock(process.env, await loginPath()),
    // Handed over at launch as well as through the store, because the proxy
    // variables survive that way and the certificate cannot (ADR 0006).
    variables: { ...proxyVariables(address), ...certificateVariables(authority.caCertificatePath) },
  });
  say(`Proving Window opened as pid ${pid}, on its own Desktop folder ${PROVING_WINDOW.appSupport}.`);

  // Said from what is actually in that folder rather than assumed either way.
  const login = await loginIn(PROVING_WINDOW.appSupport);
  say(
    login.held
      ? `It holds a claude.ai session (${login.fingerprint}), so it should not ask you to sign in.`
      : `It holds no session, so it will ask you to sign in. "relay prove --copy-login" copies the one ` +
        `from the Window you work in instead.`,
  );
  leave(0);
}

if (flag("--start")) {
  const path = pathNamed(after("--start"));
  if (!(await controlIsArmed())) {
    complain(`the negative control is not armed, so nothing measured now would prove anything.`);
    complain(`Run "relay prove --set-up" first.`);
    leave(1);
  }
  const choice = await readChoice(home.choiceFile);
  if (choice.mode !== "manual" || choice.payer === null) {
    complain(`no Seat is paying for the Proving Window yet. Pick one:`);
    complain(`  CLAUDE_RELAY_HOME=${PROVING_WINDOW.folder} relay use <seat>`);
    leave(1);
  }

  await writeJsonFile(startedFile, { key: path.key, at: new Date().toISOString() });
  say(`Measuring: ${path.called}`);
  say(`Paying: ${choice.payer}. The control is armed, so nothing else can pay.`);
  say();
  say(`Do this, in the Proving Window:`);
  for (const step of path.byHand) say(`  ${step}`);
  say();
  say(`Then come back and say what happened:`);
  say(`  relay prove --finish ${path.key} --worked`);
  say(`  relay prove --finish ${path.key} --failed`);
  leave(0);
}

if (flag("--finish")) {
  const path = pathNamed(after("--finish"));
  const worked = flag("--worked");
  if (!worked && !flag("--failed")) {
    complain(`say which: --worked or --failed. Nothing is inferred here.`);
    leave(1);
  }

  const started = await readJsonFile<{ key: string; at: string }>(startedFile);
  if (started === null || started.key !== path.key) {
    complain(`"${path.key}" was not started, so there is no window of time to read.`);
    complain(`  relay prove --start ${path.key}`);
    leave(1);
    throw new Error("unreachable");
  }

  const held = await record();
  const saw = await whatTheRelaySaw(started.at, new Date().toISOString());
  const judged = judgePath({ workCompleted: worked, negativeControl: await controlIsArmed(), saw });

  await keep(
    withRow(held, {
      key: path.key,
      verdict: judged.verdict,
      on: new Date().toISOString().slice(0, 10),
      versions: await versions(),
      saw,
      saying: judged.saying,
    }),
  );
  await rm(startedFile, { force: true });

  say(`${path.called}: ${judged.verdict}`);
  say(`  ${judged.saying}`);
  say();
  say(`Write it into the matrix with:  relay prove --matrix`);
  leave(judged.verdict === "covered" ? 0 : 1);
}

if (flag("--not-applicable")) {
  const path = pathNamed(after("--not-applicable"));
  const why = process.argv[process.argv.indexOf("--not-applicable") + 2];
  if (why === undefined) {
    complain(`say why. A row with no reason is an omission wearing a verdict.`);
    leave(1);
    throw new Error("unreachable");
  }
  await keep(
    withRow(await record(), {
      key: path.key,
      verdict: "not-applicable",
      on: new Date().toISOString().slice(0, 10),
      versions: await versions(),
      saw: { verified: 0, mismatch: 0, unverified: 0 },
      saying: why,
    }),
  );
  say(`${path.called}: not applicable. ${why}`);
  leave(0);
}

if (flag("--matrix")) {
  const held = await record();
  const limits = knownLimits(held);

  const written = [
    `# Coverage: which paths land on the Seat we chose`,
    ``,
    `Measured, path by path, on a Proving Window with a negative control armed: that`,
    `Window's own credential cannot buy anything, so work that completes can only have`,
    `completed through the relay. Counting requests would prove nothing, because a`,
    `request that went round the relay is simply absent and an absence looks exactly`,
    `like work that never happened.`,
    ``,
    `Written by \`relay prove --matrix\`. Re-runnable: after a Claude Desktop update,`,
    `\`relay prove --start <path>\` each row again.`,
    ``,
    ...asTable(held),
    ``,
    `## Known limits`,
    ``,
    ...(limits.length === 0
      ? [`Nothing measured so far falls outside the relay.`]
      : limits.flatMap((row) => [
          `- **${PATHS.find((one) => one.key === row.key)?.called ?? row.key}** — ${row.verdict}. ${row.saying}`,
        ])),
    ``,
    `## What each row means`,
    ``,
    ...PATHS.flatMap((path) => [`- **${path.called}** — ${path.note}`]),
    ``,
  ].join("\n");

  await writeFile(matrixFile, written);
  say(`wrote ${matrixFile}`);
  for (const line of asTable(held)) say(line);
  leave(0);
}

// ---- with nothing asked for, say where things stand -------------------------

const held = await record();
const armed = await controlIsArmed();
const open = await isWindowRunningOn(PROVING_WINDOW.appSupport);
const measured = held.rows.length;

say(`The Proving Window`);
say(`  Desktop folder: ${PROVING_WINDOW.appSupport}`);
say(`  its relay:      http://${address.host}:${address.port}, home ${PROVING_WINDOW.folder}`);
say(`  open:           ${open ? "yes" : "no"}`);
say(`  control armed:  ${armed ? "yes" : "no"}`);
say(`  measured:       ${measured} of ${PATHS.length} paths`);
say();

if (!armed) {
  say(`Nothing is set up yet. Start with:`);
  say(`  relay prove --set-up`);
  leave(0);
}

const next = PATHS.find((path) => !held.rows.some((row) => row.key === path.key));
say(
  next === undefined
    ? `Every path has been measured. Write the matrix with:  relay prove --matrix`
    : `Next:  relay prove --start ${next.key}    (${next.called})`,
);
leave(0);
