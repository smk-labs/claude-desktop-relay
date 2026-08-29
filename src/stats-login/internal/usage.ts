import { AS_A_BROWSER } from "./bootstrap.ts";
import type { AllowanceAsRead, UsageAsRead } from "./read-shapes.ts";

/**
 * What an account has spent in one Organization, from that account's own login.
 *
 * This is the only way to learn anything about a Seat that is sitting idle. A
 * Send token is inference-only and the allowance figures only ever arrive
 * attached to a real reply, so a Seat nobody has used today has no reply to read
 * and would otherwise be a blank in every comparison.
 *
 * It reads and it cannot send: this module never sees a Send token, and the only
 * credential it is given is a Stats login, which ADR 0002 says can do nothing
 * else.
 */
const WHERE = (organizationId: string) => `https://claude.ai/api/organizations/${organizationId}/usage`;

/** Ask claude.ai what one Organization has spent. Throws with a sentence on a refusal. */
export type AskUsage = (statsLogin: string, organizationId: string) => Promise<unknown>;

export const askClaudeAiForUsage: AskUsage = async (statsLogin, organizationId) => {
  const answer = await fetch(WHERE(organizationId), {
    headers: { ...AS_A_BROWSER, cookie: `sessionKey=${statsLogin}` },
  }).catch((error: unknown) => {
    throw new Error(
      `claude.ai could not be reached: ${error instanceof Error ? error.message : String(error)}. ` +
        `If this machine reaches the internet through a proxy or a VPN, that is the first thing to check.`,
    );
  });

  if (!answer.ok) throw new Error(`claude.ai answered ${answer.status} for what ${organizationId} has spent`);
  return answer.json();
};

/** Whatever came back, read defensively: none of this shape is ours to promise. */
type Loose = Record<string, unknown>;
const asObject = (value: unknown): Loose | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Loose) : null;

/**
 * One window, out of the shape claude.ai answers with.
 *
 * `utilization` arrives as a percentage where a reply header carries a share, so
 * it is divided here rather than anywhere later. One quantity, one scale: a
 * reader that had to remember which of two numbers was which would eventually
 * forget, and the mistake would be a Seat ranked ten times too high.
 */
function windowFrom(value: unknown): AllowanceAsRead | null {
  const held = asObject(value);
  if (held === null) return null;

  const percent = held["utilization"];
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;

  const stated = held["resets_at"];
  const resetsAt = typeof stated === "string" ? Date.parse(stated) : Number.NaN;

  return {
    utilization: percent / 100,
    resetsAt: Number.isFinite(resetsAt) ? Math.trunc(resetsAt / 1000) : null,
  };
}

/**
 * Both windows out of one answer, or null when it named neither.
 *
 * Null rather than a pair of zeroes. An Organization that answers with nothing at
 * all is one this account has never spent in, or one whose answer we no longer
 * understand, and "zero spent" is a claim neither of those supports.
 */
export function usageFrom(answer: unknown): UsageAsRead | null {
  const held = asObject(answer);
  if (held === null) return null;

  const fiveHour = windowFrom(held["five_hour"]);
  const sevenDay = windowFrom(held["seven_day"]);
  if (fiveHour === null && sevenDay === null) return null;

  return { readVia: "stats-login", fiveHour, sevenDay };
}
