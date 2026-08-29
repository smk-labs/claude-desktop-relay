/**
 * Which Chrome profile an account most likely signs in on, by name.
 *
 * A hint and nothing else. `claude setup-token` opens the authorization link
 * itself, in whichever profile the browser puts in front, so nothing here decides
 * or controls anything: the sitting prints the likeliest name before it runs, and
 * the person puts that window in front. A guess is fine for that where it would
 * not be if it decided anything.
 */
export type { BrowserProfile } from "./internal/profiles.ts";
export { browserProfiles, profilesWorthTrying, WHERE_CHROME_LISTS_ITS_PROFILES } from "./internal/profiles.ts";
