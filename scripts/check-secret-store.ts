/**
 * Prove this machine's own secret store holds a Send token and gives it back
 * byte for byte.
 *
 * The Keychain on macOS, `CryptProtectData` on Windows. Both are things this
 * program does not own and cannot fake honestly, which is why no test in the
 * suite is allowed near either. Run it by hand. It writes one entry under a
 * throwaway name, reads it back, compares, and removes it, so it leaves nothing
 * behind.
 *
 *   relay check-secret-store
 */
import { machineVault, KEYCHAIN_SERVICE, WHERE_TOKENS_LIVE } from "../src/seats/index.ts";
import { ON_WINDOWS } from "../src/home/index.ts";

const vault = machineVault();
const name = `check-${process.pid}`;
const secret = "sk-ant-oat01-AaZz09-_=+/ .: end";
const where = ON_WINDOWS ? WHERE_TOKENS_LIVE : `the Keychain, under service "${KEYCHAIN_SERVICE}"`;

let held = false;
try {
  await vault.put(name, secret);
  held = true;

  const back = await vault.get(name);
  if (back !== secret) {
    console.error(`the store changed the value.\n  wrote: ${JSON.stringify(secret)}\n  read:  ${JSON.stringify(back)}`);
    process.exit(1);
  }

  await vault.forget(name);
  held = false;

  if ((await vault.get(name)) !== null) {
    console.error("the entry was still there after being forgotten");
    process.exit(1);
  }

  console.log(`this machine round-trips a Send token byte for byte: ${where}`);
} finally {
  if (held) await vault.forget(name);
}
