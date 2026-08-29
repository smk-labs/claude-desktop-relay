/**
 * What an account's own claude.ai login can tell us about the Seats it owns.
 *
 * A Stats login can read and never sends (ADR 0002), so this is the only place
 * that knows an account's email, the Organizations it belongs to, and what each
 * one is worth. Nothing outside this module knows that those logins live in
 * cookie stores, that the stores are encrypted, or that claude.ai is asked, and
 * no Stats login ever travels out of here: what comes back is identity and
 * capacity, never a credential.
 */
export type {
  AccountAsRead,
  AllowanceAsRead,
  UsageAsRead,
  AccountUnread,
  CannotPay,
  OrganizationAsRead,
  WhatWasRead,
} from "./internal/read-shapes.ts";
export { readAccounts, WHERE_THE_STATS_LOGINS_ARE } from "./internal/read.ts";
export type { KeptLogin } from "./internal/kept.ts";
export {
  keptStatsLogins,
  keepStatsLogins,
  importStatsLogins,
  WHERE_STATS_LOGINS_ARE_KEPT,
} from "./internal/kept.ts";
/**
 * Whether a Desktop folder holds a login, without the login coming out.
 *
 * On the interface because copying a Window's login into a Proving Window has to be
 * checked rather than hoped for, and the check must not be a reason for a session
 * key to leave this module. A fingerprint answers "the same one?" and is far too
 * little to be one.
 */
export type { LoginThere } from "./internal/there.ts";
export { loginIn } from "./internal/there.ts";
