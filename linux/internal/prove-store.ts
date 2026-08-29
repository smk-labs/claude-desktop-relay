/**
 * Prove the storage key before writing anything with it.
 *
 * The Linux scheme differs from the macOS one by a single number: one derivation
 * round instead of 1003. Get it wrong and the app cannot read what we wrote, and
 * it does not say so anywhere the user is looking; it simply carries on with no
 * variables. That is the worst shape a failure can have, so it is ruled out by
 * measurement rather than by care.
 *
 * The measurement: decrypt something the app itself encrypted. Chromium locks
 * cookie values with the same key and the same `v11` scheme, and the app's own
 * cookie store sits in the Desktop folder. If our key opens one of those, the key
 * and every constant around it are right. Nothing of what comes out is read,
 * kept, or reported: the only answer taken from it is yes or no.
 */
import { readFile } from "node:fs/promises";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { join } from "node:path";

const V11 = Buffer.from("v11", "utf8");
const IV = Buffer.alloc(16, 0x20);
/** Block lengths worth trying. A cookie value is short; this is not a search. */
const LENGTHS = [16, 32, 48, 64, 80, 96, 112, 128];

export async function theKeyIsRight(options: { desktopFolder: string; password: string }): Promise<boolean> {
  const key = pbkdf2Sync(options.password, "saltysalt", 1, 16, "sha1");
  const cookies = await readFile(join(options.desktopFolder, "Cookies")).catch(() => null);
  if (cookies === null) return false;

  for (let at = 0; at < cookies.length - V11.length; at++) {
    if (cookies[at] !== V11[0] || cookies[at + 1] !== V11[1] || cookies[at + 2] !== V11[2]) continue;

    for (const length of LENGTHS) {
      const body = cookies.subarray(at + V11.length, at + V11.length + length);
      if (body.length < length) continue;
      try {
        const decipher = createDecipheriv("aes-128-cbc", key, IV);
        // The padding check inside `final` is the whole test: a wrong key gives
        // random bytes, and random bytes are valid PKCS#7 about once in 256 tries,
        // which is why one success is taken and the search stops.
        const out = Buffer.concat([decipher.update(body), decipher.final()]);
        if (out.length > 0) return true;
      } catch {
        // Wrong length or wrong key for this blob. Try the next.
      }
    }
  }

  return false;
}
