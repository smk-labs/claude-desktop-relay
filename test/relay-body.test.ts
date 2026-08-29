import { strict as assert } from "node:assert";
import { test, after } from "node:test";

import { startRelay, type RequestShape } from "../src/relay/index.ts";
import { shapeOf } from "../src/conversation/index.ts";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { requestThrough } from "./helpers/through-the-relay.ts";
import { paying } from "./helpers/a-decision.ts";

const OPEN_HOST = "api.anthropic.com";

after(forgetAuthorities);

async function relayWith(upstream: FakeUpstream, asked: RequestShape[]) {
  const authority = await authorityFor(OPEN_HOST);
  return startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    chargeFor: (request) => {
      asked.push(request);
      return paying({ token: "sk-ant-oat01-seat-a", seat: "seat-a", organizationId: "org-seat-a" });
    },
  });
}

test("the body reaches whoever decides who pays, and arrives at the upstream unchanged", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const asked: RequestShape[] = [];
  const relay = await relayWith(upstream, asked);
  try {
    const body = JSON.stringify({
      model: "claude-opus-5",
      metadata: { user_id: JSON.stringify({ session_id: "session-one" }) },
      messages: [{ role: "user", content: "what does this repository do?" }],
    });

    await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      headers: [["Authorization", "Bearer sk-ant-oat01-the-window-account"]],
      body,
    });

    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.body?.toString("utf8"), body, "the whole body, exactly as it was written");
    assert.equal(upstream.seen[0]?.body, body, "and the upstream sees the same bytes");
    assert.equal(shapeOf(asked[0]?.body ?? null).session, "session-one");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("a path where nothing is swapped never has its body held", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const asked: RequestShape[] = [];
  const relay = await relayWith(upstream, asked);
  try {
    await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/models",
      body: `{"anything":"at all"}`,
    });

    assert.deepEqual(asked, [], "who pays is not even asked on a path that is not paid for by the Payer");
    assert.equal(upstream.seen[0]?.body, `{"anything":"at all"}`);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The one that would lose a request if the limit were done the obvious way.
 *
 * Reading a stream with `for await` and returning early destroys it, so a body
 * over the limit would reach the upstream truncated and the failure would look
 * like the server rejecting a valid request. Put that back and this fails on the
 * byte count.
 */
test("a body longer than the relay will hold still arrives whole, with its shape unknown", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const asked: RequestShape[] = [];
  const relay = await relayWith(upstream, asked);
  try {
    // Comfortably past the four megabytes the relay is willing to hold.
    const filler = "x".repeat(5 * 1024 * 1024);
    const body = JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: filler }] });

    await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body,
    });

    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.body, null, "too long to hold reads as unknown, never as an empty body");
    assert.equal(upstream.seen[0]?.body.length, body.length, "and not one byte of the request is lost");
    assert.equal(upstream.seen[0]?.body, body);
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test("a request with no body at all is answered without waiting for one", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const asked: RequestShape[] = [];
  const relay = await relayWith(upstream, asked);
  try {
    const answer = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      method: "GET",
    });

    assert.equal(answer.status, 200);
    assert.equal(asked[0]?.body?.length, 0, "an empty body is empty, and is not mistaken for a missing one");
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The turn, handed back when deciding who pays throws.
 *
 * Not a hypothetical: a turn is the scarce thing that stands between a burst and
 * the collapse of 2026-08-22, and one leaked per request wedges the relay for the
 * life of the process. With two turns allowed, three requests that throw would
 * leave nothing for the fourth. Take `handBack` out of the catch in
 * `internal/open.ts` and this test hangs until its timeout.
 */
test("a decider that throws hands its turn back, so the relay keeps serving", async () => {
  const upstream = await startFakeUpstream(OPEN_HOST);
  const authority = await authorityFor(OPEN_HOST);
  let asked = 0;

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    atMostInFlight: 2,
    chargeFor: () => {
      asked += 1;
      if (asked <= 3) throw new Error("the Seats could not be read at all");
      return paying({ token: "sk-ant-oat01-seat-a", seat: "seat-a", organizationId: "org-seat-a" });
    },
  });

  const ask = () =>
    requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body: `{"model":"claude-opus-5","messages":[]}`,
    });

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await ask();
      assert.equal(failed.status, 502, "a decider that throws must fail closed, never charge nobody quietly");
    }

    const served = await ask();
    assert.equal(served.status, 200, "the fourth request found no turn left");
    assert.equal(asked, 4);
  } finally {
    await relay.close();
    await upstream.close();
  }
});
