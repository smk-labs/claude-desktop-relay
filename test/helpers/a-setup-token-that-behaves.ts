/**
 * A program that behaves like `claude setup-token`, for driving the real minting
 * through a real pseudo-terminal without a real authorization.
 *
 * A real program rather than a stub function, because what is being tested is the
 * driving: a stub cannot fail the way a terminal does, cannot wrap its own output
 * at the terminal's width, and cannot decline to say anything without one. Nothing
 * here reaches the network, the Keychain, Claude Desktop or a real authorization
 * flow.
 *
 * How it behaves is the first argument, so nothing has to reach it through the
 * environment, which is an allowlist:
 *
 *   prints-the-token     says a link, then the token, then exits
 *   asks-for-a-code      says a link, waits to be told a code, then the token
 *   masks-the-code       says a link and a prompt, echoes nothing at all when
 *                        told, and never finishes, which is what a program that
 *                        masks a pasted secret looks like from outside
 *   says-nothing         exits at once having said nothing
 *   fails                says one line of trouble and exits 1
 *   only-if-a-terminal   says nothing at all unless it has a terminal
 *   never-finishes       says a link and then waits for ever
 *   says-what-it-holds   prints which of the telling variables it was given
 */
const TOKEN = "sk-ant-oat01-a-token-that-only-a-test-ever-sees";
const LINK =
  "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code" +
  "&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=user%3Ainference%20user%3Aprofile&code_challenge=" +
  "Q".repeat(43) +
  "&code_challenge_method=S256&state=" +
  "S".repeat(43);

const behave = process.argv[2] ?? "prints-the-token";

/**
 * Everything is written hard wrapped at the terminal's own width, because that is
 * what the real one does.
 *
 * `claude` renders its output through a terminal UI that lays every line out to
 * `process.stdout.columns`, so a four hundred character link on an eighty column
 * terminal arrives with newlines in the middle of it, and a newline the program put
 * there cannot be told from one it meant. Wrapping here is what makes the width the
 * pty is given something a test can prove rather than something to hope about.
 */
function say(text: string): void {
  const width = process.stdout.columns ?? 80;
  const out = text
    .split("\n")
    .map((line) => line.match(new RegExp(`.{1,${width}}`, "g"))?.join("\n") ?? line)
    .join("\n");
  process.stdout.write(out);
}

if (behave === "only-if-a-terminal" && process.stdout.isTTY !== true) {
  // What the real one does with a pipe: nothing at all, measured 2026-08-23.
  process.exit(0);
}

if (behave === "says-nothing") process.exit(0);

if (behave === "fails") {
  say("Could not reach the authorization server.\n");
  process.exit(1);
}

if (behave === "says-what-it-holds") {
  const telling = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CONFIG_DIR",
    "BROWSER",
    "PATH",
  ];
  for (const name of telling) say(`${name}=${process.env[name] ?? "(unset)"}\n`);
  process.exit(0);
}

say(`Opening the browser to sign in. Config dir: ${process.env["CLAUDE_CONFIG_DIR"] ?? "(unset)"}\n`);
say(`If it did not open, visit:\n${LINK}\n`);

if (behave === "never-finishes") {
  setInterval(() => {}, 1_000);
} else if (behave === "masks-the-code") {
  // A program that masks a pasted secret says nothing back at all, so the prompt
  // is still the last thing on the line after it has been answered, and it stays
  // there. Anything that decided a prompt was unanswered because it had gone quiet
  // would ask again a second later, and again, typing the answer in each time.
  say("Paste code here if prompted > ");
  process.stdin.on("data", () => {});
  setInterval(() => {}, 1_000);
} else if (behave === "asks-for-a-code") {
  // Raw mode, because the real one is a terminal UI and reads keys rather than
  // lines. A cooked pty hands the whole line over at once, so a fake that stayed
  // cooked could never tell a paste from a submission and would pass whatever
  // this side did.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  say("Paste code here if prompted > ");
  let typed = "";
  process.stdin.on("data", (chunk) => {
    const arrived = String(chunk);
    // A chunk with anything else in it is a paste, and the return inside a paste
    // is not a submission. That is what the real one does, and taking it as a
    // submission is what made a stuck sitting look like a working one: the code
    // sat in the field as ninety-two asterisks and nothing happened.
    if (/[\r\n]/.test(arrived) && arrived.replace(/[\r\n]/g, "") === "") {
      say(`\nYour code was ${typed.trim()}.\n`);
      say(`${TOKEN}\n`);
      process.exit(0);
    }
    typed += arrived.replace(/[\r\n]/g, "");
  });
} else {
  say(`Success. Your token is:\n${TOKEN}\n`);
  process.exit(0);
}
