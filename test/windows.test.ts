/**
 * The four things that are Windows' own, held to the same claims the macOS ones
 * are held to.
 *
 * Everything else in this suite runs on both machines and is written to. These
 * four have no macOS counterpart that could stand in for them: where the Send
 * tokens live, how the app's own store is locked, how the relay is a service, and
 * where the `claude` command keeps its own login. On macOS each of those is a
 * thing this program does not own — the Keychain, launchd — and the rule there is
 * that no test may touch them. The same rule holds here: nothing below reaches
 * `CryptProtectData`, the Startup folder, or a real Claude Desktop profile.
 *
 * They are skipped whole on any other machine rather than left to fail, because a
 * test that cannot run is not a test that failed.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decryptFromAppOnWindows,
  encryptForAppOnWindows,
  localStateFile,
  openEnvironmentStore,
  openV10OnWindows,
  certificateVariables,
} from "../src/app-store/index.ts";
import { ON_WINDOWS, relayHome, aWindowUnder, sameFolder } from "../src/home/index.ts";
import { readCliLoginFromFile } from "../src/cli-login/index.ts";
import {
  aWindowlessRun,
  supervisorScriptFor,
  startupItemService,
  startupFolder,
  serviceLabelFor,
} from "../src/service/index.ts";
import { holdingItsOwnLock, windowsEgressFrom, readWindowsProxy, readWindowsSocks } from "../src/window/index.ts";
import { zipOneFile, fileFromZip } from "../src/zip/index.ts";

const only = { skip: ON_WINDOWS ? false : "Windows only" };

async function inATemporaryFolder<T>(run: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "relay-windows-"));
  try {
    return await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/* ------------------------------------------ the app's own store, as locked ---- */

test("the store round-trips in Chromium's Windows scheme, which is not the macOS one", only, async () => {
  const key = randomBytes(32);
  const locked = encryptForAppOnWindows("NODE_EXTRA_CA_CERTS=/somewhere", key);

  // The three bytes the app looks for, then a nonce, then the body and the tag.
  assert.equal(locked.subarray(0, 3).toString("utf8"), "v10");
  assert.equal(decryptFromAppOnWindows(locked, key), "NODE_EXTRA_CA_CERTS=/somewhere");

  // Fresh every time, so two writes of the same value are not the same bytes.
  assert.notDeepEqual(locked, encryptForAppOnWindows("NODE_EXTRA_CA_CERTS=/somewhere", key));
});

test("a wrong key is refused rather than answered, because the tag does not verify", only, () => {
  const locked = encryptForAppOnWindows("something", randomBytes(32));
  assert.throws(() => decryptFromAppOnWindows(locked, randomBytes(32)));
  assert.equal(openV10OnWindows(locked, randomBytes(32)), null);
});

test("a value that is not in this scheme is not read as an empty one", only, () => {
  assert.equal(openV10OnWindows(Buffer.from("v11nonsense"), randomBytes(32)), null);
  assert.equal(openV10OnWindows(Buffer.from("v10"), randomBytes(32)), null, "too short to hold a nonce and a tag");
});

test("the key is looked for beside the store, in that profile's own state", only, () => {
  assert.equal(localStateFile("C:\\somewhere\\profile"), join("C:\\somewhere\\profile", "Local State"));
});

test("the store the app reads is written under the key handed to it", only, async () => {
  await inATemporaryFolder(async (folder) => {
    const key = randomBytes(32);
    const file = join(folder, "ccd-environment-config.json");
    const store = openEnvironmentStore({
      file,
      lock: {
        encrypt: async (plain) => encryptForAppOnWindows(plain, key),
        decrypt: async (blob) => decryptFromAppOnWindows(blob, key),
      },
    });

    await store.put(certificateVariables("C:\\ca\\ca.crt"));
    const written = JSON.parse(await readFile(file, "utf8")) as { envVars: string };
    assert.ok(!written.envVars.includes("ca.crt"), "the value must not be readable in the file");
    assert.deepEqual(await store.read(), { NODE_EXTRA_CA_CERTS: "C:\\ca\\ca.crt", NODE_USE_SYSTEM_CA: "1" });
  });
});

/* --------------------------------------------------- the relay as a service ---- */

test("the login item starts the relay, waits for it, and starts it again", only, () => {
  const home = relayHome(aWindowUnder("C:\\Users\\someone\\.claude-desktop-relay"));
  const script = supervisorScriptFor({
    label: "claude-desktop-relay",
    node: "C:\\Program Files\\nodejs\\node.exe",
    script: "C:\\repo\\scripts\\serve.ts",
    args: ["8978"],
    workingDirectory: "C:\\repo",
    logFile: home.serviceLogFile,
    environment: { CLAUDE_RELAY_PORT: "8978" },
  });

  // No window, and waiting: the first makes it a service rather than a black
  // rectangle on somebody's desktop, and the second is what makes the loop a
  // supervisor rather than a way to start a great many relays at once.
  assert.match(script, /sh\.Run .*, 0, True/);
  assert.match(script, /^Do$/m);
  assert.match(script, /^Loop$/m);
  assert.match(script, /WScript\.Sleep \d+/);

  // Which Window it serves, handed over rather than inherited. ADR 0012.
  assert.match(script, /env\("CLAUDE_RELAY_PORT"\) = "8978"/);

  /**
   * Every quote doubled exactly once.
   *
   * Doubling them while building the command and again while making it a string
   * literal produced four quotes around every path, a command line Windows could
   * not parse, and a relay that started at login and did nothing at all.
   */
  assert.match(script, /sh\.Run "".*node\.exe"" "".*serve\.ts"" ""8978""", 0, True/);
  assert.ok(!script.includes('""""'), "a quote was doubled twice");
});

test("a login item quotes every part, so a path with a space in it survives", only, () => {
  /**
   * The failure this catches, seen for real on 2026-08-25.
   *
   * Windows Script Host given `...\Windows\Start Menu\...` unquoted takes the
   * space as the end of the argument, and says "There is no file extension in
   * C:\Users\me\...\Windows\Start". Every path that matters here has a space
   * somewhere near it: `Program Files`, `Start Menu`, `Application Support` on
   * the other machine. A rule that quotes only the parts that happen to hold a
   * space is a rule that works until somebody's repository is in `My Projects`.
   */
  const spaced = aWindowlessRun(["C:\\Program Files\\nodejs\\node.exe", "C:\\My Projects\\relay\\serve.ts", "8978"], {
    wait: true,
  });
  assert.match(spaced, /^sh\.Run ".*", 0, True$/);
  assert.ok(spaced.includes('""C:\\My Projects\\relay\\serve.ts""'), `the path with a space is not quoted: ${spaced}`);
  assert.ok(!spaced.includes('""""'), "a quote was doubled twice");

  // Quoted whether it needs it or not, because a rule with no exception has no
  // edge for a path to fall off.
  const plain = aWindowlessRun(["powershell.exe", "-File", "C:\\relay\\tray.ps1"], { wait: false });
  assert.ok(plain.includes('""powershell.exe""'), `even the program is quoted: ${plain}`);
  assert.ok(plain.endsWith(", 0, False"), "the tray does not wait for what it starts");
});

test("a relay for a Window of its own is its own login item, so it cannot replace the first", only, () => {
  const item = (port: number) =>
    startupItemService({
      plan: {
        label: serviceLabelFor(port, 8978),
        node: "node.exe",
        script: "serve.ts",
        args: [String(port)],
        workingDirectory: "C:\\repo",
        logFile: "C:\\home\\service.log",
      },
    }).file;

  assert.notEqual(item(8978), item(8980));
  assert.ok(item(8978).startsWith(startupFolder()), "it goes where Windows looks at login");
  assert.ok(item(8980).includes("8980"), "and the second is told apart by its port");
});

test("installing it needs nothing outside the user's own files", only, () => {
  const where = startupFolder();
  assert.ok(where.includes("Start Menu"), "the user's own Startup folder, not the machine's");
  assert.ok(!/^C:\\Windows/i.test(where));
  assert.ok(!/^C:\\Program Files/i.test(where));
});

/* ------------------------------------------------------------- the tray ---- */

test("the tray's script carries a byte order mark, or its own text draws as rubbish", only, async () => {
  const script = join(import.meta.dirname, "..", "src", "tray", "relay-tray.ps1");
  const bytes = await readFile(script);

  /**
   * The three bytes that tell Windows PowerShell this file is UTF-8.
   *
   * Without them it reads the file as the machine's ANSI code page, and every
   * character above ASCII in the menu is decoded a byte at a time: a middle dot
   * becomes two characters of rubbish, an ellipsis becomes three. Measured
   * 2026-08-25, in the tray, by a person looking at it.
   *
   * Checked rather than remembered, because the mark is invisible in every editor
   * and an ordinary save can drop it without anybody seeing anything change.
   */
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "the byte order mark is gone");

  // And it is really UTF-8 after the mark, so the mark is not a lie about it.
  const text = bytes.subarray(3).toString("utf8");
  assert.ok(text.includes("·"), "the menu's own separator is there and readable");
  assert.ok(!text.includes("�"), "something in this file is not UTF-8");
});

/* ------------------------------------------- how traffic leaves this machine ---- */

test("a machine that names no proxy goes straight out, which is what it would do itself", only, () => {
  const dump = `HKEY_CURRENT_USER\\...\\Internet Settings\n    ProxyEnable    REG_DWORD    0x0\n`;
  assert.deepEqual(windowsEgressFrom(dump), { kind: "direct" });
  assert.equal(readWindowsProxy(dump), null);
});

test("a machine that names an HTTPS proxy is chained through it, never round it", only, () => {
  const one = `    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    proxy.example:3128\n`;
  assert.deepEqual(windowsEgressFrom(one), { kind: "proxy", at: { host: "proxy.example", port: 3128 } });

  const apart = `    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=a:1;https=b:2;ftp=c:3\n`;
  assert.deepEqual(windowsEgressFrom(apart), { kind: "proxy", at: { host: "b", port: 2 } });
});

test("a machine that names only SOCKS is refused with the reason, and never bypassed", only, () => {
  const dump = `    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    socks=s:1080\n`;
  assert.deepEqual(readWindowsSocks(dump), { host: "s", port: 1080 });

  const how = windowsEgressFrom(dump);
  assert.equal(how.kind, "refuse", "going direct past a named proxy is the leak ADR 0011 removed");
  assert.match(how.kind === "refuse" ? how.why : "", /SOCKS/);
});

/* ---------------------------------------------------------- the CLI login ---- */

test("the CLI login is read from its own date, in the same three answers", only, async () => {
  await inATemporaryFolder(async (folder) => {
    const file = join(folder, ".credentials.json");

    // Nothing there is a machine with nothing to lose, and never a failure.
    assert.deepEqual(await readCliLoginFromFile(file), { kind: "none" });

    await writeFile(file, "{}", "utf8");
    const held = await readCliLoginFromFile(file);
    assert.equal(held.kind, "held");
    assert.equal(
      held.kind === "held" ? held.lastChanged : "",
      new Date((await stat(file)).mtimeMs).toISOString(),
      "the date is the file's own, to the millisecond",
    );

    // A folder where a file was asked for answered nothing, so it is unreadable
    // rather than "no login": two unreadables must never compare equal and read
    // as untouched.
    assert.equal((await readCliLoginFromFile(folder)).kind, "held");
  });
});

/* ------------------------------------------- whether a profile is open ---- */

test("a profile answers for itself, and a folder nobody is holding reads as closed", only, async () => {
  await inATemporaryFolder(async (folder) => {
    /**
     * The negative control, which is the half that matters.
     *
     * A check that answers "open" whatever it is asked would look right on this
     * machine every time, because both real profiles are open almost always. So
     * what is asserted here is the answer that can be wrong: a folder holding a
     * `lockfile` nobody has open is a profile that is not running.
     */
    const closed = join(folder, "a-profile-nobody-is-in");
    await mkdir(closed, { recursive: true });
    await writeFile(join(closed, "lockfile"), "", "utf8");
    assert.equal(holdingItsOwnLock(closed), false, "nothing holds it, so nothing is running there");

    // A folder no Claude Desktop has ever run in has no lock at all, which is the
    // same answer arrived at differently.
    assert.equal(holdingItsOwnLock(join(folder, "never-used")), false);

    /**
     * The other half is a by-hand check, and this says so rather than faking it.
     *
     * What makes a running profile answer "open" is that Claude Desktop holds its
     * `lockfile` with no sharing at all. Node cannot open a file that way: every
     * handle it makes shares reads and writes, so a hold taken here would not be
     * the hold being tested and asserting on it would prove the opposite of what
     * it appears to. Measured against the real thing instead, 2026-08-25: both
     * Claude Desktop profiles on this machine read as open by this call and by the
     * process list, and they agreed.
     */
  });
});

/* ------------------------------------------------------- the paths and names ---- */

test("one folder spelled several ways is one folder", only, () => {
  const folder = "C:\\Users\\someone\\AppData\\Roaming\\Claude";
  assert.equal(sameFolder(folder, folder), true);
  assert.equal(sameFolder(folder, `${folder}\\`), true);
  assert.equal(sameFolder(folder, folder.replace(/\\/g, "/")), true);
  assert.equal(sameFolder(folder, folder.toUpperCase()), true);
  assert.equal(sameFolder(folder, `${folder}-relayed`), false);
});

/* ------------------------------------------------------------ the archive ---- */

test("the archive's zip half is written and read by this program on both machines", () => {
  const inside = Buffer.from(`{"seats":[]}\n`, "utf8");
  const archive = zipOneFile("seats-and-send-tokens.json", inside);
  assert.deepEqual(fileFromZip(archive, "seats-and-send-tokens.json"), inside);

  // No timestamp and no owner, so two archives of the same Seats are the same
  // bytes and a backup that changed can be told from one that was rewritten.
  assert.deepEqual(archive, zipOneFile("seats-and-send-tokens.json", inside));

  // A name that is not in it is refused rather than half-read.
  assert.throws(() => fileFromZip(archive, "something-else.json"));
});

/* ----------------------------------------- the terminal a mint needs ---- */

test("an argument reaches the child as one argument, however it is spelled", only, async () => {
  const { asOneArgument } = await import("../src/minting/index.ts");

  /**
   * Windows' own rule, and the reason this is tested rather than trusted.
   *
   * `Start-Process -ArgumentList` joins its list with spaces and quotes nothing,
   * so an argument holding a space arrives at the child as two. The quoting is
   * therefore ours, and the rule has three parts: wrap in quotes, double any run
   * of backslashes that meets a quote and escape that quote, and double a run of
   * backslashes at the very end because the closing quote follows it.
   *
   * The real mint runs `claude setup-token`: one word, no space, no quote, no
   * backslash. The rule could be wrong in every one of those three ways and every
   * real mint would still work, right up until a path had a quote in it. Two of
   * the three were wrong, and nothing said so.
   */
  assert.equal(asOneArgument("setup-token"), '"setup-token"');
  assert.equal(asOneArgument("a path with spaces"), '"a path with spaces"');

  // Built from character codes rather than written out, because an escape that
  // goes wrong here makes both sides of the comparison wrong together and the
  // test passes while reading as something else entirely. That happened.
  const slash = String.fromCharCode(92);
  const quote = String.fromCharCode(34);

  // A backslash not in front of a quote is literal and is left as it is.
  assert.equal(asOneArgument(`C:${slash}Program Files${slash}node.exe`), `"C:${slash}Program Files${slash}node.exe"`);

  // One that meets a quote is doubled, and the quote is escaped.
  assert.equal(asOneArgument(`say ${quote}hi${quote}`), `"say ${slash}${quote}hi${slash}${quote}"`);
  assert.equal(
    asOneArgument(`C:${slash}a${slash}${quote}b`),
    `"C:${slash}a${slash}${slash}${slash}${quote}b"`,
    "the run before the quote is doubled and the quote escaped",
  );

  // And a run at the very end is doubled, so the closing quote is not eaten by it.
  assert.equal(asOneArgument(`C:${slash}folder${slash}`), `"C:${slash}folder${slash}${slash}"`);
});

/* ----------------------------------- what a Window is started with ---- */

test("nothing of ours reaches a Window we start", only, async () => {
  const { isOurs, asFromTheDock } = await import("../src/profiles/index.ts");

  /**
   * The failure this catches, and it cost an afternoon on 2026-08-25.
   *
   * The Window the user works in was started by a command running inside a Code
   * session of another profile, and it inherited that session's variables. Two of
   * them were `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`:
   * the named pipe and the token of the *other* profile's Code session. That
   * Window's own sessions then talked to the wrong profile's pipe, and its MCP
   * servers sat there asking to reconnect for an hour. The symptom looked like
   * broken addresses or a bad token, and it was: the wrong profile's.
   *
   * The rule itself is `src/profiles/internal/environment.ts` and is not Windows'
   * own. What is checked here is that it holds for the names this machine's Code
   * sessions actually set, spelled the way they are spelled here.
   */
  for (const gone of [
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_RELAY_PORT",
    "HTTPS_PROXY",
    "https_proxy",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_SYSTEM_CA",
  ]) {
    assert.equal(isOurs(gone), true, `${gone} would reach a Window, and it decides something the store owns`);
  }

  // And a Window is a whole application, so the machine's own environment stays.
  for (const kept of ["PATH", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "COMSPEC"]) {
    assert.equal(isOurs(kept), false, `${kept} is the machine's, and a Window needs it`);
  }

  const built = asFromTheDock(
    { PATH: "C:\Windows", SYSTEMROOT: "C:\Windows", CLAUDE_CODE_MESSAGING_TOKEN: "somebody else's" },
    null,
  );
  assert.equal(built["CLAUDE_CODE_MESSAGING_TOKEN"], undefined);
  assert.equal(built["SYSTEMROOT"], "C:\Windows");
  assert.equal(built["PATH"], "C:\Windows", "with no login PATH read, the one we have stands");
});
