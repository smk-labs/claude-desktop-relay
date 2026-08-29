/**
 * What one reply cost, in tokens, read off the bytes as they pass.
 *
 * Ticket 18 assumed the relay already had these. It did not: every header on a
 * real reply was captured in full on 2026-08-21 and all thirteen are about
 * allowance, so the counts are in the reply body. This is the one module allowed
 * near a reply body, in the same way `src/conversation` is the one allowed near a
 * request body, and it is held to the same rule: four integers out, and nothing
 * else, asserted by a test that puts a passphrase in every text field of a real
 * reply shape.
 *
 * It observes and never transforms. The reply reaches the caller exactly as it
 * arrived, byte for byte, because nothing here sits in the pipe.
 */
export type { TokenCounts, Scanner } from "./internal/scan.ts";
export { openScanner, counted } from "./internal/scan.ts";
