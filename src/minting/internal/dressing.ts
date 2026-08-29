/**
 * The escape sequences a real terminal puts in the middle of what a program said.
 *
 * Written out as text rather than as the bytes themselves, so the source stays
 * readable and no stray escape character can hide in it.
 */
const ESC = "\\u001b";
const BEL = "\\u0007";

/** An operating system command, which is how a terminal marks a clickable link. */
const OSC = new RegExp(`${ESC}\\][^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
/** A control sequence: colour, cursor moves, everything a spinner is made of. */
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
/** The short two-character ones, which include the character-set switches. */
const SHORT = new RegExp(`${ESC}[()][A-Za-z0-9]`, "g");

/**
 * Escape sequences and carriage returns, taken out before anything is looked for.
 *
 * An address with an escape sequence in the middle of it is not an address, and
 * OSC 8 wraps a clickable one in escapes, so leaving those in would break exactly
 * the line this is read most carefully for. Carriage returns go because a pty ends
 * every line with one, and because a spinner rewrites its line by returning to the
 * start of it.
 */
export function stripDressing(text: string): string {
  return text.replace(OSC, "").replace(CSI, "").replace(SHORT, "").replace(/\r/g, "");
}
