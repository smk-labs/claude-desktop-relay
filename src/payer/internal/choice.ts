import { readJsonFile, writeJsonFile } from "../../json-file/index.ts";

/**
 * How the Payer is chosen.
 *
 * Auto ranks the Seats again for every request and pays with the best of them, so
 * a change is in force on the very next request. Manual holds the Seat the user
 * picked. Off leaves every request on the Window account, exactly as if the relay
 * were not installed.
 */
export type Mode = "auto" | "manual" | "off";

/** The same set, for anything that has to check what was read off a file. */
export const MODES: readonly Mode[] = ["auto", "manual", "off"];

export type Choice = {
  readonly mode: Mode;
  /** The Seat's name in Manual mode, or null when none has been picked. */
  readonly payer: string | null;
};

/** Off until the user says otherwise, so installing this changes nothing. */
export const UNTOUCHED: Choice = { mode: "off", payer: null };

/** Read fresh every time, so a change needs no restart of anything. */
export async function readChoice(file: string): Promise<Choice> {
  const held = await readJsonFile<Partial<Choice>>(file);
  if (held === null) return UNTOUCHED;

  return {
    // Anything unrecognised reads as Off, so a file from a newer version, or one
    // edited by hand, can never leave requests being swapped on a rule this
    // program does not understand.
    mode: MODES.includes(held.mode as Mode) ? (held.mode as Mode) : "off",
    payer: typeof held.payer === "string" && held.payer !== "" ? held.payer : null,
  };
}

export async function writeChoice(file: string, choice: Choice): Promise<void> {
  await writeJsonFile(file, choice);
}
