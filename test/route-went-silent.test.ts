import { strict as assert } from "node:assert";
import { test } from "node:test";

import { startRelay, type RelayNotice } from "../src/relay/index.ts";
import { paying } from "./helpers/a-decision.ts";
import { authorityFor } from "./helpers/authorities.ts";
import { startSilentUpstream } from "./helpers/fake-upstream.ts";
import { requestThrough } from "./helpers/through-the-relay.ts";

const OPEN_HOST = "api.anthropic.com";
const BODY = `{"model":"claude-opus-5","messages":[{"role":"user","content":"hi"}]}`;

/**
 * The failure this guards against, measured twice on 2026-08-24.
 *
 * A tunnel through the machine's proxy dies without closing. The proxy is an app on
 * loopback, so it keeps accepting connections and no dial ever fails: the relay is
 * never told the route is gone. Each exchange then holds its turn at the gate until
 * the three-minute silence guard fires. Twelve did, which is the whole gate, and
 * everything behind them waited. The user saw the app disconnect for minutes.
 *
 * The cure is not a shorter guard. It is treating the first casualty as evidence
 * about the road: one exchange paying the guard means every other exchange on that
 * route is riding the same dead tunnel, so they are hung up on at once and dial
 * afresh, instead of each waiting its own full guard.
 */
test("one exchange dying of silence frees every other exchange on the same route", async () => {
  const upstream = await startSilentUpstream(OPEN_HOST);
  const authority = await authorityFor(OPEN_HOST);
  const notices: RelayNotice[] = [];

  // Short enough to be a test, long enough that several requests are genuinely in
  // the air together. The number is the guard; what is asserted is what it costs.
  const GUARD_MS = 400;
  const AT_ONCE = 6;
  // Started a step apart, because that is how they wedge in life: a route dies
  // under connections that were opened at different moments, so their guards would
  // fire at different moments too. Without the cure the last one to start is the
  // last to die, and everything waits for it. With it, the first casualty settles
  // the question for all of them at once.
  const STEP_MS = 120;

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    silentFor: GUARD_MS,
    chargeFor: () => paying({ token: "sk-ant-oat01-seat-a", seat: "seat-a", organizationId: "org-seat-a" }),
    onNotice: (notice) => notices.push(notice),
  });

  try {
    const began = Date.now();
    await Promise.all(
      Array.from({ length: AT_ONCE }, async (_unused, which) => {
        await new Promise((wake) => setTimeout(wake, which * STEP_MS));
        return requestThrough({
          relay: relay.address,
          host: OPEN_HOST,
          port: 443,
          trust: upstream.authority,
          path: "/v1/messages",
          body: BODY,
        }).then(
          () => "answered",
          () => "gave up",
        );
      }),
    );
    const took = Date.now() - began;

    /**
     * What this proves, and what it does not.
     *
     * Every exchange that was in the air when the first casualty fired is hung up
     * on with it, so they end together instead of each waiting its own guard. An
     * exchange that starts *after* that moment cannot know the route is dead and
     * pays its own guard to find out, which is why the bound below is generous:
     * the claim is "they were freed together", not "nothing ever waits".
     */
    const eachWaitsItsOwn = (AT_ONCE - 1) * STEP_MS + GUARD_MS;
    assert.ok(took <= eachWaitsItsOwn, `${took}ms is no better than one at a time, ${eachWaitsItsOwn}ms`);

    const silent = notices.filter((one) => one.kind === "upstream-went-silent");
    assert.ok(silent.length > 0, "the silence has to be reported as being about the route");
    /**
     * The mechanism itself, which is the part that does not depend on timing: one
     * casualty took more than one connection down with it. Without the cure this
     * line is absent entirely, because nothing connects a silent exchange to the
     * others riding the same route.
     */
    const hungUp = silent
      .map((one) => /Hung up on (\d+) connection/.exec(one.summary))
      .filter((found) => found !== null)
      .map((found) => Number(found[1]));
    assert.ok(hungUp.length > 0, `nothing was hung up on:\n${silent.map((one) => one.summary).join("\n")}`);
    assert.ok(
      Math.max(...hungUp) >= 2,
      `the casualty freed only itself, so nothing was actually rescued: ${hungUp.join(", ")}`,
    );
  } finally {
    await relay.close();
    await upstream.close();
  }
});

/**
 * The relay has to come back on its own, because the measured cure before this was
 * restarting the service by hand and nothing should need that.
 */
test("the relay still serves the next request after a route has gone silent under it", async () => {
  const upstream = await startSilentUpstream(OPEN_HOST);
  const authority = await authorityFor(OPEN_HOST);

  const relay = await startRelay({
    openHost: OPEN_HOST,
    certificate: authority.leaf,
    trust: [upstream.authority],
    dial: () => ({ host: "127.0.0.1", port: upstream.port }),
    silentFor: 300,
    chargeFor: () => paying({ token: "sk-ant-oat01-seat-a", seat: "seat-a", organizationId: "org-seat-a" }),
    onNotice: () => {},
  });

  try {
    // A silent upstream cannot answer, so the relay answers for it: the guard fires,
    // the turn is handed back and the caller is told plainly rather than left hanging.
    const one = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body: BODY,
    }).then(
      (answer) => answer.status,
      () => 0,
    );
    assert.ok(one >= 500, `a silent upstream must not look like a success, got ${one}`);

    // The turn came back, so the next request is served rather than queued for ever.
    // It fails too, because the upstream is still silent, and that is the point: it
    // reached the upstream at all instead of waiting behind a wedged turn.
    const began = Date.now();
    const next = await requestThrough({
      relay: relay.address,
      host: OPEN_HOST,
      port: 443,
      trust: upstream.authority,
      path: "/v1/messages",
      body: BODY,
    }).then(
      (answer) => answer.status,
      () => 0,
    );
    assert.ok(next >= 500, `the second request should fail on its own terms, got ${next}`);
    assert.ok(
      Date.now() - began < 300 * 4,
      "the second request waited behind a turn that was never handed back",
    );
  } finally {
    await relay.close();
    await upstream.close();
  }
});
