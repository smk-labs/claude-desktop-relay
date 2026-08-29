import type { IncomingMessage } from "node:http";

/**
 * The most of a request body the relay will hold before deciding who pays.
 *
 * Holding one at all is a cost the relay would rather not pay, and it is paid for
 * one reason: who pays for a conversation cannot be decided without knowing where
 * in that conversation the request sits, and that is in the body. Only the
 * message endpoints are held; every other path streams as it always did, and so
 * does every reply, which is the big one.
 *
 * Four megabytes is roughly a full context window written out as JSON. Past that
 * the body is never complete in memory and its shape reads as unknown, which the
 * caller treats as "not a new conversation" and so changes nothing.
 */
export const THE_MOST_WE_WILL_HOLD = 4 * 1024 * 1024;

export type HeldBody = {
  /** The whole body, or null when it outgrew what we are willing to hold. */
  readonly body: Buffer | null;
  /**
   * Every byte taken off the stream so far, which the caller must write on before
   * letting the rest follow.
   *
   * This is what makes the limit cost a decision rather than a request: the bytes
   * are never dropped, only un-examined.
   */
  readonly readSoFar: readonly Buffer[];
  /** True when the stream ended, so there is nothing left to forward after this. */
  readonly whole: boolean;
};

/**
 * Read a request body up to the limit, without ever consuming a byte the caller
 * cannot forward.
 *
 * The stream is paused rather than closed when the limit is reached, so piping it
 * onwards afterwards picks up exactly where this stopped. Closing it instead
 * would truncate the request, which is the failure this shape exists to make
 * impossible.
 */
export function holdBody(request: IncomingMessage): Promise<HeldBody> {
  return new Promise((resolve) => {
    const readSoFar: Buffer[] = [];
    let held = 0;
    let answered = false;

    const answer = (result: HeldBody) => {
      if (answered) return;
      answered = true;
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onEnd);
      request.off("aborted", onEnd);
      resolve(result);
    };

    function onData(chunk: Buffer | string) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      readSoFar.push(bytes);
      held += bytes.length;
      if (held <= THE_MOST_WE_WILL_HOLD) return;
      // Paused, not ended. Whatever has not been read yet is still there for the
      // pipe that follows.
      request.pause();
      answer({ body: null, readSoFar, whole: false });
    }

    function onEnd() {
      answer({ body: Buffer.concat(readSoFar), readSoFar, whole: true });
    }

    request.on("data", onData);
    request.once("end", onEnd);
    // A request that failed halfway is still a request the caller has to answer
    // for, so this reports what there is rather than never settling.
    request.once("error", onEnd);
    request.once("aborted", onEnd);
    request.resume();
  });
}
