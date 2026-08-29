/**
 * The Seats: one account in one organization, each with a Send token.
 *
 * The list of Seats is a file the user can read. The Send tokens are not in it:
 * they live in the machine's own secret store, the Keychain on macOS and
 * `CryptProtectData` on Windows, under one service name so that removing every
 * trace of this program is one command.
 *
 * Everything that pays goes through `machineVault` below and never learns which
 * machine it is on. The store itself is named on the interface anyway, because
 * `relay uninstall` has to say what it is about to take out and the check on the
 * secret store has to reach the real one. `src/stats-login` runs `security`
 * itself as well, for a different secret in a different store: the cookies the
 * browser holds, which are not ours to put in the Keychain.
 */
export type { Vault } from "./internal/vault.ts";
export type { Seat, ListedSeat, Multiplier, Organization, SeatStore } from "./internal/store.ts";
export { openSeatStore } from "./internal/store.ts";
export { keychainVault, everySeatHeldInTheKeychain, SERVICE as KEYCHAIN_SERVICE } from "./internal/keychain.ts";
export { windowsVault, everySeatHeldOnWindows, WHERE_TOKENS_LIVE } from "./internal/windows-vault.ts";

import { ON_WINDOWS } from "../home/index.ts";
import { keychainVault, everySeatHeldInTheKeychain } from "./internal/keychain.ts";
import { windowsVault, everySeatHeldOnWindows } from "./internal/windows-vault.ts";
import type { Vault } from "./internal/vault.ts";

/**
 * Where this machine keeps secrets, whichever machine it is.
 *
 * The Keychain on macOS, `CryptProtectData` on Windows. Both are the same thing
 * from here: a store that belongs to the logged-in user, that this program did
 * not have to invent a key for, and that is shared by every relay on the machine.
 * That last property is why the choice is made here and not per command: a relay
 * that reached a different store than the one a sitting filled would report every
 * Seat as empty while every token sat there untouched.
 */
export function machineVault(): Vault {
  return ON_WINDOWS ? windowsVault() : keychainVault();
}

/**
 * Every Seat name this machine holds a Send token for, whatever any list says.
 *
 * Asked before an undo, so a relay can leave alone the tokens that belong to
 * another one. See the refusal in `src/control`, and ADR 0012 for why the store
 * being shared is the whole point.
 */
export function everySeatHeld(): Promise<string[]> {
  return ON_WINDOWS ? everySeatHeldOnWindows() : everySeatHeldInTheKeychain();
}
