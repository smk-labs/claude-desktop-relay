/**
 * The environment a profile is started with, which is the environment it would
 * have had from the Dock, and never ours.
 *
 * This file exists because of real failures rather than a worry. The launcher's
 * first version handed each Window whatever environment the thing that started it
 * happened to have, and there were two of those, both wrong. Started by the relay
 * service, a Window inherited launchd's bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
 * so every MCP server configured as `npx ...` could not be found at all: the app
 * retried them, said they would not connect, and took a long time doing it.
 * Started from a Claude Code session instead, it inherited that session's own
 * relay: `HTTPS_PROXY` at the relay's port and our certificate in
 * `NODE_EXTRA_CA_CERTS`, which quietly puts a profile that is not relayed behind
 * the relay, with a certificate the profile has no reason to trust.
 *
 * The second version named those variables and dropped them, and that is the shape
 * that failed again on 2026-08-26: a Window opened from a Code session came up
 * slowly, loaded no conversations, and started its MCP servers oddly. A list of
 * names to drop is always one name behind. What a Code session on this machine
 * actually hands on, measured that day, was `ANTHROPIC_BASE_URL`,
 * `API_TIMEOUT_MS=900000`, `MCP_CONNECTION_NONBLOCKING`,
 * `MCP_SERVER_CONNECTION_BATCH_SIZE`, `CLAUDECODE`, `AI_AGENT`,
 * `USE_LOCAL_OAUTH`, `USE_STAGING_OAUTH`, `DISABLE_AUTOUPDATER` and
 * `MallocNanoZone` — an API host, a fifteen-minute request timeout, two knobs on
 * how MCP servers are started, and one on how the process allocates memory. Every
 * symptom the user reported is in that list, and not one of those names was on the
 * list of ours.
 *
 * So it is inverted. What travels is named, and it is the short set a launchd
 * session hands an application started from the Dock. A variable this program has
 * never heard of does not reach a Window, which is the whole meaning of "as from
 * the Dock" and is right by construction rather than right until the next
 * variable.
 *
 * Two rules stand behind it:
 *
 * Nothing of ours travels. A relayed profile is relayed by what is written in its
 * own store (ADR 0009), never by what the launcher was holding, so stripping these
 * cannot un-relay anything: it removes an accident, not a mechanism.
 *
 * `PATH` is the user's login `PATH`, because that is what an MCP server's `npx`,
 * `uv` or `node` is found on. It is read from the login shell once, with a ceiling,
 * and only `PATH` is taken from it: the same files export a proxy for the shell,
 * and a Window started from the Dock has no proxy at all.
 *
 * The shell is asked interactively first. `zsh -lc` reads `.zshenv`, `.zprofile`
 * and `.zlogin` but never `.zshrc`, and `.zshrc` is where this machine puts
 * `~/.npm-global/bin` and `~/.local/bin`, which is exactly where MCP servers live.
 * A shell that will not answer interactively is asked again without it. It is
 * asked from a bare environment as well, because a shell inherits the `PATH` it is
 * started with and prepends to it: asked from inside a Code session it answered
 * with that session's own plugin folders on the front, which is a session's `PATH`
 * wearing a login `PATH`'s name.
 *
 * On Windows the naming is the other way round, and so is this. The launcher there
 * is a login item inside the user's own session, holding the environment Explorer
 * would have given the app, and that environment is large, machine-specific and
 * not ours to enumerate: `SYSTEMROOT`, `APPDATA`, `PROGRAMW6432`, the OneDrive
 * names, whatever an installer added. Naming what may travel would mean naming
 * that, and getting it wrong there breaks an application rather than leaking into
 * one. So Windows drops what is ours and keeps the rest, and the list of ours
 * below is written to cover the same families on both.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { ON_WINDOWS } from "../../home/index.ts";

/**
 * Names that must never reach a Window we start, on either machine.
 *
 * Proxy variables in either case, our certificate, everything a Claude Code
 * session or the CLI sets about itself or about which Window a relay serves, and
 * the variables that steer an API host, a request timeout or how MCP servers are
 * started. A Window is a whole application and decides all of those for itself,
 * out of its own store and its own config.
 */
export function isOurs(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith("_proxy")) return true;
  if (lower === "node_extra_ca_certs" || lower === "node_use_system_ca") return true;
  // Everything Claude's own, however it is spelled: CLAUDECODE, CLAUDE_RELAY_*,
  // CLAUDE_CONFIG_DIR, CLAUDE_CODE_*, CLAUDE_AGENT_*, ANTHROPIC_*.
  if (lower.startsWith("claude") || lower.startsWith("anthropic")) return true;
  if (lower.startsWith("mcp_")) return true;
  if (lower === "api_timeout_ms" || lower === "ai_agent") return true;
  if (lower === "use_local_oauth" || lower === "use_staging_oauth") return true;
  return false;
}

/**
 * The names a launchd session hands an application started from the Dock.
 *
 * Short on purpose. Anything not here is something a person's shell, or the
 * program that happened to start us, put in the environment, and a Window from the
 * Dock would not have had it.
 */
const FROM_THE_DOCK: ReadonlySet<string> = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "TZ",
  "LANG",
  "SSH_AUTH_SOCK",
  "XPC_FLAGS",
  "XPC_SERVICE_NAME",
  "__CF_USER_TEXT_ENCODING",
  // A desktop Linux session, where the app cannot draw at all without them.
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
]);

/** Whether one name is part of that set, including the families spelled with a prefix. */
export function fromTheDock(name: string): boolean {
  if (FROM_THE_DOCK.has(name)) return true;
  return name.startsWith("LC_") || name.startsWith("XDG_");
}

/** The environment above, with `PATH` replaced when a login one was read. */
export function asFromTheDock(
  environment: Readonly<Record<string, string | undefined>>,
  loginPath: string | null,
  onWindows: boolean = ON_WINDOWS,
): Record<string, string> {
  const built: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || isOurs(name)) continue;
    if (!onWindows && !fromTheDock(name)) continue;
    built[name] = value;
  }
  if (loginPath !== null && loginPath.trim() !== "") built.PATH = loginPath.trim();
  return built;
}

/** A login shell has this long to say what `PATH` is, then it is not known. */
const A_SHELL_HAS_THIS_LONG = 5000;

/** What launchd itself starts a session with, and what a login shell builds on. */
const A_BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

let read: Promise<string | null> | null = null;

function askTheShell(shell: string, flags: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const child = spawn(shell, [flags, 'printf %s "$PATH"'], {
      stdio: ["ignore", "pipe", "ignore"],
      // From a bare environment, so what comes back is the login files' own answer
      // and not this process's `PATH` with the login files' additions in front.
      env: {
        HOME: process.env["HOME"] ?? homedir(),
        USER: process.env["USER"] ?? "",
        SHELL: shell,
        TERM: "dumb",
        PATH: A_BARE_PATH,
      },
    });
    let out = "";
    const stop = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, A_SHELL_HAS_THIS_LONG);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => {
      clearTimeout(stop);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(stop);
      resolve(code === 0 && out.includes("/") ? out.trim() : null);
    });
  });
}

/**
 * The user's login `PATH`, read once from their own login shell.
 *
 * Held for the life of the process. It changes when somebody edits their shell
 * files, which is not something a running relay has to notice, and the alternative
 * is a shell started every time a person clicks Open.
 */
export function loginPath(shell: string = process.env["SHELL"] ?? "/bin/zsh"): Promise<string | null> {
  /**
   * Windows has no login shell to ask, and no need to ask one.
   *
   * The whole reason this exists is that a launchd job gets `/usr/bin:/bin` and
   * an MCP server's `npx` is not on it. A Windows login item is started by the
   * user's own session and already holds the `PATH` that session has, so there is
   * nothing to recover. Answering null leaves that `PATH` standing, which is the
   * right answer, and skips two shells that were never going to run.
   */
  if (ON_WINDOWS) return Promise.resolve(null);

  read ??= askTheShell(shell, "-ilc").then((said) => said ?? askTheShell(shell, "-lc"));
  return read;
}
