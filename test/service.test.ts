import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  launchdService,
  plistFor,
  serviceLabelFor,
  startupItemService,
  SERVICE_LABEL,
  type Ran,
  type Run,
  type ServicePlan,
} from "../src/service/index.ts";
import { ON_WINDOWS } from "../src/home/index.ts";

const PLAN: ServicePlan = {
  label: SERVICE_LABEL,
  node: "/opt/homebrew/bin/node",
  script: "/Users/someone/relay/scripts/serve.ts",
  args: ["--port", "8978"],
  workingDirectory: "/Users/someone/relay",
  logFile: "/Users/someone/.claude-desktop-relay/relay.log",
};

/** Records what would have been run, so no test reaches the real launchd. */
/**
 * A launchctl that behaves like the real one, which matters more than it sounds.
 *
 * The first version answered zero to everything, including `print`. That made it
 * impossible to write the test for the bug of 2026-08-22: `bootout` returns before
 * launchd has finished unloading, so bootstrapping straight afterwards fails with
 * `Bootstrap failed: 5: Input/output error` and leaves the machine with no relay at
 * all. A double that says "yes" to every question cannot show that.
 *
 * So this one has the one piece of state that matters: whether the job is loaded.
 * `print` fails when it is not, exactly as the real one does, and `unloadsAfter`
 * makes the unload take a few polls so the waiting is what is being tested.
 */
function aFakeLaunchctl(
  options: {
    /** Answers to override, by the launchctl subcommand. */
    readonly answers?: Readonly<Record<string, Ran>>;
    /** How many `print` calls a bootout takes to actually take effect. */
    readonly unloadsAfter?: number;
    /** Start out with the job already loaded, as a reinstall finds it. */
    readonly loaded?: boolean;
  } = {},
) {
  const asked: string[][] = [];
  let loaded = options.loaded ?? false;
  let unloading = 0;

  const run = async (command: string, args: readonly string[]): Promise<Ran> => {
    asked.push([command, ...args]);
    const said = options.answers?.[args[0] ?? ""];
    if (said !== undefined) return said;

    switch (args[0]) {
      case "bootout":
        unloading = options.unloadsAfter ?? 0;
        if (unloading === 0) loaded = false;
        return { code: 0, out: "" };
      case "bootstrap":
        // The real one refuses while the old job is still there, which is the
        // whole bug: it must not be reached until the unload has taken.
        if (loaded) return { code: 5, out: "Bootstrap failed: 5: Input/output error" };
        loaded = true;
        return { code: 0, out: "" };
      case "print":
        if (unloading > 0 && --unloading === 0) loaded = false;
        return loaded ? { code: 0, out: "\tpid = 4242\n" } : { code: 1, out: "Could not find service" };
      default:
        return { code: 0, out: "" };
    }
  };

  return { asked, run, isLoaded: () => loaded };
}

async function inTemporaryFolder<T>(run: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "relay-service-"));
  try {
    return await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("the job comes back after a reboot and after it dies", () => {
  const written = plistFor(PLAN);

  // These two are the whole reason the service exists: the store names a fixed
  // address, so something has to be listening there without anyone starting it.
  assert.match(written, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(written, /<key>KeepAlive<\/key><true\/>/);
});

test("the job's environment is explicit, so it never depends on a shell's PATH", () => {
  const written = plistFor(PLAN);

  assert.match(written, /<string>\/opt\/homebrew\/bin\/node<\/string>/, "node is named absolutely");
  assert.match(written, /<string>\/Users\/someone\/relay\/scripts\/serve\.ts<\/string>/);
  assert.ok(!/<key>EnvironmentVariables<\/key>/.test(written), "nothing is inherited or assumed");

  for (const path of [PLAN.node, PLAN.script, PLAN.workingDirectory, PLAN.logFile]) {
    assert.ok(path.startsWith("/"), `${path} must be absolute`);
  }
});

test("a path with characters that would break the file is escaped", () => {
  const written = plistFor({ ...PLAN, workingDirectory: `/Users/someone/a & b <c>` });

  assert.match(written, /a &amp; b &lt;c&gt;/);
  assert.ok(!/a & b <c>/.test(written), "raw characters would make it unreadable to launchd");
});

test("installing writes the job under the user's own home and asks launchd to take it", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "agent.plist");
    const launchctl = aFakeLaunchctl();
    const service = launchdService({ plan: PLAN, plistFile: file, run: launchctl.run, uid: 501 });

    await service.install();

    assert.equal(await readFile(file, "utf8"), plistFor(PLAN));
    // Windows reports one mode for every file whatever was asked for, so this
    // asserts nothing there. What carries on both is where the file went, which
    // is the line above and the folder this test wrote into.
    if (!ON_WINDOWS) assert.equal((await stat(file)).mode & 0o777, 0o644);

    // Booted out first, so installing twice replaces the job instead of failing,
    // and the job is proved running afterwards rather than assumed.
    const verbs = launchctl.asked.map(([, verb]) => verb);
    assert.equal(verbs[0], "bootout");
    assert.equal(verbs.includes("bootstrap"), true);
    assert.equal(verbs.indexOf("print") < verbs.indexOf("bootstrap"), true, "it bootstrapped without waiting");
    assert.equal(verbs[verbs.length - 1], "print", "it did not check the job actually came up");
    assert.equal(launchctl.isLoaded(), true);
  });
});

test("installing without administrator rights is the only way it is done", async () => {
  await inTemporaryFolder(async (folder) => {
    const launchctl = aFakeLaunchctl();
    const service = launchdService({
      plan: PLAN,
      plistFile: join(folder, "agent.plist"),
      run: launchctl.run,
      uid: 501,
    });

    await service.install();
    await service.uninstall();

    const everything = launchctl.asked.flat().join(" ");
    assert.ok(!/sudo|launchctl load -w \/Library|system\//.test(everything), everything);
    for (const asked of launchctl.asked) assert.equal(asked[0], "launchctl");
    assert.ok(
      launchctl.asked.every((asked) => asked.every((word) => !word.startsWith("/Library/"))),
      "nothing outside the user's own home",
    );
  });
});

test("launchd refusing the job is an error, not a quiet success", async () => {
  await inTemporaryFolder(async (folder) => {
    const launchctl = aFakeLaunchctl({ answers: { bootstrap: { code: 5, out: "Input/output error" } } });
    const service = launchdService({
      plan: PLAN,
      plistFile: join(folder, "agent.plist"),
      run: launchctl.run,
      uid: 501,
    });

    await assert.rejects(() => service.install(), /launchd would not take the job.*Input\/output error/);
  });
});

test("removing it takes the job away and leaves no file, and doing it twice is fine", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "agent.plist");
    const launchctl = aFakeLaunchctl();
    const service = launchdService({ plan: PLAN, plistFile: file, run: launchctl.run, uid: 501 });

    await service.install();
    await service.uninstall();
    await assert.rejects(() => stat(file), "the job description must be gone");

    await service.uninstall();
    assert.equal(launchctl.asked.filter((asked) => asked[1] === "bootout").length, 3);
  });
});

test("status says whether it is installed, whether it is running, and its pid", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "agent.plist");
    // Nothing installed and launchd has never heard of it. No overridden answers:
    // the fake reports a job it has not been given exactly as the real one does.
    const unknown = launchdService({ plan: PLAN, plistFile: file, run: aFakeLaunchctl().run, uid: 501 });
    assert.deepEqual(await unknown.status(), { installed: false, running: false, pid: null });

    // Installed, and launchd says it is up, because installing is what made it so.
    const service = launchdService({ plan: PLAN, plistFile: file, run: aFakeLaunchctl().run, uid: 501 });
    await service.install();
    assert.deepEqual(await service.status(), { installed: true, running: true, pid: 4242 });

    // Installed but not running, which is the case worth telling apart from both
    // of the others: the file is there and nothing is listening.
    const stopped = launchdService({ plan: PLAN, plistFile: file, run: aFakeLaunchctl().run, uid: 501 });
    assert.deepEqual(await stopped.status(), { installed: true, running: false, pid: null });
  });
});

/**
 * macOS only, because the problem is macOS's.
 *
 * launchd shows a background item by the executable it runs, so a job that runs
 * `node` appears to the user as "node". Windows shows the login item by its own
 * file name, which `relay install` already writes as `claude-desktop-relay.vbs`,
 * and a symbolic link there would need rights the user may not have and would buy
 * nothing. The Windows side of this is in `test/windows.test.ts`.
 */
test("the user sees our name in Login Items, not the name of the binary we happen to use", { skip: ON_WINDOWS }, async () => {
  const { nameTheLauncher } = await import("../src/service/index.ts");

  await inTemporaryFolder(async (folder) => {
    const at = join(folder, "bin", "claude-desktop-relay");
    const launcher = await nameTheLauncher({ at, to: process.execPath });

    assert.equal(launcher, at);
    assert.equal(basename(launcher), "claude-desktop-relay", "the file name is the name the user reads");

    // The same binary, not a copy: nothing to keep up to date, and no unsigned
    // duplicate of somebody else's executable.
    const { realpath, lstat } = await import("node:fs/promises");
    assert.equal((await lstat(launcher)).isSymbolicLink(), true);
    assert.equal(await realpath(launcher), await realpath(process.execPath));

    // Running twice must replace the link rather than fail on it.
    await nameTheLauncher({ at, to: process.execPath });

    // And a job built on it shows our name where macOS reads one.
    const written = plistFor({ ...PLAN, node: launcher });
    assert.match(written, /<string>[^<]*\/claude-desktop-relay<\/string>/);
    assert.ok(
      !/<string>[^<]*\/node<\/string>/.test(written),
      "nothing in the job may still point straight at the node binary",
    );
  });
});

test("a relay for a Proving Window is its own launchd job, and carries which Window it serves", () => {
  const written = plistFor({
    label: serviceLabelFor(8979, 8978),
    node: "/opt/node",
    script: "/repo/scripts/serve.ts",
    args: ["8979"],
    workingDirectory: "/repo",
    logFile: "/proving/service.log",
    environment: { CLAUDE_RELAY_HOME: "/proving", CLAUDE_RELAY_PORT: "8979", CLAUDE_RELAY_APP_SUPPORT: "/proving/app" },
  });

  // launchd keys everything by the label. Two relays sharing one would be one
  // job, and installing the second would silently stop the first: the Window the
  // user works in would lose its relay the moment a Proving Window was set up.
  // Derived from the one place that names it, because the two machines list
  // background jobs by different conventions and the rule is about the keying
  // rather than about the spelling.
  assert.match(written, new RegExp(`<key>Label</key><string>${SERVICE_LABEL}\.8979</string>`));
  assert.equal(serviceLabelFor(8978, 8978), SERVICE_LABEL, "the ordinary case keeps the plain label");
  assert.notEqual(serviceLabelFor(8979, 8978), SERVICE_LABEL, "and a second relay is never the same job");

  // A launchd job gets no login shell and no environment of ours, so a job that
  // did not carry these would start up serving the Window the user works in: same
  // port, same Desktop folder, same home. Silent, and awful.
  assert.match(written, /<key>CLAUDE_RELAY_HOME<\/key><string>\/proving<\/string>/);
  assert.match(written, /<key>CLAUDE_RELAY_APP_SUPPORT<\/key><string>\/proving\/app<\/string>/);
});

test("a job with nothing to hand over carries no environment block at all", () => {
  const written = plistFor({
    label: "com.example",
    node: "/opt/node",
    script: "/s.ts",
    args: [],
    workingDirectory: "/repo",
    logFile: "/l",
  });
  assert.equal(written.includes("EnvironmentVariables"), false);
});

/**
 * The service's own log has to stay empty in ordinary life.
 *
 * When both streams went to it, it held the relay's two ordinary startup lines, and
 * `relay doctor` read those bytes as "the relay could not start" and reported a
 * perfectly healthy service as broken. Caught by running the doctor against a real
 * Proving Window on 2026-08-22, which is the sort of thing only real traffic finds.
 */
test("the service captures only its error, so anything in that file is a diagnosis", () => {
  const written = plistFor({
    label: "com.example",
    node: "/opt/node",
    script: "/repo/scripts/serve.ts",
    args: [],
    workingDirectory: "/repo",
    logFile: "/home/me/service.log",
    outFile: "/dev/null",
  });

  assert.match(written, /<key>StandardErrorPath<\/key><string>\/home\/me\/service\.log<\/string>/);
  assert.match(written, /<key>StandardOutPath<\/key><string>\/dev\/null<\/string>/);
});

test("a job that names no separate output path sends both to the one file", () => {
  const written = plistFor({
    label: "com.example",
    node: "/opt/node",
    script: "/s.ts",
    args: [],
    workingDirectory: "/repo",
    logFile: "/home/me/both.log",
  });

  assert.match(written, /<key>StandardOutPath<\/key><string>\/home\/me\/both\.log<\/string>/);
  assert.match(written, /<key>StandardErrorPath<\/key><string>\/home\/me\/both\.log<\/string>/);
});

/**
 * Reinstalling over a running job, which is the ordinary case and was broken.
 *
 * `bootout` returns before launchd has finished unloading, so bootstrapping
 * straight afterwards hits a job that is still there and fails with
 * `Bootstrap failed: 5: Input/output error`. Measured on 2026-08-22 by running
 * `relay prove --set-up` twice: the install threw, and left the machine booted out
 * with no relay listening at all, which is the worst of the three outcomes. Remove
 * the wait in `install` and this goes red.
 */
test("reinstalling over a job that is already loaded waits for the unload, and comes up", async () => {
  await inTemporaryFolder(async (folder) => {
    // Loaded already, and slow to unload, which is what a real machine does.
    const launchctl = aFakeLaunchctl({ loaded: true, unloadsAfter: 3 });
    const service = launchdService({
      plan: PLAN,
      plistFile: join(folder, "agent.plist"),
      run: launchctl.run,
      uid: 501,
    });

    await service.install();

    assert.equal(launchctl.isLoaded(), true, "the job was left booted out");
    assert.deepEqual(await service.status(), { installed: true, running: true, pid: 4242 });
  });
});

test("a job launchd takes but never runs is an error naming where the reason is", async () => {
  await inTemporaryFolder(async (folder) => {
    // Accepted, and then never up: the shape of a bad node path or a syntax error.
    const launchctl = aFakeLaunchctl({
      answers: { bootstrap: { code: 0, out: "" }, print: { code: 113, out: "Could not find service" } },
    });
    const service = launchdService({
      plan: PLAN,
      plistFile: join(folder, "agent.plist"),
      run: launchctl.run,
      uid: 501,
    });

    // A zero from bootstrap says launchd accepted the job description, not that
    // anything is running. Saying "the relay is a service now" on the strength of
    // that is the claim this repository exists not to make.
    await assert.rejects(service.install(), new RegExp(PLAN.logFile.replace(/[/.]/g, "\\$&")));
  });
});

/**
 * Uninstalling one Window's relay, on a machine that is running two.
 *
 * The Windows service has no launchd to key the job by its label, so it finds its
 * own processes by reading every command line and matching. It matched on
 * `serve.ts` alone, which every relay on the machine is running, so
 * `relay uninstall` in a Proving Window signalled the relay of the Window the user
 * was working in as well. ADR 0012 is the invariant this breaks: a second Window
 * never disturbs the first.
 *
 * Driven through the `run` seam, so nothing here asks a real machine anything and
 * the test runs on both. `process.kill` is stood in for over the one call, because
 * what is being proved is which process ids would be signalled.
 */
test("uninstalling one Window's relay leaves the other Window's relay running", async () => {
  await inTemporaryFolder(async (folder) => {
    const itemFor = (port: number) => join(folder, `com.example.${port}.vbs`);
    const planFor = (port: number): ServicePlan => ({
      label: `com.example.${port}`,
      node: "C:\\Program Files\\nodejs\\node.exe",
      script: "C:\\repo\\scripts\\serve.ts",
      args: [String(port)],
      workingDirectory: "C:\\repo",
      logFile: "C:\\home\\service.log",
    });

    // What Get-CimInstance answers on a machine with both Windows up: each relay
    // has a script host supervising it and a node running it, and all four command
    // lines name the same `serve.ts`.
    const listing = [
      `4001\t"C:\\Windows\\System32\\wscript.exe" "${itemFor(8978)}"`,
      `4002\t"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\scripts\\serve.ts" "8978"`,
      `4003\t"C:\\Windows\\System32\\wscript.exe" "${itemFor(8980)}"`,
      `4004\t"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\scripts\\serve.ts" "8980"`,
    ].join("\r\n");

    const run: Run = async () => ({ code: 0, out: listing });

    const signalled: number[] = [];
    const realKill = process.kill.bind(process);
    process.kill = ((pid: number) => {
      signalled.push(pid);
      return true;
    }) as typeof process.kill;

    try {
      await startupItemService({ plan: planFor(8980), itemFile: itemFor(8980), run }).uninstall();
    } finally {
      process.kill = realKill;
    }

    // Both halves of the Proving Window's own relay: the supervisor first, and the
    // relay it started, because stopping only one of them leaves the other doing
    // the one thing it exists to do.
    assert.deepEqual(
      [...signalled].sort((a, b) => a - b),
      [4003, 4004],
    );

    // The line that matters. Before the fix this held 4002 as well, and the user's
    // own relay went down every time a Proving Window was taken away.
    assert.ok(!signalled.includes(4002), "the other Window's relay was signalled");
    assert.ok(!signalled.includes(4001), "the other Window's supervisor was signalled");
  });
});
