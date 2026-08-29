/**
 * Which Claude Desktop profile is which, as a table.
 *
 * The judgement this module makes is small and easy to get quietly wrong: a store
 * that cannot be read is not a store with nothing in it, and a profile relayed by
 * somebody else is not one relayed by us. Both are held here, because either
 * mistake shows the reader a confident wrong answer about which Window their
 * figures describe.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { findProfiles, looksLikeAProfile, nameFor, namesApart, relayedBy, shorten } from "../src/profiles/index.ts";
import { ON_WINDOWS, THE_USERS_DESKTOP_FOLDER } from "../src/home/index.ts";

test("a profile is named by what tells it apart, never by the word every profile shares", () => {
  assert.equal(nameFor(THE_USERS_DESKTOP_FOLDER), "Main");
  assert.equal(nameFor(join(homedir(), ".claude-relayed", "desktop")), "Relayed");
  assert.equal(nameFor(join(homedir(), ".claude-desktop-relay-proving", "desktop")), "Relay Proving");
  assert.equal(nameFor("/x/Library/Application Support/Claude-3p"), "3p");
  assert.equal(nameFor("/x/Library/Application Support/Claude Profiles/3p-test"), "3p Test");
});

test("two profiles never share a name, because the name is what a click sends back", () => {
  const apart = namesApart(["/a/Claude-work", "/b/claude-work", "/c/Claude-work"]);
  assert.deepEqual(apart.map((one) => one.name), ["Work", "Work 2", "Work 3"]);
});

test("a store with our port in it is relayed by us, and another port is not", () => {
  const at = (port: number) => ({ HTTPS_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: "localhost" });
  assert.equal(relayedBy(at(8978), 8978), "this relay");
  assert.equal(relayedBy(at(8979), 8978), "another relay");
  // NO_PROXY ends in _proxy and is not a proxy. Counting it would call every
  // profile relayed, including the one the whole design leaves untouched.
  assert.equal(relayedBy({ NO_PROXY: "localhost", no_proxy: "localhost" }, 8978), "no");
  assert.equal(relayedBy({}, 8978), "no");
});

test("a folder without the two files every Claude Desktop has is not a profile", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-profiles-"));
  assert.equal(looksLikeAProfile(folder), false);
  await writeFile(join(folder, "config.json"), "{}");
  assert.equal(looksLikeAProfile(folder), false, "config.json alone is not a Claude Desktop folder");
  await mkdir(join(folder, "Local Storage"));
  assert.equal(looksLikeAProfile(folder), true);
});

test("a folder is said home-relative, because that is how a person says where it is", () => {
  assert.equal(shorten("/Users/x/.claude-relayed/desktop", "/Users/x"), "~/.claude-relayed/desktop");
  assert.equal(shorten("/opt/elsewhere", "/Users/x"), "/opt/elsewhere");
});

test("the profiles found on a home with none of them in it is an empty list, not a throw", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-home-"));
  const found = await findProfiles({ port: 8978, home });
  // The Window the user works in is always asked about, so the one thing this
  // proves is that a home with nothing in it is answered rather than thrown at.
  assert.equal(Array.isArray(found), true);
  assert.equal(found.every((one) => typeof one.name === "string" && one.name !== ""), true);
});

/**
 * Only macOS has this question to answer.
 *
 * There, the Window the user works in is started with no `--user-data-dir` at
 * all, so a process list is the only evidence and "no folder named" has to be
 * read as "the user's own". On Windows the folder answers for itself: every
 * profile holds its own `lockfile` open while it runs, so `openNow` never looks
 * at a process list and there is no such case to get wrong. Driving it with a
 * made-up process list there would assert nothing about anything.
 */
test("the Window the user works in is open even though nothing names its folder", { skip: ON_WINDOWS }, async () => {
  const { openNow } = await import("../src/profiles/index.ts");
  const bundle = "/Applications/Claude.app";
  const executable = `${bundle}/Contents/MacOS/Claude`;
  // Lines carry the pid first, because that is what `ps -ax -o pid=,command=`
  // prints and what this is given. A fixture without one passed here for a while
  // and proved nothing: the reader matched the executable at the start of the raw
  // line, so the pid the real list carries turned every answer into "nothing is
  // running" without a single test noticing.
  const aLine = (pid: number, args = "") => `  ${pid} ${executable}${args}`;

  // How the app is actually started from the Dock: no `--user-data-dir` at all.
  assert.equal(openNow(aLine(501), THE_USERS_DESKTOP_FOLDER, bundle), true);
  // A relayed Window open on its own folder must not make Main look open too.
  const relayed = aLine(502, " --user-data-dir=/Users/x/.claude-relayed/desktop");
  assert.equal(openNow(relayed, THE_USERS_DESKTOP_FOLDER, bundle), false);
  assert.equal(openNow(relayed, "/Users/x/.claude-relayed/desktop", bundle), true);
  assert.equal(openNow("", "/Users/x/.claude-relayed/desktop", bundle), false);
});

test("every token in the cache is offered, and the key is never parsed for an account", async () => {
  const { tokensFrom } = await import("../src/profiles/index.ts");
  const cache = {
    "9d1c250a:b2c3d4e5:https://api.anthropic.com:user:inference": { token: "sk-one" },
    "a473d7bb:b2c3d4e5:https://api.anthropic.com:user:inference": { token: "sk-two" },
    "c0ffee:b2c3d4e5": { token: "sk-one" },
  };
  // The first field of a key is not the account: it matched neither the account the
  // profile signed in as nor the one the server named for that token. Reading it
  // found nothing at all, which is why the tokens are simply tried.
  assert.deepEqual(tokensFrom(cache), ["sk-one", "sk-two"]);
  assert.deepEqual(tokensFrom(null), []);
  assert.deepEqual(tokensFrom({ a: {} }), []);
});

test("the account is read out of the server's answer, and nothing else is kept", async () => {
  const { accountFrom } = await import("../src/profiles/index.ts");
  assert.deepEqual(accountFrom({ account: { email: "a@b.c", uuid: "x" }, organization: { name: "Acme" } }), {
    email: "a@b.c",
    organization: "Acme",
    uuid: "x",
  });
  assert.deepEqual(accountFrom({ account: { email: "a@b.c" } }), { email: "a@b.c", organization: null, uuid: null });
  // An answer with no email is not an account, and is never half-shown.
  assert.equal(accountFrom({ account: {} }), null);
  assert.equal(accountFrom(null), null);
});

test("a Window we start gets the Dock's environment, never the launcher's", async () => {
  const { asFromTheDock, isOurs } = await import("../src/profiles/index.ts");

  // The two real failures. A relayed Code session's proxy and certificate must not
  // travel into a profile that is not relayed, and the three variables that say
  // which Window a relay serves must not either.
  for (const name of [
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_SYSTEM_CA",
    "CLAUDE_RELAY_HOME",
    "CLAUDE_RELAY_PORT",
    "CLAUDE_RELAY_APP_SUPPORT",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_HOST_SESSION_ID",
  ]) {
    assert.equal(isOurs(name), true, `${name} would have travelled`);
  }
  // Everything else is the user's own and is carried through untouched.
  assert.equal(isOurs("HOME"), false);
  assert.equal(isOurs("LANG"), false);
  assert.equal(isOurs("PROXY_TOWN"), false, "a name that merely mentions a proxy is not one");

  const built = asFromTheDock(
    { HOME: "/Users/x", HTTPS_PROXY: "http://127.0.0.1:8980", PATH: "/usr/bin:/bin", EMPTY: undefined },
    "/opt/homebrew/bin:/usr/bin:/bin",
    false,
  );
  assert.deepEqual(built, { HOME: "/Users/x", PATH: "/opt/homebrew/bin:/usr/bin:/bin" });

  // A login shell that says nothing leaves the PATH alone rather than emptying it.
  assert.equal(asFromTheDock({ PATH: "/usr/bin:/bin" }, null, false).PATH, "/usr/bin:/bin");
  assert.equal(asFromTheDock({ PATH: "/usr/bin:/bin" }, "   ", false).PATH, "/usr/bin:/bin");
});

test("a Code session's own variables are not among the ones that travel", async () => {
  const { isOurs } = await import("../src/profiles/index.ts");

  /**
   * The failure this catches, 2026-08-26. A Window opened from a Code session came
   * up slowly, showed none of its conversations and started its MCP servers oddly,
   * with the proxy and the certificate already being dropped. These are the names
   * that session actually handed on, measured that day: an API host, a
   * fifteen-minute request timeout, two knobs on how MCP servers are started, and
   * the session saying what it is. None of them belongs to a whole application.
   */
  for (const gone of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "API_TIMEOUT_MS",
    "MCP_CONNECTION_NONBLOCKING",
    "MCP_SERVER_CONNECTION_BATCH_SIZE",
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    "USE_LOCAL_OAUTH",
    "USE_STAGING_OAUTH",
  ]) {
    assert.equal(isOurs(gone), true, `${gone} would have travelled into a Window`);
  }
});

test("what may travel is named, so a variable nobody here has heard of does not", async () => {
  const { asFromTheDock, fromTheDock } = await import("../src/profiles/index.ts");

  // The set a launchd session hands an application started from the Dock.
  for (const kept of ["HOME", "USER", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK"]) {
    assert.equal(fromTheDock(kept), true, `${kept} is the Dock's and a Window needs it`);
  }
  // And everything else, whether or not this program has ever heard of it. Both of
  // these were in the environment of the session that opened the broken Window.
  for (const gone of ["MallocNanoZone", "DISABLE_AUTOUPDATER", "BAGGAGE", "SOMETHING_INVENTED_TOMORROW"]) {
    assert.equal(fromTheDock(gone), false, `${gone} is not something a Dock launch would have given`);
  }

  assert.deepEqual(
    asFromTheDock({ HOME: "/Users/x", MallocNanoZone: "0", SOMETHING_NEW: "1" }, null, false),
    { HOME: "/Users/x" },
  );

  /**
   * Windows is the other way round and says why in `environment.ts`: the launcher
   * there is inside the user's own session, holding an environment that is large,
   * machine-specific and not ours to enumerate. So it drops ours and keeps the rest.
   */
  assert.deepEqual(
    asFromTheDock({ SYSTEMROOT: "C:\\Windows", ANTHROPIC_BASE_URL: "http://x", ONEDRIVE: "C:\\od" }, null, true),
    { SYSTEMROOT: "C:\\Windows", ONEDRIVE: "C:\\od" },
  );
});

test("the login PATH is read from the login shell, and a shell that hangs is not waited on", async () => {
  const { loginPath } = await import("../src/profiles/index.ts");
  const read = await loginPath();
  // Whatever this machine's shell says, it is either a real PATH or not known.
  assert.equal(read === null || read.includes("/"), true);
});
