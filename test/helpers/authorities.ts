import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAuthority, type Authority } from "../../src/certificate/index.ts";

const folders: string[] = [];
const cache = new Map<string, Promise<Authority>>();

/**
 * An authority and a leaf for `host`, minted once per test run because minting
 * costs tens of milliseconds and nothing in these tests changes it.
 *
 * Two calls with different hosts give two unrelated authorities, which is what
 * lets a test prove the relay did not open a host: the relay trusts one of them
 * and the client trusts the other.
 */
export function authorityFor(host: string): Promise<Authority> {
  const existing = cache.get(host);
  if (existing !== undefined) return existing;

  const minted = (async () => {
    const folder = await mkdtemp(join(tmpdir(), "relay-test-ca-"));
    folders.push(folder);
    return ensureAuthority(folder, host);
  })();

  cache.set(host, minted);
  return minted;
}

/** Remove every folder `authorityFor` created. */
export async function forgetAuthorities(): Promise<void> {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
  folders.length = 0;
  cache.clear();
}
