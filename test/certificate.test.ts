import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";

import { ensureAuthority } from "../src/certificate/index.ts";
import { ON_WINDOWS } from "../src/home/index.ts";

async function inTemporaryFolder<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "relay-certificate-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the leaf is signed by the authority and names the host it is for", async () => {
  await inTemporaryFolder(async (directory) => {
    const authority = await ensureAuthority(directory, "api.anthropic.com");

    const ca = new X509Certificate(authority.caCertificate);
    const leaf = new X509Certificate(authority.leaf.cert);

    assert.equal(leaf.checkIssued(ca), true, "the leaf must be issued by the authority");
    assert.equal(leaf.verify(ca.publicKey), true, "the leaf's signature must check out");
    assert.equal(leaf.checkHost("api.anthropic.com"), "api.anthropic.com");
    assert.equal(leaf.checkHost("example.com"), undefined);
    assert.equal(ca.ca, true, "the authority must be able to sign");
  });
});

test("minting twice keeps the certificate the machine was told to trust", async () => {
  await inTemporaryFolder(async (directory) => {
    const first = await ensureAuthority(directory, "api.anthropic.com");
    const second = await ensureAuthority(directory, "api.anthropic.com");

    assert.equal(second.caCertificate, first.caCertificate);
    assert.equal(second.leaf.cert, first.leaf.cert);
    assert.equal(second.leaf.key, first.leaf.key);
  });
});

test("the authority's certificate is on disk where the machine can be pointed at it", async () => {
  await inTemporaryFolder(async (directory) => {
    const authority = await ensureAuthority(directory, "api.anthropic.com");

    assert.equal(authority.caCertificatePath, join(directory, "ca.crt"));
    assert.equal(await readFile(authority.caCertificatePath, "utf8"), authority.caCertificate);
    // Windows reports one mode for every directory whatever was asked for, so
    // this asserts nothing there. The certificate's own folder is inside the
    // user's home on both machines, which is the guarantee that carries.
    if (!ON_WINDOWS) assert.equal((await stat(directory)).mode & 0o777, 0o700);
  });
});

test("no request or extension leftovers stay in the folder", async () => {
  await inTemporaryFolder(async (directory) => {
    await ensureAuthority(directory, "api.anthropic.com");
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(directory)).sort();
    assert.deepEqual(names.filter((n) => n.endsWith(".csr") || n.endsWith(".ext")), []);
  });
});
