import type { BrowserProfile } from "../../browser/index.ts";
import type { Seat } from "../../seats/index.ts";

/**
 * What is said before a Seat is minted, so the browser profile can be got ready
 * while the one before it finishes.
 *
 * A value rather than four printed lines, because the same announcement has to
 * reach a terminal and a page, and two places writing their own version of it is
 * how the two stop agreeing about which account is next.
 */
export type Announcement = {
  readonly seat: Seat;
  /** Where this Seat is in the run, as "3 of 15". */
  readonly position: string;
  /** The profile the link will be opened in, or null when it will be handed over. */
  readonly profile: BrowserProfile | null;
};

/**
 * The announcement in words, in the order a person acts on them.
 *
 * The account first. The Organization second, because it has to be the active one
 * before the link is authorized and it is the likeliest thing to be wrong. The
 * profile last, as a name to have in front: `claude` opens the link itself, in
 * whichever profile the browser puts there, so this says which one that should be
 * rather than deciding it.
 */
export function announcementInWords(what: Announcement): readonly string[] {
  const { seat } = what;
  return [
    `-- ${what.position} --  ${seat.name}`,
    `   Account          ${seat.account}`,
    `   Organization     ${seat.organization.label}  (${seat.organization.id})`,
    what.profile === null
      ? `   Chrome profile   not known, so put the right one in front yourself`
      : `   Chrome profile   ${what.profile.label}  (${what.profile.directory})  <- have this one in front`,
  ];
}

/**
 * The one sentence that says what is about to happen, for a confirmation.
 *
 * Names the account and the Organization together, because a Seat is one account
 * in one Organization and confirming only half of that is confirming nothing.
 */
export function whatIsAboutToHappen(what: Announcement): string {
  return (
    `Sign in as ${what.seat.account} with "${what.seat.organization.label}" active` +
    (what.profile === null ? `` : `, in ${what.profile.label}`)
  );
}
