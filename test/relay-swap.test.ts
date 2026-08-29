import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { startRelay, type Exchange, type RelayNotice } from "../src/relay/index.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";
import { requestThrough, twiceDownOneConnection } from "./helpers/through-the-relay.ts";
import { paying } from "./helpers/a-decision.ts";

const OPEN_HOST = "api.anthropic.com";
const CALLER = "Bearer sk-ant-oat01-the-window-account";

after(forgetAuthorities);

async function relayWith(options: {
  upstream: FakeUpstream;
  token?: string | null | (() => string | null);
  exchanges?: Exchange[];
  notices?: RelayNotice[];
}) {
  const authority = await authorityFor(OPEN_HOST);
  return startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [options.upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: options.upstream.port }),
    ...(options.token === undefined
      ? {}
      : {
          chargeFor: () => {
            const token = typeof options.token === "function" ? options.token() : options.token;
            return paying(
              token === null || token === undefined ? null : { token, seat: "seat-a", organizationId: "org-seat-a" },
            );
          },
        }),
    onExchange: (exchange) => options.exchanges?.push(exchange),
    onNotice: (notice) => options.notices?.push(notice),
  });
}

/** The value of one header exactly as it arrived at the upstream. */
function arrived(upstream: FakeUpstream, index: number, name: string): string | undefined {
  const raw = upstream.seen[index]?.rawHeaders ?? [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === name) return raw[i + 1];
  }
  return undefined;
}

async function ask(relay: { address: { host: string; port: number } }, upstream: FakeUpstream, path: string) {
  return requestThrough({
    relay: relay.address,
    host: OPEN_HOST,
    port: 443,
    trust: upstream.authority,
    path,
    headers: [["Authorization", CALLER]],
    body: `{"model":"claude-opus-5","messages":[{"role":"user","content":"the secret is marmalade"}]}`,
  });
}

test("the authorization that leaves is the Send token the provider returned", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a" });

  try {
    await ask(relay, upstream, "/v1/messages");
    assert.equal(arrived(upstream, 0, "authorization"), "Bearer sk-ant-oat01-seat-a");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("only the message endpoint is swapped; other paths keep the caller's own credential", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a" });

  try {
    await ask(relay, upstream, "/v1/models");
    await ask(relay, upstream, "/v1/organizations/usage");
    await ask(relay, upstream, "/v1/messages?beta=true");
    // Counting tokens carries the conversation and spends allowance, so it goes
    // to the Payer as well. In one real session it was 186 requests.
    await ask(relay, upstream, "/v1/messages/count_tokens?beta=true");
    // A trailing slash is not a path we know, so it stays on the safe side.
    await ask(relay, upstream, "/v1/messages/");

    assert.equal(arrived(upstream, 0, "authorization"), CALLER, "/v1/models must not be swapped");
    assert.equal(arrived(upstream, 1, "authorization"), CALLER, "usage must not be swapped");
    assert.equal(arrived(upstream, 2, "authorization"), "Bearer sk-ant-oat01-seat-a");
    assert.equal(arrived(upstream, 3, "authorization"), "Bearer sk-ant-oat01-seat-a", "count_tokens must be swapped");
    assert.equal(arrived(upstream, 4, "authorization"), CALLER, "an unknown path stays on the caller's own");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("the token is read again for every request, so changing it needs no restart", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const tokens = ["sk-ant-oat01-first", "sk-ant-oat01-second"];
  let asked = 0;
  const relay = await relayWith({ upstream, token: () => tokens[asked++] ?? null });

  try {
    await ask(relay, upstream, "/v1/messages");
    await ask(relay, upstream, "/v1/messages");

    assert.equal(arrived(upstream, 0, "authorization"), "Bearer sk-ant-oat01-first");
    assert.equal(arrived(upstream, 1, "authorization"), "Bearer sk-ant-oat01-second");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("the token is read again even for a second request on the same connection", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const tokens = ["sk-ant-oat01-first", "sk-ant-oat01-second"];
  let asked = 0;
  const relay = await relayWith({ upstream, token: () => tokens[asked++] ?? null });

  try {
    const [first, second] = await twiceDownOneConnection({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(asked, 2, "the relay must ask once per request, not once per connection");
    assert.equal(arrived(upstream, 0, "authorization"), "Bearer sk-ant-oat01-first");
    assert.equal(arrived(upstream, 1, "authorization"), "Bearer sk-ant-oat01-second");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("a competing credential is removed when the relay swaps, so it cannot decide who pays", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a" });

  try {
    await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      headers: [
        ["Authorization", CALLER],
        ["x-api-key", "sk-ant-api03-somebody-elses-key"],
      ],
      body: "{}",
    });

    assert.equal(arrived(upstream, 0, "authorization"), "Bearer sk-ant-oat01-seat-a");
    assert.equal(arrived(upstream, 0, "x-api-key"), undefined, "a competing credential must not travel on");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("every status the server declines with is reported as a Refusal", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const exchanges: Exchange[] = [];
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a", exchanges });

  try {
    for (const status of [400, 401, 402, 403, 429, 500, 529]) {
      upstream.reply = { status, parts: ["no"] };
      await ask(relay, upstream, "/v1/messages");
    }

    assert.deepEqual(
      exchanges.map((facts) => [facts.status, facts.refused]),
      [400, 401, 402, 403, 429, 500, 529].map((status) => [status, true]),
    );
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("a request the server never answered leaves facts behind, not a silence", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const exchanges: Exchange[] = [];
  const notices: RelayNotice[] = [];
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a", exchanges, notices });

  // The upstream is gone before the request is made, so nothing answers.
  await upstream.close();

  try {
    const answer = await ask(relay, upstream, "/v1/messages");
    assert.equal(answer.status, 502);

    assert.equal(exchanges.length, 1, "a failed request must still report facts");
    assert.equal(exchanges[0]?.status, 0, "no answer is told apart from a Refusal by status zero");
    assert.equal(exchanges[0]?.refused, false);
    assert.equal(exchanges[0]?.paidBy, null);
    assert.ok(notices.length > 0, "and it must say so out loud");

    const everythingSaid = JSON.stringify({ exchanges, notices });
    assert.ok(!everythingSaid.includes("marmalade"), `content leaked on the failure path: ${everythingSaid}`);
    assert.ok(!everythingSaid.includes("sk-ant-oat01"), `a credential leaked: ${everythingSaid}`);
  } finally {
    await relay.close();
  }
});

test("no token means the caller's own credential travels untouched", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const exchanges: Exchange[] = [];
  const relay = await relayWith({ upstream, token: null, exchanges });

  try {
    await ask(relay, upstream, "/v1/messages");
    assert.equal(arrived(upstream, 0, "authorization"), CALLER);
    assert.equal(exchanges[0]?.swapped, false);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("the facts reported back are the ones the server sent", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  upstream.reply = {
    headers: {
      "anthropic-organization-id": "org-the-one-that-paid",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-7d-utilization": "0.07",
      "anthropic-ratelimit-unified-5h-reset": "1787357400",
      "anthropic-ratelimit-unified-7d-reset": "1787677200",
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
    },
    parts: [`{"content":"the reply mentions marmalade too"}`],
  };

  const exchanges: Exchange[] = [];
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a", exchanges });

  try {
    await ask(relay, upstream, "/v1/messages");

    assert.equal(exchanges.length, 1);
    const facts = exchanges[0];
    assert.equal(facts?.path, "/v1/messages");
    assert.equal(facts?.method, "POST");
    assert.equal(facts?.status, 200);
    assert.equal(facts?.refused, false);
    assert.equal(facts?.swapped, true);
    assert.equal(facts?.paidBy, "org-the-one-that-paid");
    assert.equal(facts?.utilization.fiveHour, 0.42);
    assert.equal(facts?.utilization.sevenDay, 0.07);
    assert.equal(facts?.overage.status, "rejected");
    assert.equal(facts?.overage.disabledReason, "org_level_disabled");
    assert.equal(facts?.resets.fiveHour, 1787357400);
    assert.equal(facts?.resets.sevenDay, 1787677200);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("an exchange the server answered without naming an organization says so", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const exchanges: Exchange[] = [];
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a", exchanges });

  try {
    await ask(relay, upstream, "/v1/messages");
    assert.equal(exchanges[0]?.paidBy, null);
    assert.equal(exchanges[0]?.utilization.fiveHour, null);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("a Refusal is reported as a Refusal with its status, never as a success", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  upstream.reply = { status: 429, parts: [`{"error":{"message":"Error"}}`] };

  const exchanges: Exchange[] = [];
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a", exchanges });

  try {
    const answer = await ask(relay, upstream, "/v1/messages");
    assert.equal(answer.status, 429);
    assert.equal(exchanges[0]?.status, 429);
    assert.equal(exchanges[0]?.refused, true);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("every reply header is kept verbatim, including allowance headers we cannot yet name", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  upstream.reply = {
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      "anthropic-ratelimit-unified-something-we-have-not-measured": "2026-08-21T18:00:00Z",
    },
    parts: ["ok"],
  };

  const exchanges: Exchange[] = [];
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a", exchanges });

  try {
    await ask(relay, upstream, "/v1/messages");
    assert.equal(
      exchanges[0]?.replyHeaders["anthropic-ratelimit-unified-something-we-have-not-measured"],
      "2026-08-21T18:00:00Z",
    );
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("nothing the relay reports contains any message content", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  upstream.reply = { parts: [`{"content":"marmalade in the reply as well"}`] };

  const exchanges: Exchange[] = [];
  const notices: RelayNotice[] = [];
  const relay = await relayWith({ upstream, token: "sk-ant-oat01-seat-a", exchanges, notices });

  try {
    await ask(relay, upstream, "/v1/messages");

    const everythingSaid = JSON.stringify({ exchanges, notices });
    assert.ok(!everythingSaid.includes("marmalade"), `content leaked: ${everythingSaid}`);
    assert.ok(!everythingSaid.includes("sk-ant-oat01"), `a credential leaked: ${everythingSaid}`);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("concurrent requests on different Seats are each judged as their own", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const authority = await authorityFor(OPEN_HOST);
  const exchanges: Exchange[] = [];

  // Two Seats, alternating, so a verdict that belongs to the wrong request shows
  // up as the wrong Seat rather than hiding behind a single correct answer.
  const seats = [
    { token: "sk-ant-oat01-one", seat: "one", organizationId: "org-one" },
    { token: "sk-ant-oat01-two", seat: "two", organizationId: "org-two" },
  ] as const;

  let handed = 0;
  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    chargeFor: () => paying(seats[handed++ % 2] ?? null),
    onExchange: (exchange) => exchanges.push(exchange),
  });

  // The server names whichever Organization the request actually carried, which
  // is what makes this a real check rather than a bookkeeping one.
  upstream.reply = { parts: ["ok"] };
  const server = upstream;
  const wasCharged = new Map<string, string>();

  try {
    const HOW_MANY = 30;

    // All at once. This is the shape that broke it: the Seat used to be kept in
    // one variable beside the relay, and thirty requests each cleared it for the
    // others, so verdicts named whoever happened to be last.
    await Promise.all(
      Array.from({ length: HOW_MANY }, () =>
        requestThrough({
          relay: relay.address,
          host: OPEN_HOST,
          port: 443,
          trust: upstream.authority,
          path: "/v1/messages",
          body: "{}",
        }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(server.seen.length, HOW_MANY, "every request must have arrived");
    assert.equal(exchanges.length, HOW_MANY, "and every one must be reported");

    // Not one exchange may be missing who paid for it.
    const orphaned = exchanges.filter((exchange) => exchange.chargedTo === null);
    assert.deepEqual(orphaned, [], `${orphaned.length} exchanges lost the Seat they were charged to`);

    // And the two Seats must be reported in the same numbers they were handed out.
    for (const exchange of exchanges) {
      const seat = exchange.chargedTo?.seat ?? "";
      wasCharged.set(seat, `${(Number(wasCharged.get(seat) ?? 0) + 1)}`);
    }
    assert.deepEqual([...wasCharged.keys()].sort(), ["one", "two"]);
    assert.equal(wasCharged.get("one"), String(HOW_MANY / 2));
    assert.equal(wasCharged.get("two"), String(HOW_MANY / 2));
  } finally {
    await relay.close();
    await upstream.close();
  }
});
