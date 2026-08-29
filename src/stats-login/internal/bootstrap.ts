import type { Multiplier } from "../../seats/index.ts";
import type { CannotPay, OrganizationAsRead } from "./read-shapes.ts";

/** Where an account's own picture of itself comes from. */
const BOOTSTRAP = "https://claude.ai/api/bootstrap";

/**
 * A browser's own header set, because this endpoint is the one the claude.ai web
 * app calls and it answers a request that does not look like one with a page
 * rather than an answer. Nothing here works around a challenge: it identifies the
 * caller honestly as what it is, a program reading the user's own account.
 */
export const AS_A_BROWSER = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "application/json",
  referer: "https://claude.ai/",
} as const;

/** Ask claude.ai what a Stats login can see. Throws with a sentence on any refusal. */
export type Ask = (statsLogin: string) => Promise<unknown>;

export const askClaudeAi: Ask = async (statsLogin) => {
  let answer: Response;
  try {
    // `sessionKey` is the cookie's own name on the wire, not ours.
    answer = await fetch(BOOTSTRAP, { headers: { ...AS_A_BROWSER, cookie: `sessionKey=${statsLogin}` } });
  } catch (error) {
    // A bare "fetch failed" reads like a bug here. On a machine where claude.ai
    // is only reachable through a proxy, or with a VPN halfway up, this is the
    // whole story and naming it is the difference between a fix and a mystery.
    throw new Error(
      `claude.ai could not be reached: ${error instanceof Error ? error.message : String(error)}. ` +
        `If this machine reaches the internet through a proxy or a VPN, that is the first thing to check.`,
    );
  }

  if (answer.status === 401 || answer.status === 403) {
    throw new Error(
      `this Stats login has expired (claude.ai answered ${answer.status}). ` +
        `Open Claude Desktop as this account once and it refreshes itself.`,
    );
  }
  if (!answer.ok) throw new Error(`claude.ai answered ${answer.status}`);

  return answer.json();
};

/** Whatever came back, read defensively: none of this shape is ours to promise. */
type Loose = Record<string, unknown>;
const asObject = (value: unknown): Loose | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Loose) : null;
const asText = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * A Seat's weekly capacity, from the two things the server says about it.
 *
 * Every Organization in a Team reports the same `rate_limit_tier`, so the tier
 * alone cannot tell a premium seat from a standard one. The seat tier on the
 * membership is what separates them, which is why both are read here and why
 * this cannot be worked out from the Organization on its own.
 */
function multiplierFrom(tier: string, ravenType: string | null, seatTier: string | null): Multiplier | null {
  if (tier.includes("max_20x")) return 20;
  if (tier.includes("max_5x")) return 5;
  if (tier === "default_raven" || ravenType === "team") {
    if (seatTier === "team_tier_1") return 6.25;
    if (seatTier === "team_standard") return 1.25;
    // A Team Seat whose grade the server did not name. The lower of the two on
    // purpose: understating a Seat's capacity only costs it a turn in the
    // ranking, where overstating it sends work to a Seat that cannot carry it.
    return 1.25;
  }
  if (tier.includes("pro")) return 1;
  if (tier === "default_claude_ai") return 0;
  return null;
}

/**
 * Why this Organization yields no Seat, or null when it yields one.
 *
 * Both answers come from the server's own words. An Organization that cannot
 * hold a chat exists to evaluate the API and can never pay for a Code session;
 * a free one has no capacity to spend. Neither is a Seat.
 */
function cannotPay(capabilities: readonly string[], multiplier: Multiplier | null): CannotPay | null {
  if (!capabilities.includes("chat")) return "api-only";
  if (multiplier === 0) return "free";
  return null;
}

/** The account's email and its Organizations, out of one bootstrap answer. */
export function accountFrom(answer: unknown): { account: string; organizations: OrganizationAsRead[] } {
  const account = asObject(asObject(answer)?.["account"]);
  const email = asText(account?.["email_address"]);
  if (email === null) {
    throw new Error("claude.ai answered, but its answer named no account, so this Stats login says nothing useful");
  }

  const memberships = Array.isArray(account?.["memberships"]) ? account["memberships"] : [];
  const organizations: OrganizationAsRead[] = [];

  for (const held of memberships) {
    const membership = asObject(held);
    const organization = asObject(membership?.["organization"]);
    const id = asText(organization?.["uuid"]);
    if (organization === null || id === null) continue;

    const tier = asText(organization["rate_limit_tier"]) ?? "";
    const capabilities = Array.isArray(organization["capabilities"])
      ? organization["capabilities"].filter((one): one is string => typeof one === "string")
      : [];
    const multiplier = multiplierFrom(tier, asText(organization["raven_type"]), asText(membership?.["seat_tier"]));

    organizations.push({
      id,
      label: asText(organization["name"]) ?? id,
      multiplier,
      cannotPay: cannotPay(capabilities, multiplier),
      // Filled in afterwards, and only when asked for: what an Organization has
      // spent is a second request per Organization, and most callers of this
      // want the list of Seats and not the spending.
      usage: null,
    });
  }

  return { account: email, organizations };
}
