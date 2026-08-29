import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  environmentForAMint,
  linkIn,
  mintOneToken,
  stripDressing,
  tokenIn,
  underATerminal,
  WHAT_MAY_PASS,
  withTheTokenHidden,
  type MintOutcome,
  type OpenATerminal,
} from "../src/minting/index.ts";

const BEHAVING = fileURLToPath(new URL("./helpers/a-setup-token-that-behaves.ts", import.meta.url));
const TOKEN = "sk-ant-oat01-a-token-that-only-a-test-ever-sees";

/** A pty and a real program, so what is proved is the driving and not a stub. */
async function drive(
  behave: string,
  extra: {
    link?: (url: string) => Promise<void>;
    ceilingMs?: number;
    heard?: (line: string) => void;
  } = {},
): Promise<{ outcome: MintOutcome; links: string[]; said: string[] }> {
  const folder = await mkdtemp(join(tmpdir(), "relay-mint-"));
  const links: string[] = [];
  const said: string[] = [];

  try {
    const outcome = await mintOneToken({
      folder,
      // How it behaves is an argument, because the child's environment is an
      // allowlist and a test that had to reach through it would be testing a
      // hole rather than the flow.
      command: ["node", BEHAVING, behave],
      // Seconds, not ten minutes: every case here either finishes at once or is
      // meant to hit its ceiling, and a suite may not sit waiting on either.
      ceilingMs: extra.ceilingMs ?? 15_000,
      heard: (line) => {
        said.push(line);
        extra.heard?.(line);
      },
      link: async (url) => {
        links.push(url);
        await extra.link?.(url);
      },
    });
    return { outcome, links, said };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * The measurement this whole module exists for: piped stdio gets zero bytes from
 * the real `claude setup-token`. If the driving stopped giving the child a real
 * terminal, every other test here would still pass on a program that does not
 * care, so one of them cares.
 */
test("the child gets a real terminal, so a program that only speaks to one speaks", async () => {
  const { outcome } = await drive("only-if-a-terminal");
  assert.deepEqual(outcome, { kind: "minted", token: TOKEN });
});

test("the link is handed over the moment it is said, before there is any token", async () => {
  const { outcome, links } = await drive("prints-the-token");
  assert.equal(outcome.kind, "minted");
  assert.equal(links.length, 1);
  assert.match(links[0] ?? "", /^https:\/\/claude\.ai\/oauth\/authorize\?/);
});

/**
 * A link is about four hundred characters and a terminal eighty wide would wrap
 * it. A wrapped address arrives with a newline in the middle that cannot be told
 * from one the program meant, so this is prevented rather than repaired.
 */
test("a link four hundred characters long arrives whole, not wrapped", async () => {
  const { links } = await drive("prints-the-token");
  const link = links[0] ?? "";
  assert.ok(link.length > 300, `the link was only ${link.length} characters`);
  assert.ok(link.endsWith("S".repeat(43)), "the end of the link was lost");
  assert.ok(!link.includes("\n"));
});

test("the token comes back and is never said out loud", async () => {
  const { outcome, said: heard } = await drive("prints-the-token");
  assert.deepEqual(outcome, { kind: "minted", token: TOKEN });
  assert.ok(heard.length > 0, "nothing was heard at all");
  for (const line of heard) assert.ok(!line.includes(TOKEN), `the token was said out loud: ${line}`);
  assert.ok(heard.some((line) => line.includes("sk-ant-oat...(hidden)")));
});



test("a child that says nothing at all is nothing, with a reason rather than a hang", async () => {
  const { outcome } = await drive("says-nothing");
  assert.equal(outcome.kind, "nothing");
  assert.match(outcome.kind === "nothing" ? outcome.because : "", /said nothing at all/);
});

test("a child that fails is reported in its own words", async () => {
  const { outcome } = await drive("fails");
  assert.equal(outcome.kind, "nothing");
  assert.match(outcome.kind === "nothing" ? outcome.because : "", /authorization server/);
});

/**
 * Every wait here has a ceiling, and this is the one that matters: a mint waits on
 * a person in a browser, so the run that never finishes is the ordinary failure
 * rather than the exotic one.
 */
test("a mint that never finishes is ended at its ceiling and says so", async () => {
  const started = Date.now();
  const { outcome } = await drive("never-finishes", { ceilingMs: 1_500 });
  assert.equal(outcome.kind, "nothing");
  assert.match(outcome.kind === "nothing" ? outcome.because : "", /did not finish within/);
  assert.ok(Date.now() - started < 12_000, "it waited far past its ceiling");
});

// ---- reading what a terminal said ------------------------------------------

test("colour, cursor moves and a clickable link are taken out before anything is read", () => {
  const ESC = "\u001b";
  const BEL = "\u0007";
  const dressed =
    `${ESC}[2K${ESC}[1;32mSuccess${ESC}[0m\r\n` +
    `${ESC}]8;;https://claude.ai/oauth/authorize?a=1${BEL}click here${ESC}]8;;${BEL}\r\n`;
  const clean = stripDressing(dressed);
  assert.equal(clean, "Success\nclick here\n");
  assert.equal(clean.includes(ESC), false);
});

test("an address that is not claude.ai's own authorize page is not the link", () => {
  assert.equal(linkIn("See https://docs.anthropic.com/setup-token for help\n"), null);
  assert.equal(linkIn("Visit https://claude.ai/settings/profile now\n"), null);
  assert.equal(
    linkIn("go to https://claude.ai/oauth/authorize?code=true&x=1 please"),
    "https://claude.ai/oauth/authorize?code=true&x=1",
  );
});

test("a run that says the token twice yields one token, the last one", () => {
  const said = `first ${TOKEN}\nand again ${TOKEN}\n`;
  assert.equal(tokenIn(said), TOKEN);
});

test("something that merely looks like a token is not one", () => {
  assert.equal(tokenIn("sk-ant-oat\n"), null);
  assert.equal(tokenIn("sk-ant-sid01-a-stats-login-not-a-send-token\n"), null);
  assert.equal(tokenIn("sk-ant-api03-an-api-key-that-cannot-pay\n"), null);
});

test("a token is hidden wherever it turns up in a line meant for a screen", () => {
  assert.equal(withTheTokenHidden(`your token is ${TOKEN} keep it`), "your token is sk-ant-oat...(hidden) keep it");
});


// ---- the ways this could fail open, each held shut by a test ----------------

/**
 * Output arrives in chunks of about a kilobyte and a token sits a hundred
 * characters into its line, so a read landing in the middle of one is ordinary.
 * Taking the first half would put a stub in the Keychain, kill the child, and lose
 * the real token for good: a mint cannot be repeated without another sign-in.
 */
test("half a token that has only half arrived is not a token", () => {
  const half = "Your token is:\nsk-ant-oat01-a-real-look";
  assert.equal(tokenIn(half), null);

  const whole = `${half}ing-token-ABCDEFGHIJ\n`;
  assert.equal(tokenIn(whole), "sk-ant-oat01-a-real-looking-token-ABCDEFGHIJ");
});

test("a token at the very end counts once the run is over and nothing more is coming", () => {
  const atTheEnd = "Your token is:\nsk-ant-oat01-a-real-looking-token-ABCDEFGHIJ";
  assert.equal(tokenIn(atTheEnd), null);
  assert.equal(tokenIn(atTheEnd, { theTextIsComplete: true }), "sk-ant-oat01-a-real-looking-token-ABCDEFGHIJ");
});

/**
 * A reset sequence inside a token is invisible on screen, so hiding the raw bytes
 * would let a person read the whole thing off their own terminal.
 */
test("a token with an escape sequence inside it is still hidden", () => {
  const inside = `sk-ant-oat01-abcdefghij\u001b[0mklmnopqrstuvwxyz`;
  assert.equal(withTheTokenHidden(stripDressing(inside)), "sk-ant-oat...(hidden)");
});

/**
 * Nothing is ever typed into the child. `claude setup-token` runs a callback on
 * this machine and finishes on its own the moment the browser reaches it; the
 * "Paste code here if prompted" line beside it is a fallback for when that
 * callback does not arrive. Answering it unconditionally is what turned a working
 * flow into one that sat waiting for a code nobody needed to give.
 */
test("a prompt the child leaves on screen is left alone, and nothing is typed", async () => {
  const { outcome } = await drive("masks-the-code", { ceilingMs: 2_000 });
  assert.equal(outcome.kind, "nothing");
});



/**
 * Claude Desktop hands a Code session a Send token as `CLAUDE_CODE_OAUTH_TOKEN`,
 * and that variable outranks the stored login. A mint that inherited one would
 * authorize as whichever Seat that token belongs to, and the Probe would report it
 * as a browser profile mistake.
 */
test("a credential in this process's environment does not reach the mint", async () => {
  const was = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-somebody-elses-seat-entirely";
  try {
    const { said } = await drive("says-what-it-holds", { ceilingMs: 8_000 });
    assert.ok(said.includes("CLAUDE_CODE_OAUTH_TOKEN=(unset)"), said.join(" | "));
    assert.ok(said.includes("ANTHROPIC_API_KEY=(unset)"));
    assert.ok(said.includes("ANTHROPIC_BASE_URL=(unset)"));
    // Set, and to an absolute path, which is the whole reason a mint is safe to
    // run: without it `claude setup-token` writes into the machine's own
    // `~/.claude`. Absolute is spelled differently on the two machines, so what is
    // asserted is that it is named and that it is not relative.
    const configured = said.find((line) => line.startsWith("CLAUDE_CONFIG_DIR="))?.slice("CLAUDE_CONFIG_DIR=".length);
    assert.ok(configured !== undefined && configured !== "(unset)", said.join(" | "));
    assert.ok(isAbsolute(configured), `${configured} is not an absolute path`);
    // BROWSER is not set: `claude` opens the link itself, in whichever profile
    // the browser puts in front, and the announcement says which that should be.
    assert.ok(said.includes("BROWSER=(unset)"));
  } finally {
    if (was === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = was;
  }
});

test("what a mint may inherit is a named list, so a new variable arrives absent", () => {
  const env = environmentForAMint({
    from: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "no", SOMETHING_NEW: "also no", HTTPS_PROXY: "http://p:1" },
    configFolder: "/somewhere/mint/a-seat",
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://p:1",
    CLAUDE_CONFIG_DIR: "/somewhere/mint/a-seat",
  });
  // ADR 0011: a machine that names a proxy names it for the mint too.
  assert.ok(WHAT_MAY_PASS.includes("HTTPS_PROXY"));
  assert.ok(!WHAT_MAY_PASS.includes("CLAUDE_CODE_OAUTH_TOKEN"));
});

/**
 * Opening a browser profile is the callback most likely to fail, and the driver
 * has no timeout of its own, so a throw that got out of here would leave expect
 * and `claude` running for ever.
 */
test("a caller's own callback throwing still ends the run", async () => {
  let stopped: string | null = null;
  let typed = false;

  const pretend: OpenATerminal = ({ onSaid }) => {
    setTimeout(() => onSaid("visit https://claude.ai/oauth/authorize?code=true\n"), 10);
    return {
      type: () => void (typed = true),
      stop: (because) => void (stopped = because),
      finished: new Promise(() => {}),
    };
  };

  await assert.rejects(
    mintOneToken({
      folder: "/nowhere",
      openATerminal: pretend,
      command: ["true"],
      ceilingMs: 5_000,
      link: async () => {
        throw new Error("no browser profile for that Seat");
      },
    }),
    /no browser profile/,
  );
  assert.equal(typed, false);
  assert.equal(stopped, "something went wrong on this side");
});

/**
 * The ceiling branch ends by waiting for the run to be over. A kill that did not
 * land would turn the ceiling itself into an endless wait, which is the one thing
 * a ceiling exists to prevent.
 */
test("a session that will not die is given up on rather than waited for", async () => {
  const pretend: OpenATerminal = ({ onSaid }) => {
    setTimeout(() => onSaid("working away\n"), 10);
    return { type: () => {}, stop: () => {}, finished: new Promise(() => {}) };
  };

  const started = Date.now();
  const outcome = await mintOneToken({
    folder: "/nowhere",
    openATerminal: pretend,
    command: ["true"],
    ceilingMs: 500,
    link: async () => {},
  });

  assert.equal(outcome.kind, "nothing");
  assert.ok(Date.now() - started < 8_000, `it waited ${Date.now() - started}ms`);
});

test("a command with a newline in it is refused rather than split in two", () => {
  assert.throws(
    () => underATerminal({ command: ["claude", "setup\ntoken"], env: {}, onSaid: () => {} }),
    /cannot contain a newline/,
  );
});

/**
 * The order of the two matters and it had it the wrong way round. A colour reset
 * inside a token is invisible on a screen and splits the literal in two, so
 * hiding the raw bytes matches neither half and the terminal renders the whole
 * credential into the scrollback.
 */
test("a token broken up by a colour code is still hidden from a watcher", async () => {
  const ESC = "\u001b";
  const said: string[] = [];
  const pretend: OpenATerminal = ({ onSaid }) => {
    setTimeout(() => onSaid(`Your token is sk-ant-oat01-abcdefghij${ESC}[0mklmnopqrstuvwxyz here\n`), 5);
    return { type: () => {}, stop: () => {}, finished: new Promise(() => {}) };
  };

  await mintOneToken({
    folder: "/nowhere",
    openATerminal: pretend,
    command: ["true"],
    ceilingMs: 800,
    link: async () => {},
    heard: (line) => said.push(line),
  });

  assert.ok(said.length > 0);
  for (const line of said) {
    assert.ok(!line.includes("sk-ant-oat01-abcdefghij"), `leaked the head: ${line}`);
    assert.ok(!line.includes("klmnopqrstuvwxyz"), `leaked the tail: ${line}`);
  }
  assert.ok(said.some((line) => line.includes("sk-ant-oat...(hidden)")));
});


/**
 * The host moved. On 2026-08-23 the link was on `claude.ai/oauth/authorize`; the
 * real run on 2026-08-24 printed `claude.com/cai/oauth/authorize`, nothing
 * recognised it, no browser profile was opened and the sitting stalled.
 */
test("an authorize link is recognised on either host, and under any path", () => {
  for (const url of [
    "https://claude.ai/oauth/authorize?code=true&x=1",
    "https://claude.com/cai/oauth/authorize?code=true&x=1",
    "https://claude.com/oauth/authorize?code=true&x=1",
  ]) {
    assert.equal(linkIn(`Browser didn't open? Use the url below\n${url}\n`), url);
  }
  assert.equal(linkIn("See https://docs.anthropic.com/setup-token for help\n"), null);
  assert.equal(linkIn("Visit https://claude.ai/settings/profile now\n"), null);
});
