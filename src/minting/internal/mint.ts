import { environmentForAMint } from "./environment.ts";
import { underATerminal, type OpenATerminal } from "./terminal.ts";
import { linkIn, stripDressing, tokenIn, withTheTokenHidden } from "./watch.ts";

/** What running the mint came to. */
export type MintOutcome =
  | { readonly kind: "minted"; readonly token: string }
  | { readonly kind: "nothing"; readonly because: string };

/**
 * The command that mints, as a list rather than a line.
 *
 * A list because it is handed to a program and not to a shell, so there is nothing
 * to quote and nothing a Seat name could ever do to it.
 */
export const MINTS: readonly string[] = ["claude", "setup-token"];

export type MintOne = {
  /** Where `CLAUDE_CONFIG_DIR` points: this Seat's own folder, and no other. */
  readonly folder: string;
  /** Handed the authorization link the moment it is known. */
  readonly link: (url: string) => Promise<void>;
  /** Every whole line the child said, with any token hidden. For a person watching. */
  readonly heard?: (line: string) => void;
  /**
   * How long the whole mint gets. It waits on a person authorizing in a browser,
   * so this is generous, and it exists so that a mint that will never finish is
   * reported rather than waited on for ever.
   */
  readonly ceilingMs?: number;
  /** What to run. In a test, a program that behaves like `claude setup-token`. */
  readonly command?: readonly string[];
  readonly openATerminal?: OpenATerminal;
  /** Named extras for the child's environment. For a test, and nothing else. */
  readonly andAlsoInTheEnvironment?: Readonly<Record<string, string>>;
  readonly now?: () => number;
};

const TEN_MINUTES = 10 * 60 * 1000;
/** How often the output so far is read. Well under how fast a person can act. */
const LOOK_EVERY_MS = 100;
/** How long the child gets to finish on its own once the token is out. */
const GRACE_MS = 3_000;
/**
 * How long anything here waits for a run to be over after it has been killed.
 *
 * Every wait has a ceiling, and this is the one that guards the ceiling itself: the
 * timeout branch ends by waiting for the run to finish, so a kill that did not land
 * would turn the ceiling into an endless wait. Giving up here leaves nothing
 * running, because the group has already been killed.
 */
const SETTLING_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Mint one Send token, driving `claude setup-token` rather than printing it.
 *
 * Nothing is typed into the child, and that is the whole of what a real sitting
 * taught. The command runs a callback on this machine and finishes on its own the
 * moment the browser reaches it; the "Paste code here if prompted" line it also
 * prints is a fallback for when that callback does not arrive. Answering it
 * unconditionally is how a working flow was turned into one that waited for a code
 * nobody needed to give.
 *
 * So the only thing a person is needed for leaves here as `link`, and this module
 * never writes to a screen or reads a keyboard.
 *
 * The token never leaves here except as the return value. It is not printed, not
 * passed to the line watcher, and not written to the folder by us.
 */
export async function mintOneToken(one: MintOne): Promise<MintOutcome> {
  const now = one.now ?? Date.now;
  const ceiling = one.ceilingMs ?? TEN_MINUTES;
  const startedAt = now();

  let said = "";
  let handedOverTheLink: string | null = null;
  /** What has been said since the last whole line went out to a watcher. */
  let unfinishedLine = "";

  const session = (one.openATerminal ?? underATerminal)({
    command: one.command ?? MINTS,
    env: environmentForAMint({
      from: process.env,
      configFolder: one.folder,
      ...(one.andAlsoInTheEnvironment === undefined ? {} : { andAlso: one.andAlsoInTheEnvironment }),
    }),
    onSaid: (text) => {
      said += text;
      if (one.heard === undefined) return;

      // Held back to whole lines, and hidden only after the escapes are out.
      // Output arrives in chunks, so a chunk can end in the middle of a token:
      // passing each chunk on as it came would print the two halves one after
      // the other and leave the whole token in the scrollback, which is the one
      // thing this module promises cannot happen.
      unfinishedLine += text;
      const lines = unfinishedLine.split("\n");
      unfinishedLine = lines.pop() ?? "";
      for (const line of lines) {
        // Stripped before it is hidden, and that order is the whole point. A
        // colour reset inside a token is invisible on a screen and splits the
        // literal in two, so hiding the raw bytes matches neither half and the
        // terminal renders the whole credential into the scrollback.
        const shown = withTheTokenHidden(stripDressing(line)).trim();
        if (shown !== "") one.heard(shown);
      }
    },
  });

  /**
   * Wait for the run to be over, and never for longer than it takes to die.
   *
   * Every caller of this has already killed the group, so the only thing giving up
   * costs is a promise nobody is waiting on any more.
   */
  const settled = () => Promise.race([session.finished, sleep(SETTLING_MS)]);

  let ranOut = false;
  let over = false;
  const finished = session.finished.then((end) => {
    over = true;
    return end;
  });

  /**
   * Hand the link over, once, whenever it turns out to have been said.
   *
   * Called inside the loop and again after it, and the second one is not belt and
   * braces. A child that says everything and exits can have all of it delivered in
   * one go, so the first time this side looks the run is already over and the loop
   * has ended without a single pass. The link was still said.
   */
  const handOverTheLink = async (): Promise<string | null> => {
    const link = linkIn(said);
    if (link === null) return null;
    if (link === handedOverTheLink) return link;
    handedOverTheLink = link;
    await one.link(link);
    return link;
  };

  try {
    while (!over) {
      // The link goes before the token, always. A run that said both at once has
      // still said the link, and a person watching a sitting is told which
      // account is being signed into by seeing it handed over.
      await handOverTheLink();

      const token = tokenIn(said);
      if (token !== null) {
        // The child prints the token and then exits on its own. It is given a
        // moment to do that, and killed if it does not, because a mint that has
        // already produced the token must not be able to hold up the sitting.
        await Promise.race([session.finished, sleep(GRACE_MS)]);
        session.stop("the token was out and the run had finished with");
        await settled();
        return { kind: "minted", token };
      }

      if (now() - startedAt > ceiling) {
        ranOut = true;
        session.stop(`it did not finish within ${Math.round(ceiling / 60000)} minutes`);
        await settled();
        break;
      }

      await Promise.race([session.finished, sleep(LOOK_EVERY_MS)]);
    }
  } catch (error) {
    // A caller's own callback can throw, and opening a browser profile is the
    // likeliest of them. Leaving here without killing the group would leave expect
    // and `claude` running for ever, because the driver has no timeout of its own.
    session.stop("something went wrong on this side");
    await settled();
    throw error;
  }

  const end = await Promise.race([finished, sleep(SETTLING_MS).then(() => null)]);
  await handOverTheLink();

  // Read once more, and this time a token at the very end counts: the run is over,
  // so no more output is coming that could turn out to be the rest of one.
  const token = tokenIn(said, { theTextIsComplete: true });
  if (token !== null) return { kind: "minted", token };

  if (ranOut) return { kind: "nothing", because: end?.stoppedBecause ?? "it ran out of time" };
  return { kind: "nothing", because: whyNothing(said, end?.code ?? -1) };
}

/**
 * Why a finished run produced no token, in the child's own words where it has any.
 *
 * Its last line is used rather than a sentence of ours, because the child knows
 * what went wrong and we would only be guessing at it.
 */
function whyNothing(said: string, code: number): string {
  const lines = said
    .split("\n")
    .map((line) => withTheTokenHidden(stripDressing(line)).trim())
    .filter((line) => line !== "");
  const last = lines.at(-1);
  if (last === undefined) return `it said nothing at all and exited ${code}`;
  return `it exited ${code} saying: ${last}`;
}
