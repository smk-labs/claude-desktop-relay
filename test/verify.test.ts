import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  judge,
  exitCodeFor,
  describeVerdict,
  openVerdictLog,
  watchExchanges,
  type Verdict,
} from "../src/verify/index.ts";
import { startRelay, type Exchange } from "../src/relay/index.ts";
import { aWindowUnder, relayHome } from "../src/home/index.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";
import { requestThrough } from "./helpers/through-the-relay.ts";
import { LIKE_CODE, paying } from "./helpers/a-decision.ts";
import { until, untilThereAre } from "./helpers/until.ts";

const OPEN_HOST = "api.anthropic.com";

after(forgetAuthorities);

function anExchange(over: Partial<Exchange> = {}): Exchange {
  return {
    method: "POST",
    path: "/v1/messages",
    status: 200,
    refused: false,
    swapped: true,
    chargedTo: { seat: "work", organizationId: "org-acme-1a2b" },
    paidBy: "org-acme-1a2b",
    about: LIKE_CODE,
    utilization: { fiveHour: 0.1, sevenDay: 0.2 },
    overage: { status: null, disabledReason: null },
    resets: { fiveHour: null, sevenDay: null },
    replyHeaders: {},
    ...over,
  };
}

async function inTemporaryFolder<T>(run: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "relay-verdict-"));
  try {
    return await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("an answer naming the Seat's own Organization is verified, and says which Seat", () => {
  const verdict = judge(anExchange());

  assert.equal(verdict.kind, "verified");
  assert.equal(verdict.seat, "work");
  assert.equal(verdict.paidBy, "org-acme-1a2b");
  assert.equal(verdict.because, null);
  assert.equal(exitCodeFor(verdict), 0);

  const said = describeVerdict(verdict);
  assert.match(said, /work/);
  assert.match(said, /org-acme-1a2b/);
});

test("an answer naming a different Organization is a failure naming both sides", () => {
  const verdict = judge(anExchange({ paidBy: "org-somebody-else" }));

  assert.equal(verdict.kind, "mismatch");
  assert.notEqual(exitCodeFor(verdict), 0, "a mismatch must exit non-zero");

  const said = describeVerdict(verdict);
  assert.match(said, /work/, "the Seat that was chosen must be named");
  assert.match(said, /org-acme-1a2b/, "and the Organization it should have been");
  assert.match(said, /org-somebody-else/, "and the one that actually paid");
});

test("an answer that names no Organization is unverified, never verified", () => {
  const verdict = judge(anExchange({ paidBy: null }));

  assert.equal(verdict.kind, "unverified");
  assert.equal(verdict.because, "the-server-named-no-organization");
  assert.notEqual(exitCodeFor(verdict), 0);
});

test("two blanks are not agreement", () => {
  // A Seat stored with no Organization id, and a server that sent the header
  // empty, would once have matched each other and reported a proved swap.
  for (const blank of ["", "   "]) {
    const verdict = judge({
      ...anExchange({ paidBy: blank }),
      chargedTo: { seat: "work", organizationId: blank },
    });

    assert.equal(verdict.kind, "unverified", `"${blank}" must not verify anything`);
    assert.notEqual(exitCodeFor(verdict), 0);
  }
});

test("an answer that is not a success cannot prove who served the request", () => {
  // A redirect names an Organization and is not a Refusal, so nothing else here
  // would have stopped it being called verified.
  const verdict = judge(anExchange({ status: 302 }));

  assert.equal(verdict.kind, "unverified");
  assert.equal(verdict.because, "the-answer-was-not-a-success");
});

test("a request the server never answered is unverified, not a mismatch", () => {
  const verdict = judge(anExchange({ status: 0, paidBy: null }));

  assert.equal(verdict.kind, "unverified");
  assert.equal(verdict.because, "the-server-never-answered");
});

test("a Refusal that names the chosen Seat is proof the swap worked, and says it was declined", () => {
  // The Seat did pay for the attempt. Throwing that away would cost the rotation
  // in ticket 15 the only evidence it has, and ADR 0005 is about reading a
  // Refusal as exactly what it is and no more.
  const verdict = judge(anExchange({ status: 429, refused: true }));

  assert.equal(verdict.kind, "unverified", "a 429 is not a success, so it does not prove service");
  assert.equal(verdict.refused, true);
  assert.equal(verdict.paidBy, "org-acme-1a2b", "but who paid is still recorded");
  assert.match(describeVerdict(verdict), /429/);
});

test("an exchange the relay never swapped is unverified rather than verified", () => {
  const verdict = judge(anExchange({ swapped: false, paidBy: "org-the-window" }));

  assert.equal(verdict.kind, "unverified");
  assert.equal(verdict.because, "the-relay-did-not-swap");
});

test("no Seat chosen is unverified and says so", () => {
  const verdict = judge({ ...anExchange({ swapped: false }), chargedTo: null });

  assert.equal(verdict.kind, "unverified");
  assert.equal(verdict.because, "no-seat-was-chosen");
  assert.match(describeVerdict(verdict), /Window account/);
});

test("nothing kept on disk is English, so rewording does not rewrite records", async () => {
  await inTemporaryFolder(async (folder) => {
    const log = openVerdictLog({ file: join(folder, "verdict.json") });
    await log.record(judge(anExchange()));

    const kept = JSON.stringify(await log.last());
    assert.ok(!/paid, confirmed by/.test(kept), `a sentence was stored: ${kept}`);
    assert.ok(kept.includes("org-acme-1a2b"), "the facts are what is stored");
  });
});

test("the verdict can be read back by a second reader, with nothing running", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "verdict.json");
    assert.equal(await openVerdictLog({ file }).last(), null, "nothing recorded reads as nothing");

    const log = openVerdictLog({ file });
    await log.record(judge(anExchange()));
    await log.record(judge(anExchange({ paidBy: "org-somebody-else" })));

    assert.equal((await openVerdictLog({ file }).last())?.kind, "mismatch");
  });
});

test("a fake upstream naming the wrong Organization produces the loud failure, and it is on disk after", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "verdict.json");
    const upstream = await startFakeUpstream(OPEN_HOST);
    upstream.reply = {
      headers: { "anthropic-organization-id": "org-not-the-one-you-picked" },
      parts: ["ok"],
    };

    const authority = await authorityFor(OPEN_HOST);
    const seen: Verdict[] = [];

    const relay = await startRelay({
      openHost: OPEN_HOST,
      certificate: authority.leaf,
      trust: [upstream.authority],
      dial: () => ({ host: "127.0.0.1", port: upstream.port }),
      chargeFor: () => paying({ token: "sk-ant-oat01-work", seat: "work", organizationId: "org-acme-1a2b" }),
      onExchange: watchExchanges({ file, onVerdict: (v) => seen.push(v) }),
    });

    try {
      const answer = await requestThrough({
        relay: relay.address,
        host: OPEN_HOST,
        port: 443,
        trust: upstream.authority,
        path: "/v1/messages",
        body: "{}",
      });

      assert.equal(answer.status, 200, "the server was perfectly happy, which is the point");
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.kind, "mismatch", "the app must not report a success it has not checked");
      assert.notEqual(exitCodeFor(seen[0] as Verdict), 0);

      // The criterion is that this is readable afterwards, with nothing running.
      // Waited for rather than slept through: the write is deliberately not
      // awaited by the relay, so the test is the thing that has to wait.
      const kept = await until(() => openVerdictLog({ file }).last());
      assert.equal(kept?.kind, "mismatch");
      assert.match(describeVerdict(kept as Verdict), /org-not-the-one-you-picked/);
    } finally {
      await relay.close();
      await upstream.close();
    }
  });
});

test("the home folder keeps everything of ours in one place", () => {
  // Built with this machine's own separator, because the question is whether
  // every path lands under the home, and the two machines spell that differently.
  const under = join(tmpdir(), "somewhere", "of", "ours");
  const home = relayHome(aWindowUnder(under));

  for (const path of [home.seatsFile, home.verdictFile, home.certificateFolder, home.choiceFile]) {
    assert.ok(path.startsWith(under + sep), `${path} escapes the home folder`);
  }
  assert.ok(!JSON.stringify(home).includes("Claude.app"), "nothing of ours goes in the app bundle");
});

test("verdicts arriving together are all written, and a failure does not stop the relay", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "verdict.json");
    const problems: string[] = [];
    const watch = watchExchanges({ file, onProblem: (summary) => problems.push(summary) });

    // Four exchanges in the same millisecond is ordinary: a Code session opens
    // with several requests at once. These used to collide on one temporary name
    // and the loser took the process down.
    for (const status of [200, 200, 200, 200]) watch(anExchange({ status }));

    assert.equal((await until(() => openVerdictLog({ file }).last()))?.kind, "verified");
    assert.deepEqual(problems, [], problems.join("\n"));
  });
});

test("a verdict that cannot be written is reported rather than thrown", async () => {
  const problems: string[] = [];
  // A path that cannot be created, because a file sits where a folder would go.
  await inTemporaryFolder(async (folder) => {
    const inTheWay = join(folder, "not-a-folder");
    await (await import("node:fs/promises")).writeFile(inTheWay, "");

    const watch = watchExchanges({
      file: join(inTheWay, "verdict.json"),
      onProblem: (summary) => problems.push(summary),
    });

    watch(anExchange());
    await untilThereAre(1, () => problems);
    assert.equal(problems.length, 1, "the problem must be reported");
    assert.match(problems[0] ?? "", /verdict could not be written/);
  });
});

test("requests the relay was never asked to move do not become the verdict", async () => {
  await inTemporaryFolder(async (folder) => {
    const file = join(folder, "verdict.json");
    const watch = watchExchanges({ file });

    watch(anExchange());
    assert.equal((await until(() => openVerdictLog({ file }).last()))?.kind, "verified");

    // A Code session makes many of these: settings, telemetry, a registry
    // listing. None of them is evidence about who paid for the work.
    watch(anExchange({ swapped: false, path: "/api/event_logging/v2/batch" }));
    watch(anExchange({ swapped: false, path: "/api/claude_code/settings", status: 401, refused: true }));

    // Nothing to wait for here, deliberately: the assertion is that these two
    // changed nothing, and waiting for a change that must not happen is the one
    // case where a moment's pause is the only honest tool.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const kept = await openVerdictLog({ file }).last();
    assert.equal(kept?.kind, "verified", "the swap that was proved must still be what is reported");
    assert.equal(kept?.path, "/v1/messages");
  });
});
