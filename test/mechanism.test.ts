import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";

import { inspect, type WhatToCheck } from "../src/mechanism/index.ts";
import { authorityFor, forgetAuthorities } from "./helpers/authorities.ts";

after(forgetAuthorities);

async function aSetup(over: Partial<WhatToCheck> = {}) {
  const folder = await mkdtemp(join(tmpdir(), "relay-mechanism-"));
  const authority = await authorityFor("api.anthropic.com");
  const storeFile = join(folder, "ccd-environment-config.json");
  await writeFile(storeFile, "{}");

  const relay = createServer();
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const port = (relay.address() as { port: number }).port;

  const wanted = { HTTPS_PROXY: `http://127.0.0.1:${port}`, NODE_EXTRA_CA_CERTS: authority.caCertificatePath };

  return {
    folder,
    what: {
      storeFile,
      wanted,
      reading: async () => ({ ...wanted }),
      certificateFile: authority.caCertificatePath,
      relay: { host: "127.0.0.1", port },
      ...over,
    } satisfies WhatToCheck,
    async forget() {
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    },
  };
}

const saying = (found: { findings: readonly { saying: string }[] }) => found.findings.map((f) => f.saying).join("\n");

test("when everything holds, it says so and nothing else", async () => {
  const setup = await aSetup();
  try {
    const found = await inspect(setup.what);
    assert.equal(found.working, true, saying(found));
    assert.equal(found.findings.filter((f) => !f.ok).length, 0);
  } finally {
    await setup.forget();
  }
});

test("an update that moves the store is named as exactly that", async () => {
  const setup = await aSetup({ storeFile: "/nowhere/ccd-environment-config.json" });
  try {
    const found = await inspect(setup.what);
    assert.equal(found.working, false);
    assert.match(saying(found), /An update has moved it/);
  } finally {
    await setup.forget();
  }
});

test("an update that strips our variables is named as exactly that", async () => {
  const setup = await aSetup({ reading: async () => ({ HTTPS_PROXY: "http://127.0.0.1:1" }) });
  try {
    const found = await inspect(setup.what);
    assert.equal(found.working, false);
    assert.match(saying(found), /no longer carries/);
    assert.match(saying(found), /NODE_EXTRA_CA_CERTS/, "and must name which one");
    assert.match(saying(found), /stripping them/);
  } finally {
    await setup.forget();
  }
});

test("an update that changes how the store is locked is named as exactly that", async () => {
  const setup = await aSetup({
    reading: async () => {
      throw new Error("bad decrypt");
    },
  });
  try {
    const found = await inspect(setup.what);
    assert.equal(found.working, false);
    assert.match(saying(found), /will not open: bad decrypt/);
    assert.match(saying(found), /changed how it is locked/);
  } finally {
    await setup.forget();
  }
});

test("a relay nothing is listening for is named, because that is the usual cause", async () => {
  const setup = await aSetup();
  try {
    await setup.forget();
    const found = await inspect(setup.what);
    assert.equal(found.working, false);
    assert.match(saying(found), /nothing is listening on 127\.0\.0\.1:/);
    assert.match(saying(found), /cannot reach the network at all/);
  } finally {
    await rm(setup.folder, { recursive: true, force: true });
  }
});

test("a certificate about to run out is said before it does, not after", async () => {
  // Two years and a day from now, so the 730 day certificate has just gone.
  const wellPast = await aSetup({ now: () => Date.now() + 731 * 86_400_000 });
  try {
    const found = await inspect(wellPast.what);
    assert.equal(found.working, false);
    assert.match(saying(found), /expired \d+ days ago/);
  } finally {
    await wellPast.forget();
  }

  const soon = await aSetup({ now: () => Date.now() + 720 * 86_400_000 });
  try {
    const found = await inspect(soon.what);
    assert.equal(found.working, false, "a warning must count as not working, so nobody is reassured");
    assert.match(saying(found), /days left/);
    assert.match(saying(found), /before it runs out/);
  } finally {
    await soon.forget();
  }
});

test("every finding says what to do, not only what is wrong", async () => {
  const setup = await aSetup({ reading: async () => ({}) });
  try {
    const found = await inspect(setup.what);
    for (const finding of found.findings.filter((f) => !f.ok)) {
      assert.ok(finding.saying.length > 40, `too terse to act on: ${finding.saying}`);
      assert.ok(finding.what.length > 0);
    }
  } finally {
    await setup.forget();
  }
});
