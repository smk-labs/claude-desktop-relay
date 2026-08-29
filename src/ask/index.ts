/**
 * Asking the user for something at the terminal, without the answer appearing.
 *
 * This exists because a Send token is pasted by hand and must not end up on the
 * screen, in a scrollback buffer, or in a transcript of the session. The terminal
 * echoes what is typed unless it is told not to, and telling it not to means
 * taking the terminal off the line-at-a-time behaviour everything else relies on,
 * which is fiddly enough, and easy enough to leave in the wrong state, to be worth
 * exactly one implementation.
 *
 * It prints nothing, not even the prompt. Nothing under `src` writes to the
 * console, so that no message body can ever reach one, and the module that
 * handles a pasted credential is the last place to make an exception.
 */
export { askOutLoud, askSecretly, stopAsking } from "./internal/terminal.ts";
