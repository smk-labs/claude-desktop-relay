import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import {
  HOME_VARIABLE,
  ON_WINDOWS,
  aWindowUnder,
  isTheUsersOwnDesktopFolder,
  relayHome,
  whyThisHomeLooksEmpty,
  THE_USERS_DESKTOP_FOLDER,
} from "../src/home/index.ts";
import {
  CLAUDE_DESKTOP,
  launchWindow,
  proxyVariables,
  readMachineProxy,
  machineEgressFrom,
  readSocksProxy,
  windowExecutable,
  closeWindowOn,
  pidsRunningOn,
} from "../src/window/index.ts";
import {
  CERTIFICATE_VARIABLES,
  certificateVariables,
  environmentStoreFile,
  openEnvironmentStore,
  codeConfigVariables,
  CODE_CONFIG_VARIABLES,
  macLock,
  encryptForAppOnWindows,
  decryptFromAppOnWindows,
  type Lock,
} from "../src/app-store/index.ts";

const RELAY = { host: "127.0.0.1", port: 8977 };

/**
 * A lock of our own, in the scheme this machine's Claude Desktop actually uses,
 * with a key that is not the machine's.
 *
 * Both halves matter. No test may go near the Keychain or the app's own key, and
 * a test that exercised the macOS cipher on Windows would prove nothing about the
 * store this machine will have to read: the two schemes share only a name and
 * a version prefix.
 */
const ourKey = Buffer.alloc(32, 7);
const lock: Lock = ON_WINDOWS
  ? {
      async encrypt(plain) {
        return encryptForAppOnWindows(plain, ourKey);
      },
      async decrypt(blob) {
        return decryptFromAppOnWindows(blob, ourKey);
      },
    }
  : macLock(async () => "a-secret-that-is-not-the-machine's");


/**
 * One line of this machine's own process list, in this machine's own spelling.
 *
 * The two are not alike and the difference is exactly what `runningOn` and
 * `pidsRunningOn` have to get right: macOS prints the executable path bare, and
 * Windows puts the pid in front and quotes the executable because its path always
 * has a space in it. Writing the fixtures for one machine and running them on the
 * other proves nothing about either, so they are built here.
 */
function aProcessLine(pid: number, options: { executable?: string; args?: readonly string[] } = {}): string {
  const executable = options.executable ?? windowExecutable(CLAUDE_DESKTOP);
  const args = (options.args ?? []).join(" ");
  return ON_WINDOWS
    ? `${pid} "${executable}"${args === "" ? "" : ` ${args}`}`
    : `  ${pid} ${executable}${args === "" ? "" : ` ${args}`}`;
}

/** A process of somebody else's, spelled the way this machine spells one. */
function someoneElsesLine(pid: number, executable: string, args: readonly string[] = []): string {
  return aProcessLine(pid, { executable, args });
}

/** A Desktop folder that is not the user's own, on a path this machine has. */
function anotherDesktopFolder(name: string): string {
  return join(tmpdir(), name);
}

async function inTemporaryFolder<T>(run: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "relay-launcher-"));
  try {
    return await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("every case and scheme of the proxy variables is set", () => {
  const variables = proxyVariables(RELAY);

  assert.deepEqual(Object.keys(variables).sort(), [
    "ALL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "all_proxy",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]);

  // A login shell that already exported the lowercase name must not win, and a
  // machine with all_proxy set to SOCKS must be overridden, because the relay
  // speaks HTTP CONNECT.
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    assert.equal(variables[name], "http://127.0.0.1:8977", `${name} must point at the relay over http`);
  }

  assert.match(variables.NO_PROXY ?? "", /127\.0\.0\.1/);
  assert.equal(variables.no_proxy, variables.NO_PROXY);
});

test("the certificate variable is not handed over at launch, because the app would overwrite it", () => {
  assert.equal(proxyVariables(RELAY).NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(certificateVariables("/somewhere/ca.crt").NODE_EXTRA_CA_CERTS, "/somewhere/ca.crt");
});

test("the store round-trips what the app will read, in the form the app reads", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "ccd-environment-config.json");
    const store = openEnvironmentStore({ file, lock });

    assert.deepEqual(await store.read(), {}, "no store yet reads as nothing");

    await store.put(certificateVariables("/somewhere/ca.crt"));
    assert.deepEqual(await store.read(), { NODE_EXTRA_CA_CERTS: "/somewhere/ca.crt", NODE_USE_SYSTEM_CA: "1" });

    // The app reads a base64 blob under one key, beginning with the version the
    // scheme is pinned to. Getting this wrong is silent: the app cannot read it
    // and says nothing.
    const written = JSON.parse(await readFile(file, "utf8")) as { envVars: string };
    assert.ok(typeof written.envVars === "string");
    assert.equal(Buffer.from(written.envVars, "base64").subarray(0, 3).toString("utf8"), "v10");
    assert.ok(!written.envVars.includes("ca.crt"), "the value must not be readable in the file");
    // Windows has no such mode: `stat` reports 0o666 whatever the file is, and
    // asserting it there would be a test that passes for the wrong reason. What
    // stands in its place is that the value is unreadable without the key, which
    // is asserted on the line above and holds on both machines.
    if (!ON_WINDOWS) assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
});

test("undoing removes only what we put there, and leaves the user's own variables", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "ccd-environment-config.json");
    const store = openEnvironmentStore({ file, lock });

    await store.put({ SOMETHING_THE_USER_SET: "theirs" });
    await store.put(certificateVariables("/somewhere/ca.crt"));

    await store.forget([...CERTIFICATE_VARIABLES]);

    assert.deepEqual(await store.read(), { SOMETHING_THE_USER_SET: "theirs" });
    await stat(file);
  });
});

test("undoing removes the store altogether when nothing of the user's is left in it", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "ccd-environment-config.json");
    const store = openEnvironmentStore({ file, lock });

    await store.put(certificateVariables("/somewhere/ca.crt"));
    await store.forget([...CERTIFICATE_VARIABLES]);

    await assert.rejects(() => stat(file), "the file must be gone, not left holding an empty set");
    assert.deepEqual(await store.read(), {});
  });
});

test("nothing of ours is ever written inside the Claude Desktop bundle", async () => {
  // Not a fingerprint of a folder nothing touches: that assertion cannot fail.
  // Two things that can. First, every path this program writes to is outside the
  // bundle, by construction.
  const home = relayHome(aWindowUnder(join(tmpdir(), "somewhere", "of", "ours")));
  for (const path of [home.folder, home.seatsFile, home.verdictFile, home.certificateFolder, home.choiceFile, environmentStoreFile()]) {
    assert.ok(!path.startsWith(CLAUDE_DESKTOP), `${path} is inside the bundle`);
    assert.ok(!path.includes("Claude.app"), `${path} is inside an app bundle`);
  }

  // Second, the bundle path is only ever read from or started, never written to.
  // A line that both names the bundle and calls something that writes is the
  // failure this looks for.
  const writes = /\b(writeFile|appendFile|mkdir|rename|rm|unlink|chmod|copyFile|createWriteStream)\s*\(/;
  const offenders: string[] = [];

  for (const folder of ["src", "scripts"]) {
    const entries = await readdir(join(import.meta.dirname, "..", folder), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const body = await readFile(join(entry.parentPath, entry.name), "utf8");

      body.split("\n").forEach((line, index) => {
        const namesTheBundle = /CLAUDE_DESKTOP|windowExecutable|Claude\.app/.test(line);
        if (namesTheBundle && writes.test(line)) offenders.push(`${folder}/${entry.name}:${index + 1} ${line.trim()}`);
      });
    }
  }

  assert.deepEqual(offenders, [], `these could write inside the bundle:\n${offenders.join("\n")}`);
});

test("the variables reach the process that is started", async () => {
  await inTemporaryFolder(async (folder) => {
    // A stand-in for the Window: it writes down the variables it was given, which
    // is the only thing worth asserting about the launch itself. Written in Node
    // rather than in a shell, because the shell is the one part of this that is
    // not the same on both machines and is not what is being tested.
    const reporter = join(folder, "reporter.js");
    await writeFile(
      reporter,
      `const { writeFileSync } = require("node:fs");\n` +
        `const names = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY"];\n` +
        `writeFileSync(${JSON.stringify(join(folder, "seen"))}, names.map((n) => process.env[n] ?? "").join("\\n") + "\\n");\n`,
      { mode: 0o755 },
    );

    const variables = proxyVariables(RELAY);
    const pid = await launchWindow({ executable: process.execPath, variables, args: [reporter] });
    assert.ok(pid > 0);

    // Wait for the child to have written all five lines. The file appears the
    // moment the process opens it, so a shorter wait reads a partial one.
    for (let attempt = 0; attempt < 100; attempt++) {
      const seen = await readFile(join(folder, "seen"), "utf8").catch(() => null);
      if (seen !== null && seen.trim().split("\n").length === 5) {
        assert.deepEqual(seen.trim().split("\n"), [
          "http://127.0.0.1:8977",
          "http://127.0.0.1:8977",
          "http://127.0.0.1:8977",
          "http://127.0.0.1:8977",
          "localhost,127.0.0.1,::1,.local",
        ]);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("the started process never reported its environment");
  });
});

test("starting refuses plainly when there is no Claude Desktop where it looks", async () => {
  await assert.rejects(
    () => launchWindow({ executable: "/Applications/NotClaude.app/Contents/MacOS/Claude", variables: {} }),
    /no Claude Desktop at/,
  );
});

test("neither command needs administrator rights, because nothing is written outside the user's own files", async () => {
  assert.ok(environmentStoreFile().startsWith(homedir()), "the store belongs to the user");

  /**
   * Exactly one path this program names is outside the user's own files, and it
   * is the app itself, which is only ever read from and started.
   *
   * Counted rather than matched against one folder, because the two machines keep
   * the app in different places and one of them puts a version number in the
   * path. What has to hold is the count and the direction, not the folder.
   */
  const outside = [environmentStoreFile(), windowExecutable()].filter((path) => !path.startsWith(homedir()));
  assert.equal(outside.length, 1, `only the app is outside, and it is only read: ${outside.join(", ")}`);

  // Nothing anywhere asks for more rights than the user already has. The
  // commands are read too: every one of them lives in scripts/, which an earlier
  // version of this check was not looking at.
  const offenders: string[] = [];
  for (const folder of ["src", "scripts"]) {
    const entries = await readdir(join(import.meta.dirname, "..", folder), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const body = await readFile(join(entry.parentPath, entry.name), "utf8");
      if (/\b(sudo|SMJobBless|AuthorizationExecuteWithPrivileges)\b/.test(body)) {
        offenders.push(`${folder}/${entry.name}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the store is where the app looks for it", () => {
  assert.equal(environmentStoreFile("/support"), join("/support", "ccd-environment-config.json"));
  // Inside the profile's own folder on both machines, which is what makes one
  // relay serve one Desktop folder possible at all.
  assert.equal(environmentStoreFile(), join(THE_USERS_DESKTOP_FOLDER, "ccd-environment-config.json"));
  assert.match(
    environmentStoreFile(),
    ON_WINDOWS ? /Roaming.Claude.ccd-environment-config\.json$/ : /Library\/Application Support\/Claude\/ccd-environment-config\.json$/,
  );
});

/** Kept last: it starts nothing and only reads. */
test("the spawned process is let go, so the Window outlives the command", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  child.unref();
  assert.ok(child.pid !== undefined);
});

test("the machine's own proxy is read from the system setting, not the environment", () => {
  // As `scutil --proxy` prints it on this machine.
  const asPrinted = [
    "<dictionary> {",
    "  HTTPEnable : 1",
    "  HTTPPort : 2080",
    "  HTTPProxy : 127.0.0.1",
    "  HTTPSEnable : 1",
    "  HTTPSPort : 2080",
    "  HTTPSProxy : 127.0.0.1",
    "  SOCKSEnable : 1",
    "  SOCKSPort : 2080",
    "  SOCKSProxy : 127.0.0.1",
    "}",
  ].join("\n");

  assert.deepEqual(readMachineProxy(asPrinted), { host: "127.0.0.1", port: 2080 });

  assert.equal(readMachineProxy("<dictionary> {\n  HTTPSEnable : 0\n}"), null, "disabled means none");
  assert.equal(readMachineProxy("<dictionary> {\n}"), null, "nothing set means none");
});

test("a running Window is noticed from the real process list, not from pgrep", async () => {
  const { runningIn } = await import("../src/window/index.ts");

  const helper = ON_WINDOWS
    ? join(CLAUDE_DESKTOP, "..", "disclaimer.exe")
    : `${CLAUDE_DESKTOP}/Contents/Helpers/disclaimer`;
  const somethingElse = ON_WINDOWS ? "C:\\Windows\\explorer.exe" : "/Applications/Safari.app/Contents/MacOS/Safari";

  const withIt = [someoneElsesLine(1, somethingElse), aProcessLine(501), someoneElsesLine(502, helper)].join("\n");
  const withoutIt = [someoneElsesLine(1, somethingElse)].join("\n");

  assert.equal(runningIn(withIt), true);
  assert.equal(runningIn(withoutIt), false);

  // A helper of the app is not the app. Matching loosely would report a Window
  // that had closed, and the whole point of this is telling the user the truth
  // about what is about to stop working.
  assert.equal(runningIn(someoneElsesLine(502, helper)), false);
  assert.equal(runningIn(""), false);
});

test("how traffic leaves is read as a route this machine can take, never as a bare address", () => {
  // This machine, as `scutil --proxy` actually prints it: both an HTTPS proxy and
  // a SOCKS one, on the same port. The HTTPS one is the one we can speak.
  const both = [
    "<dictionary> {",
    "  HTTPEnable : 1",
    "  HTTPPort : 2080",
    "  HTTPProxy : 127.0.0.1",
    "  HTTPSEnable : 1",
    "  HTTPSPort : 2080",
    "  HTTPSProxy : 127.0.0.1",
    "  SOCKSEnable : 1",
    "  SOCKSPort : 2080",
    "  SOCKSProxy : 127.0.0.1",
    "}",
  ].join("\n");
  assert.deepEqual(machineEgressFrom(both), { kind: "proxy", at: { host: "127.0.0.1", port: 2080 } });

  // Nothing named at all. Direct is what the machine itself would do, which is
  // also the transparent-VPN case: a TUN device names nothing and needs to.
  assert.deepEqual(machineEgressFrom("<dictionary> {\n}"), { kind: "direct" });
  assert.deepEqual(machineEgressFrom("<dictionary> {\n  HTTPSEnable : 0\n}"), { kind: "direct" });

  /**
   * The one that matters, and the reason this function exists at all.
   *
   * One setting away from the machine above: the VPN is running and taking
   * traffic, and reading only the HTTPS line would call this "no proxy" and send
   * every request straight out past it. It used to be refused, which made the gap
   * safe rather than silent; since ticket 27 it is carried.
   */
  const socksOnly = [
    "<dictionary> {",
    "  HTTPSEnable : 0",
    "  SOCKSEnable : 1",
    "  SOCKSPort : 2080",
    "  SOCKSProxy : 127.0.0.1",
    "}",
  ].join("\n");
  assert.deepEqual(machineEgressFrom(socksOnly), {
    kind: "socks",
    at: { host: "127.0.0.1", port: 2080 },
    // macOS keeps the password in a Keychain item belonging to the system, so a
    // proxy that asks for one fails saying so rather than being ignored.
    credentials: null,
  });
  assert.notEqual(machineEgressFrom(socksOnly).kind, "direct", "a SOCKS proxy may never read as 'go direct'");

  assert.deepEqual(readSocksProxy(socksOnly), { host: "127.0.0.1", port: 2080 });
  assert.equal(readSocksProxy("<dictionary> {\n  SOCKSEnable : 0\n}"), null);
});

/**
 * The one Window nothing here closes, and the ones it may.
 *
 * The rule used to be "never quit, kill or restart a running Claude Desktop", full
 * stop, which was safe and too blunt: a Proving Window exists precisely so it can
 * be opened and closed freely, and refusing to close it made copying a login into
 * it a manual step for no reason. The rule is now about *which* Window, and it is
 * enforced in one function rather than remembered in a comment.
 */
test("the Desktop folder the user works in is refused, whatever is asked", async () => {
  const refused = await closeWindowOn(THE_USERS_DESKTOP_FOLDER);
  assert.equal(refused.closed, false);
  assert.match(refused.because, /the Desktop folder the user works in/);

  /**
   * A trailing slash is the same folder, and the reason matters more than the
   * outcome here.
   *
   * Without stripping it, this still closes nothing, but only because no process
   * happens to have a trailing slash in its command line. On a machine where one
   * did, it would be the user's own Window. So the assertion is on the reason the
   * guard gives, which nothing but the guard can produce.
   */
  const withSlash = await closeWindowOn(`${THE_USERS_DESKTOP_FOLDER}/`);
  assert.equal(withSlash.closed, false);
  assert.match(
    withSlash.because,
    /the Desktop folder the user works in/,
    "it fell through the guard and closed nothing only by luck",
  );
});

test("no Desktop folder named is refused too, because a Window without one is the user's", async () => {
  const refused = await closeWindowOn("");
  assert.equal(refused.closed, false);
  assert.match(refused.because, /a Window without one is the user's own/);
});

test("a folder no Window is running on closes nothing and says so", async () => {
  const nothing = await closeWindowOn("/nowhere/a/window/has/ever/been");
  assert.equal(nothing.closed, false);
  assert.match(nothing.because, /no Window is running on/);
});

/**
 * The narrowness that makes this safe to call at all.
 *
 * Our own commands mention a Desktop folder in their arguments constantly: every
 * `relay prove` line does. If matching were "the folder appears anywhere in the
 * command line", the first thing this would signal is the process asking the
 * question. So a line counts only when it starts with the Claude Desktop
 * executable itself.
 */
test("only the app's own processes on that folder are found, never ours that mention it", () => {
  const proving = anotherDesktopFolder("claude-desktop-relay-proving-desktop");
  const helper = ON_WINDOWS
    ? join(CLAUDE_DESKTOP, "..", "helper.exe")
    : `${CLAUDE_DESKTOP}/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper`;

  const list = [
    aProcessLine(501, { args: [`--user-data-dir=${proving}`] }),
    someoneElsesLine(502, helper, [`--user-data-dir=${proving}`]),
    someoneElsesLine(503, process.execPath, ["scripts/relay.ts", "prove", "--copy-login", proving]),
    someoneElsesLine(504, ON_WINDOWS ? "C:\\Windows\\system32\\cmd.exe" : "/bin/zsh", ["-c", "echo", `--user-data-dir=${proving}`]),
    aProcessLine(505),
  ].join("\n");

  // The app's own main process on that folder, and nothing else. The helper is a
  // different executable, so it is not the app however much it looks like it.
  assert.deepEqual(pidsRunningOn(list, proving), [501]);

  // And the Window with no folder at all, which is the user's own, is never in it.
  assert.deepEqual(pidsRunningOn(list, THE_USERS_DESKTOP_FOLDER), []);
});

test("a Window on its own Desktop folder is one this program may close", () => {
  // Nothing is signalled here: this is the pure half, and it says that such a
  // Window is findable at all, which is what the guarded call then acts on.
  const proving = anotherDesktopFolder("some-other-desktop-folder");
  const list = aProcessLine(777, { args: [`--user-data-dir=${proving}`] });
  assert.deepEqual(pidsRunningOn(list, proving), [777]);
});

/**
 * A Window of its own reads its own Claude Code configuration. ADR 0014.
 *
 * The failure this guards is silent and is the whole reason ADR 0014 exists: a
 * relayed Window that read the shared `~/.claude` would start the user's own MCP
 * servers as children of a relayed session, and every one of them would inherit
 * the relay's address. The Window would look fine until the route blinked.
 */
test("the user's own Desktop folder is told apart from a Window of its own", () => {
  assert.equal(isTheUsersOwnDesktopFolder(THE_USERS_DESKTOP_FOLDER), true);
  // The same folder named with a trailing slash is the same folder. A store
  // written under one spelling would not be found under the other.
  assert.equal(isTheUsersOwnDesktopFolder(`${THE_USERS_DESKTOP_FOLDER}/`), true);
  assert.equal(isTheUsersOwnDesktopFolder(`${THE_USERS_DESKTOP_FOLDER}//`), true);
  // Windows spells one folder several ways and means one folder: the other
  // separator, and any case at all. A store written under one spelling that was
  // not found under another would be a relay that quietly does nothing.
  if (ON_WINDOWS) {
    assert.equal(isTheUsersOwnDesktopFolder(THE_USERS_DESKTOP_FOLDER.replace(/\\/g, "/")), true);
    assert.equal(isTheUsersOwnDesktopFolder(THE_USERS_DESKTOP_FOLDER.toUpperCase()), true);
  }

  assert.equal(isTheUsersOwnDesktopFolder(aWindowUnder(join(tmpdir(), "somewhere", "of", "ours")).appSupport), false);
  assert.equal(isTheUsersOwnDesktopFolder(`${THE_USERS_DESKTOP_FOLDER}-relayed`), false);
  assert.equal(isTheUsersOwnDesktopFolder(join(THE_USERS_DESKTOP_FOLDER, "desktop")), false);
});

test("a Window of its own keeps its Claude Code configuration under its own home", () => {
  const somewhereOfOurs = join(tmpdir(), "somewhere", "of", "ours");
  const home = relayHome(aWindowUnder(somewhereOfOurs));
  assert.equal(home.codeConfigFolder, join(somewhereOfOurs, "code-config"));
  // Never the shared one, which is the mistake worth failing loudly on.
  assert.notEqual(home.codeConfigFolder, join(homedir(), ".claude"));
  assert.ok(home.codeConfigFolder.startsWith(home.folder), "it must live under the home this relay owns");
});

test("the name written for that configuration cannot drift from the name undone", () => {
  assert.deepEqual(codeConfigVariables("/x/code-config"), { CLAUDE_CONFIG_DIR: "/x/code-config" });
  // Derived from the writer, so adding a name to one and not the other is not
  // possible. A variable left behind in somebody's store is for ever.
  assert.deepEqual([...CODE_CONFIG_VARIABLES], Object.keys(codeConfigVariables("")));
  assert.deepEqual([...CODE_CONFIG_VARIABLES], ["CLAUDE_CONFIG_DIR"]);
});

test("that configuration variable round-trips through the app's own store", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "ccd-environment-config.json");
    const store = openEnvironmentStore({ file, lock });

    await store.put({ SOMETHING_THE_USER_SET: "theirs" });
    await store.put(codeConfigVariables("/somewhere/of/ours/code-config"));
    assert.deepEqual(await store.read(), {
      SOMETHING_THE_USER_SET: "theirs",
      CLAUDE_CONFIG_DIR: "/somewhere/of/ours/code-config",
    });

    await store.forget([...CODE_CONFIG_VARIABLES]);
    assert.deepEqual(await store.read(), { SOMETHING_THE_USER_SET: "theirs" });
  });
});

test("an empty home that nobody named says so, rather than blaming the Seats", async (t) => {
  const named = process.env[HOME_VARIABLE];
  t.after(() => {
    if (named === undefined) delete process.env[HOME_VARIABLE];
    else process.env[HOME_VARIABLE] = named;
  });

  // The trap: the default home was never made, the Keychain still holds every
  // token, and every reader reports a folder nobody meant to read.
  delete process.env[HOME_VARIABLE];
  const missing = relayHome(aWindowUnder(join(tmpdir(), "no-such-relay-home-ever")));
  const saying = whyThisHomeLooksEmpty(missing);
  assert.ok(saying !== null);
  assert.match(saying, new RegExp(HOME_VARIABLE));
  assert.match(saying, /no-such-relay-home-ever/);

  // A home named on purpose is answerable for its own emptiness.
  process.env[HOME_VARIABLE] = missing.folder;
  assert.equal(whyThisHomeLooksEmpty(missing), null);

  // So is one that exists.
  delete process.env[HOME_VARIABLE];
  const there = await mkdtemp(join(tmpdir(), "relay-home-"));
  t.after(() => rm(there, { recursive: true, force: true }));
  assert.equal(whyThisHomeLooksEmpty(relayHome(aWindowUnder(there))), null);
});

test("macOS is asked to open the application, not to run the executable", async () => {
  const { openArguments, whatToAdd } = await import("../src/window/index.ts");

  /**
   * The failure this catches, measured 2026-08-26 with the two Windows side by
   * side. A Window we ran ourselves was a child of the launcher, so it stayed
   * inside our launchd job: `XPC_SERVICE_NAME=com.claude-desktop-relay.agent.8980`
   * and no `__CFBundleIdentifier` at all, while the Window the machine started was
   * `application.com.anthropic.claudefordesktop...` under launchd itself. It was
   * never being launched as an application, only executed, and it came up slowly
   * and loaded nothing. `-n` is what the first launcher was missing when it used
   * `open`, and without it macOS activates whatever Claude Desktop is already
   * running instead of starting the profile asked for.
   */
  const args = openArguments({
    bundle: "/Applications/Claude.app",
    variables: { HTTPS_PROXY: "http://127.0.0.1:8980" },
    args: ["--user-data-dir=/Users/x/desktop"],
  });
  assert.deepEqual(args, [
    "-n",
    "-a",
    "/Applications/Claude.app",
    "--env",
    "HTTPS_PROXY=http://127.0.0.1:8980",
    "--args",
    "--user-data-dir=/Users/x/desktop",
  ]);
  assert.equal(args.indexOf("--args") < args.length - 1, true, "what the app is given comes after --args");

  /**
   * And `--env` carries only what is being set on purpose. `open` hands the
   * application the environment `open` itself was run with, measured the same day:
   * a Window opened from a Code session inherited that session's
   * `ANTHROPIC_BASE_URL` and `API_TIMEOUT_MS` without either being named here. So
   * the environment is given to `open` as its own, and this stays the short list.
   */
  assert.deepEqual(whatToAdd({ variables: {} }), {});
});
