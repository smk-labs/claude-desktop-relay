/**
 * What can be typed, and what each thing means. One table, and the help text is
 * built from it, so a command cannot exist without being documented.
 */

/** The name a person types this program by, in every line it prints. */
export const CALLED = "relay";

export type Named =
  | "status"
  | "auto"
  | "on"
  | "off"
  | "use"
  | "seats"
  | "verdict"
  | "doctor"
  | "install"
  | "uninstall"
  | "serve"
  | "page"
  | "tray"
  | "history"
  | "refresh"
  | "collect-seats"
  | "add-seat"
  | "back-up-seats"
  | "check"
  | "prove"
  | "check-secret-store"
  | "help";

/**
 * One thing that can be typed.
 *
 * `handsOff` names a flow that runs in its own process: the long interactive
 * sittings and the two proofs that are deliberately not part of `npm test`
 * because they reach the machine's own secret store and the real server. They are here rather
 * than left as separate scripts so that there is still one door, and their
 * argument handling stays their own.
 */
export type Command = {
  readonly name: Named;
  /** How it is typed, after the program's own name. */
  readonly typed: string;
  /** One line, plain, fit to print as it stands. */
  readonly does: string;
  /** The script this hands off to, when it does not do the work itself. */
  readonly handsOff?: string;
};

export const COMMANDS: readonly Command[] = [
  { name: "status", typed: "", does: "what is paying for this Window, and how much room it has" },
  { name: "auto", typed: "auto", does: "let it pick the best Seat for each new conversation" },
  { name: "on", typed: "on", does: "pay with the Seat that was picked, from the next request" },
  { name: "off", typed: "off", does: "leave every request on the Window account" },
  { name: "use", typed: "use <seat>", does: "pay with that Seat instead" },
  { name: "seats", typed: "seats", does: "every Seat you own, and what each has left" },
  { name: "verdict", typed: "verdict", does: "what the server said about the last swap" },
  {
    name: "history",
    typed: "history",
    does: "what every Seat has spent, and which project it went on",
    handsOff: "history.ts",
  },
  {
    name: "refresh",
    typed: "refresh",
    does: "read what every Seat has spent, and any plan that has changed",
    handsOff: "refresh.ts",
  },
  { name: "page", typed: "page", does: "open the page the relay serves, in a browser" },
  {
    name: "tray",
    typed: "tray",
    does: "the menu bar item: the Seat paying, the Mode, and six Seats",
    handsOff: "tray.ts",
  },
  { name: "doctor", typed: "doctor", does: "whether the mechanism still works, and what changed" },
  { name: "install", typed: "install", does: "put the relay on this machine, once" },
  {
    name: "uninstall",
    typed: "uninstall",
    does: "put the machine back exactly as it was",
  },
  {
    name: "serve",
    typed: "serve [port]",
    does: "run the relay in this terminal, instead of as the service",
    handsOff: "serve.ts",
  },
  {
    name: "collect-seats",
    typed: "collect-seats",
    does: "the sitting that fills a Seat's Send token, one account at a time",
    handsOff: "collect-seats.ts",
  },
  {
    name: "add-seat",
    typed: "add-seat <seat>",
    does: "fill one Seat, the same way a sitting does; nothing is pasted",
    handsOff: "collect-seats.ts",
  },
  {
    name: "back-up-seats",
    typed: "back-up-seats",
    does: "keep a locked copy of the Send tokens, or put them back",
    handsOff: "back-up-seats.ts",
  },
  {
    name: "check",
    typed: "check",
    does: "prove the whole chain against the real server, with one real session",
    handsOff: "check-end-to-end.ts",
  },
  {
    name: "prove",
    typed: "prove",
    does: "measure which paths land on the chosen Seat, on a Window of its own",
    handsOff: "prove.ts",
  },
  {
    name: "check-secret-store",
    typed: "check-secret-store",
    does: "prove this machine's own secret store round-trips a Send token",
    handsOff: "check-secret-store.ts",
  },
  { name: "help", typed: "help", does: "this list" },
];

const ASKING_FOR_HELP = new Set(["-h", "--help", "-?"]);

/** What was typed, or null when it was something this does not know. */
export function commandFrom(argv: readonly string[]): Command | null {
  const first = argv[0];
  const named = (name: Named) => COMMANDS.find((one) => one.name === name)!;

  if (first === undefined) return named("status");
  if (ASKING_FOR_HELP.has(first)) return named("help");
  // Any other leading flag belongs to the status, which is what one word means.
  if (first.startsWith("-")) return named("status");
  return COMMANDS.find((one) => one.name === first) ?? null;
}

const WIDEST = Math.max(...COMMANDS.map((one) => one.typed.length));

/** The whole list, built from the table so nothing can go undocumented. */
export function help(): readonly string[] {
  const lines = [`${CALLED} — which of your own subscriptions pays for this Window's Code sessions.`, ""];
  for (const one of COMMANDS) {
    lines.push(`  ${CALLED} ${one.typed.padEnd(WIDEST)}   ${one.does}`);
  }
  return lines;
}

/** The three or four lines a person actually needs next, for the end of a status. */
export function whatToTypeNext(options: { mode: "auto" | "manual" | "off"; hasAPick: boolean }): readonly string[] {
  const of = (name: Named) => {
    const one = COMMANDS.find((command) => command.name === name)!;
    return `  ${CALLED} ${one.typed.padEnd(WIDEST)}   ${one.does}`;
  };

  return [
    ...(options.mode === "auto" ? [] : [of("auto")]),
    ...(options.mode === "off" && options.hasAPick ? [of("on")] : []),
    ...(options.mode === "off" ? [] : [of("off")]),
    of("use"),
    of("seats"),
  ];
}
