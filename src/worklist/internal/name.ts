import type { Organization } from "../../seats/index.ts";

/**
 * How much of an Organization's label a name may carry.
 *
 * A cap rather than a whole label, because a label is prose the user wrote: one
 * of these is "dana.ops@example.com's Organization" and another is "Eli's
 * Individual Org". The name has to be short enough to type and paste.
 */
const LABEL_AT_MOST = 12;

/**
 * How much of the Organization id a name carries.
 *
 * This is the part that makes two Seats different. Everything before it is
 * readability, and readability is not unique: this user's account `fin-user`
 * belongs to two separate Organizations that are both labelled "Acme". Four
 * hexadecimal characters is what the user's own records already write these ids
 * down as, and `buildWorklist` refuses outright rather than let two entries land
 * on one name, so this is short for reading rather than relied on for proof.
 */
const ID_AT_MOST = 4;

/** Lowercase, and nothing that would need quoting on a command line. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** At most `atMost` characters, never ending on the separator. */
function clip(text: string, atMost: number): string {
  return text.slice(0, atMost).replace(/-+$/, "");
}

/** The part of an email before the `@`, or the whole thing when there is none. */
function localPartOf(account: string): string {
  const at = account.indexOf("@");
  return at === -1 ? account : account.slice(0, at);
}

/**
 * A Seat's name, derived rather than invented.
 *
 * The user is not asked to think of a name per Seat, and the same account in the
 * same Organization always yields the same one, which is what lets a sitting be
 * abandoned halfway and picked up later: the name of the Seat being filled is a
 * fact about the Seat, not something remembered from the last run.
 *
 * The label is only ever read, never compared, so carrying part of it here is
 * safe. It is the Organization id that decides identity, which is why a piece of
 * it is in the name and why the label alone would not do.
 */
export function seatNameFor(account: string, organization: Organization): string {
  const who = slug(localPartOf(account)) || slug(account) || "account";

  // An account's own Organization is labelled with its own email, which would
  // otherwise put the whole address in the name twice over.
  const isOwn = organization.label.trim().toLowerCase() === `${account.trim().toLowerCase()}'s organization`;
  const where = isOwn ? "own" : clip(slug(organization.label), LABEL_AT_MOST) || "org";

  const which = slug(organization.id).replace(/-/g, "").slice(0, ID_AT_MOST) || "id";

  return `${who}-${where}-${which}`;
}
