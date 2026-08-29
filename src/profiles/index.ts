/**
 * The Claude Desktop profiles on this machine: which exist, which is relayed,
 * which is running, and how to start one.
 *
 * One Desktop folder is one profile (ADR 0012), and only some of them are relayed.
 * Everything here is read from the folders themselves, so a profile made tomorrow
 * appears without anybody editing a list. Nothing here closes a Window and nothing
 * here changes whether a profile is relayed: that is `relay install`, run against
 * that profile's own home.
 */
export type { Profile, Relayed } from "./internal/find.ts";
export type { Account } from "./internal/identity.ts";
export { readAccount, tokensFrom, accountFrom, signedInAs, A_NAME_KEEPS_FOR } from "./internal/identity.ts";
export {
  findProfiles,
  openProfiles,
  nameFor,
  namesApart,
  openNow,
  relayedBy,
  looksLikeAProfile,
  whereProfilesLive,
  shorten,
} from "./internal/find.ts";
export { asFromTheDock, fromTheDock, isOurs, loginPath } from "./internal/environment.ts";
export type { Opened } from "./internal/open.ts";
export { openProfile } from "./internal/open.ts";
