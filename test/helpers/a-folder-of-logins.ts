import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ON_WINDOWS } from "../../src/home/index.ts";

/**
 * A stand-in for the folder of old logins, so no test reads the real one.
 *
 * The cookie stores here are written by this file rather than by the module that
 * reads them: the encryption is spelled out again from the format, so the reader
 * is proved against something other than itself. A reader and a writer that share
 * one implementation agree even when both are wrong.
 */
export type FolderOfLogins = {
  readonly folder: string;
  /** The key the stores were written with, handed to the reader in place of the Keychain. */
  readonly key: Buffer;
  close(): Promise<void>;
};

/**
 * Chromium's `v10` scheme, in this machine's own form, written out from the
 * format rather than shared with the reader.
 *
 * The two forms share a name and a three byte prefix and nothing else: macOS is
 * AES-128-CBC under a stretched key with a fixed initialisation vector, Windows
 * is AES-256-GCM under a whole key with a fresh nonce and a tag. Writing the one
 * this machine actually uses is the point: a store in the other machine's form
 * would prove nothing about the reader that has to open a real one here.
 */
function encryptV10(key: Buffer, plain: Buffer): Buffer {
  if (ON_WINDOWS) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from("v10"), nonce, body, cipher.getAuthTag()]);
  }

  const padding = 16 - (plain.length % 16);
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  cipher.setAutoPadding(false);
  return Buffer.concat([Buffer.from("v10"), cipher.update(padded), cipher.final()]);
}

/**
 * A folder of cookie stores. Each entry is a login name against the session key
 * it holds, or null for a store that has one no more.
 *
 * The plaintext carries the 32 bytes Chromium puts before the value, so what the
 * reader has to strip is really there.
 */
export async function aFolderOfLogins(
  logins: Readonly<Record<string, string | null>>,
): Promise<FolderOfLogins> {
  const folder = await mkdtemp(join(tmpdir(), "relay-logins-"));
  /**
   * The key these stores are locked with, in the shape this machine's Claude
   * Desktop would have. Never the machine's own: no test may reach the Keychain,
   * and none may reach a real profile's `Local State` either.
   */
  const key = ON_WINDOWS
    ? Buffer.alloc(32, 9)
    : pbkdf2Sync("a password no keychain was asked for", "saltysalt", 1003, 16, "sha1");

  for (const [name, sessionKey] of Object.entries(logins)) {
    const where = join(folder, name);
    await mkdir(where, { recursive: true });

    // Only the three columns the reader names, which is also the proof that it
    // does not depend on the rest of a real store's schema.
    const db = new DatabaseSync(join(where, "Cookies"));
    db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB)");

    if (sessionKey !== null) {
      const plain = Buffer.concat([Buffer.alloc(32, 7), Buffer.from(sessionKey, "utf8")]);
      db.prepare("INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)").run(
        ".claude.ai",
        "sessionKey",
        encryptV10(key, plain),
      );
    }

    // Something else of the account's, so a store with rows but no login is not
    // mistaken for an empty one.
    db.prepare("INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)").run(
      ".claude.ai",
      "lastActiveOrg",
      encryptV10(key, Buffer.from("something else entirely", "utf8")),
    );
    db.close();
  }

  return { folder, key, close: () => rm(folder, { recursive: true, force: true }) };
}

/** One account's answer from `claude.ai/api/bootstrap`, in the shape it really arrives in. */
export function aBootstrapAnswer(
  email: string,
  memberships: ReadonlyArray<{
    uuid: string;
    name: string;
    rate_limit_tier: string;
    capabilities: string[];
    raven_type?: string | null;
    seat_tier?: string | null;
  }>,
): unknown {
  return {
    account: {
      uuid: "3041526a-0000-4000-8000-00000000000c",
      email_address: email,
      memberships: memberships.map((organization) => ({
        seat_tier: organization.seat_tier ?? null,
        organization: {
          uuid: organization.uuid,
          name: organization.name,
          rate_limit_tier: organization.rate_limit_tier,
          raven_type: organization.raven_type ?? null,
          capabilities: organization.capabilities,
        },
      })),
    },
  };
}
