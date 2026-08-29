/**
 * What the minting child is allowed to inherit, named one variable at a time.
 *
 * An allowlist rather than everything this process holds, and the reason is a
 * credential that outranks the login. Claude Desktop hands a Code session a Send
 * token as `CLAUDE_CODE_OAUTH_TOKEN`, and that variable beats the stored login, so
 * a mint started from a process that has one would authorize as whichever Seat
 * that token belongs to rather than as the account the user just signed in with.
 * The Probe would then refuse the token and the sitting would look like a browser
 * profile mistake. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
 * `ANTHROPIC_BASE_URL` are the same shape: identity or destination, from a
 * variable, silently.
 *
 * Spreading the environment and deleting the four known offenders would leave the
 * fifth one, whatever it turns out to be called, to be found the hard way. Naming
 * what may pass means a new variable arrives absent rather than in charge.
 */
const MAY_PASS: readonly string[] = [
  // Finding the program at all, and the ordinary shape of a shell session.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  // How this machine reaches the internet. Never gone round (ADR 0011): a machine
  // that names a proxy names it for the mint too, or the mint reaches nothing.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  /**
   * The Windows shape of the same three things: finding the program, having a
   * place to write scratch files, and knowing where the user's own home is.
   *
   * Named for the same reason the rest are. A program started on Windows without
   * `SystemRoot` cannot load the sockets library and fails with an error about
   * nothing in particular, which is a bad half-hour for whoever meets it.
   */
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "USERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

/**
 * The environment one mint runs under.
 *
 * `CLAUDE_CONFIG_DIR` is the whole reason a mint is safe to run at all: without it
 * `claude setup-token` writes into `~/.claude` and the machine's own state is the
 * one being edited. Nothing else is added: `claude` opens the authorization link
 * itself, in whichever profile the browser puts in front, and the sitting says
 * which one that should be rather than trying to control it.
 */
export function environmentForAMint(options: {
  readonly from: Readonly<Record<string, string | undefined>>;
  readonly configFolder: string;
  /** Named extras, for a test that has to tell its own program how to behave. */
  readonly andAlso?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of MAY_PASS) {
    const value = options.from[name];
    if (value !== undefined) env[name] = value;
  }

  env["CLAUDE_CONFIG_DIR"] = options.configFolder;

  return { ...env, ...options.andAlso };
}

/** On the interface so a test can hold the list to what it says it is. */
export const WHAT_MAY_PASS = MAY_PASS;
