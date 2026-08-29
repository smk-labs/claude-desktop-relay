import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";

/** Whether a path is there, without caring why not. */
const there = (path: string) => access(path).then(() => true, () => false);

import { HOME_VARIABLE, ON_WINDOWS, aWindowUnder, relayHome } from "../src/home/index.ts";
import { judge, openVerdictLog } from "../src/verify/index.ts";
import { readJsonFile, writeJsonFile } from "../src/json-file/index.ts";
import type { Exchange } from "../src/relay/index.ts";
import { LIKE_CODE } from "./helpers/a-decision.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run one of our commands as its own process, pointed at a home of its own. */
function run(
  script: string,
  home: string,
  ...args: Array<string | { stdin: string }>
): Promise<{ code: number; out: string }> {
  const fed = args.find((one): one is { stdin: string } => typeof one !== "string");
  const flags = args.filter((one): one is string => typeof one === "string");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repoRoot, "scripts", script), ...flags], {
      env: { ...process.env, [HOME_VARIABLE]: home },
      stdio: [fed === undefined ? "ignore" : "pipe", "pipe", "pipe"] as ["ignore" | "pipe", "pipe", "pipe"],
    });
    if (fed !== undefined) child.stdin?.end(fed.stdin);
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

function anExchange(over: Partial<Exchange> = {}): Exchange {
  return {
    method: "POST",
    path: "/v1/messages",
    status: 200,
    refused: false,
    swapped: true,
    chargedTo: { seat: "work", organizationId: "org-acme-1a2b" },
    paidBy: "org-acme-1a2b",
    about: LIKE_CODE,
    utilization: { fiveHour: null, sevenDay: null },
    overage: { status: null, disabledReason: null },
    resets: { fiveHour: null, sevenDay: null },
    replyHeaders: {},
    ...over,
  };
}

const CHOSEN = { seat: "work", organization: { id: "org-acme-1a2b", label: "Acme" } };

test("the verdict command exits zero on a verified swap and non-zero on anything less", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-home-"));
  try {
    const nothingYet = await run("relay.ts", home, "verdict");
    assert.notEqual(nothingYet.code, 0, "with nothing judged it must not claim success");
    // Nothing has been picked, so the Mode is Off, and saying "nothing judged
    // yet" would leave the user wondering what went wrong when nothing did.
    assert.match(nothingYet.out, /Off: nothing is being swapped/);

    const log = openVerdictLog({ file: relayHome(aWindowUnder(home)).verdictFile });

    await log.record(judge(anExchange()));
    const verified = await run("relay.ts", home, "verdict");
    assert.equal(verified.code, 0, verified.out);
    assert.match(verified.out, /^verified: /);

    await log.record(judge(anExchange({ paidBy: "org-somebody-else" })));
    const mismatch = await run("relay.ts", home, "verdict");
    assert.notEqual(mismatch.code, 0, "a mismatch must exit non-zero from the command itself");
    assert.match(mismatch.out, /^mismatch: /);
    assert.match(mismatch.out, /org-somebody-else/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the one command lists the Seats, refuses an unknown one, and turns it off, as its own process", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-home-"));
  try {
    // No Seats file, so nothing here goes near the machine's Keychain: the store
    // only asks the vault about Seats it already knows of.
    const shown = await run("relay.ts", home, "seats");
    assert.equal(shown.code, 0, shown.out);
    assert.match(shown.out, /No Seats have been added yet/);

    const refused = await run("relay.ts", home, "use", "nobody");
    assert.notEqual(refused.code, 0, "an unknown Seat must not be accepted quietly");
    assert.match(refused.out, /no Seat called "nobody"/);

    const off = await run("relay.ts", home, "off");
    assert.equal(off.code, 0, off.out);
    assert.match(off.out, /Window account/);

    const nonsense = await run("relay.ts", home, "explode");
    assert.notEqual(nonsense.code, 0, "a command that does not exist must not exit zero");
    assert.match(nonsense.out, /there is no "relay explode"/);
    assert.match(nonsense.out, /relay use <seat>/, "and it has to say what there is instead");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** Two Seats the flow can read without discovering anything or asking the Keychain. */
const A_WORKLIST = {
  discoveredAt: "2026-08-21T00:00:00.000Z",
  seats: [
    {
      name: "ana-acme-a1b2",
      account: "ana@example.com",
      organization: { id: "a1b2c3d4-0000-4000-8000-000000000001", label: "Acme" },
      multiplier: 6.25,
    },
    {
      name: "bo-own-c3d4",
      account: "bo@example.com",
      organization: { id: "c3d4e5f6-0000-4000-8000-000000000003", label: "bo@example.com's Organization" },
      multiplier: 20,
    },
  ],
};

test("the collect command shows the whole Worklist, named, before it asks for anything", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-home-"));
  try {
    // An edited Worklist is honoured rather than discovered again, so this
    // reaches no login, no network and no Keychain.
    await writeJsonFile(relayHome(aWindowUnder(home)).worklistFile, A_WORKLIST);

    const shown = await run("relay.ts", home, "collect-seats", "--list", "--no-check");

    assert.equal(shown.code, 0, shown.out);
    assert.match(shown.out, /bo-own-c3d4\s+20x\s+missing\s+bo@example\.com/);
    assert.match(shown.out, /ana-acme-a1b2\s+6\.25x\s+missing\s+ana@example\.com/);
    // Worth the most first, so a sitting that stops early filled the best Seats.
    assert.ok(
      shown.out.indexOf("bo-own-c3d4") < shown.out.indexOf("ana-acme-a1b2"),
      shown.out,
    );
    assert.match(shown.out, /0 filled, 2 to go/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * The guard that had to exist, found the hard way.
 *
 * Nothing is pasted any more: the flow runs `claude setup-token` itself. That
 * command starts a real authorization against whatever account the browser is
 * signed into, and stopping the process does not take it back. So a run with
 * nobody at the keyboard, which is every run in this suite, must do none of it.
 * Before this guard, this very test reached the real command.
 */
test("the collect command runs nothing at all when nobody is at the keyboard", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-home-"));
  try {
    await writeJsonFile(relayHome(aWindowUnder(home)).worklistFile, A_WORKLIST);

    const tried = await run("relay.ts", home, "collect-seats", "--no-check", { stdin: "" });

    assert.equal(tried.code, 0, tried.out);
    assert.match(tried.out, /needs somebody at the keyboard/);
    assert.match(tried.out, /Filled 0 this sitting/);
    assert.match(tried.out, /Still missing 2/);

    // It still says which account and Organization were coming, because that is
    // worth reading even when nothing runs.
    assert.match(tried.out, /Account\s+bo@example\.com/);

    // Nothing was written, so a run that does nothing leaves the Seats exactly as
    // they were and no folder is left holding a credential.
    assert.equal(await readJsonFile(relayHome(aWindowUnder(home)).seatsFile), null);
    assert.equal(await there(join(home, "mint")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * A name after a flag used to be dropped without a word, so `relay add-seat
 * --no-check some-seat` asked for one Seat and started a sitting over all of
 * them, with only the per-Seat question between the user and an authorization on
 * the wrong account.
 */
test("a Seat named after a flag still means that one Seat, and two names are refused", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-home-"));
  try {
    await writeJsonFile(relayHome(aWindowUnder(home)).worklistFile, A_WORKLIST);

    const one = await run("relay.ts", home, "collect-seats", "--no-check", "ana-acme-a1b2", { stdin: "" });
    assert.equal(one.code, 0, one.out);
    assert.match(one.out, /Account\s+ana@example\.com/);
    assert.doesNotMatch(one.out, /Account\s+bo@example\.com/);
    assert.match(one.out, /1 of 1/);

    const two = await run("relay.ts", home, "collect-seats", "bo-own-c3d4", "ana-acme-a1b2");
    assert.equal(two.code, 1, two.out);
    assert.match(two.out, /Only one Seat can be named at a time/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the collect command never writes a Send token into any file it keeps", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-home-"));
  try {
    await writeJsonFile(relayHome(aWindowUnder(home)).worklistFile, A_WORKLIST);
    await run("relay.ts", home, "collect-seats", "--list", "--no-check");

    for (const file of await readdir(home, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const kept = await readFile(join(file.parentPath, file.name), "utf8");
      assert.doesNotMatch(kept, /sk-ant/, `${file.name} holds something that looks like a credential`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * The case a `finally` misses.
 *
 * `claude setup-token` writes a credential into the folder the flow hands it, so
 * a sitting that ends any way at all has to remove that folder. Pressing Ctrl-C
 * ends the process through a signal, which runs no `finally`, and what would be
 * left behind is the token the user had just minted. So the removal is registered
 * on `exit`, which a signal does reach.
 *
 * A folder left by an earlier run stands in for one the mint just wrote to, and
 * it has to, because a run with nobody at the keyboard mints nothing on purpose.
 * Both endings are checked: an ordinary one, and one cut short by a signal.
 */
test("a folder a mint wrote into is removed on every way out, signal included", async () => {
  /**
   * The signal half is macOS only, and the reason is a fact about Windows rather
   * than a gap here.
   *
   * `process.kill(pid, "SIGINT")` on Windows is documented to end the target
   * unconditionally: there is no signal delivered, so no handler of any kind runs
   * and nothing could clean up. What a person pressing Ctrl-C in a console gets
   * there is a real `SIGINT` the process can hear, and that path is the same code
   * as the ordinary ending below. Asserting the uncatchable case here would be
   * asserting that Windows is macOS.
   *
   * The guarantee that does hold on both, and that is checked below on both, is
   * the one that matters after a run was killed: the folder is gone by the end of
   * the next run, whatever ended the last one.
   */
  const endings = ON_WINDOWS ? (["ordinary"] as const) : (["ordinary", "a signal"] as const);

  for (const ending of endings) {
    const home = await mkdtemp(join(tmpdir(), "relay-home-"));
    try {
      await writeJsonFile(relayHome(aWindowUnder(home)).worklistFile, A_WORKLIST);
      const mintFolder = join(home, "mint", "bo-own-c3d4");
      await mkdir(mintFolder, { recursive: true });
      await writeFile(join(mintFolder, ".credentials.json"), "{}", "utf8");

      const child = spawn(process.execPath, [join(repoRoot, "scripts", "collect-seats.ts"), "--no-check"], {
        env: { ...process.env, [HOME_VARIABLE]: home },
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (ending === "a signal") {
        // Sent as soon as it has said anything, so the signal lands on a process
        // that is still working. If it finished first the removal still has to
        // have happened, so this can be early but never wrong.
        await new Promise<void>((resolve) => {
          child.stdout?.once("data", () => resolve());
          child.once("close", () => resolve());
        });
        child.kill("SIGINT");
      }
      await once(child, "close");

      assert.equal(await there(join(home, "mint")), false, `${mintFolder} survived ${ending}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
