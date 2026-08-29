/** The answer a proxy gives when it has opened a tunnel. */
export const ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

/** Whatever was thrown, as one line fit to show a user. Never a message body. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
