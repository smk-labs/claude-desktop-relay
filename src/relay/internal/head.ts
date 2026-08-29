import type { Socket } from "node:net";

export type Head = {
  /** The first line, for example `HTTP/1.1 200 Connection Established`. */
  readonly statusLine: string;
  /** Bytes that arrived after the blank line and belong to whoever reads next. */
  readonly early: Buffer;
};

/**
 * Read one HTTP head off a raw socket and stop.
 *
 * Deliberately not `for await (const chunk of socket)`: returning or breaking out
 * of that loop runs the async iterator's cleanup, which destroys the socket. The
 * socket is left paused with any early bytes pushed back, so the caller can wire
 * it up without losing a byte.
 */
export function readHead(socket: Socket): Promise<Head> {
  return new Promise<Head>((resolve, reject) => {
    const chunks: Buffer[] = [];

    const stopListening = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };

    function onData(chunk: Buffer): void {
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) return;

      stopListening();
      socket.pause();

      const early = buffered.subarray(end + 4);
      if (early.length > 0) socket.unshift(early);

      const head = buffered.subarray(0, end).toString("latin1");
      const firstBreak = head.indexOf("\r\n");
      resolve({
        statusLine: firstBreak === -1 ? head : head.slice(0, firstBreak),
        early,
      });
    }

    function onError(error: Error): void {
      stopListening();
      reject(error);
    }

    function onEnd(): void {
      stopListening();
      reject(new Error("the other end closed the connection without answering"));
    }

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}
