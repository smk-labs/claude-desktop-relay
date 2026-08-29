/**
 * The local certificate authority the relay presents when it opens a host.
 *
 * Nothing else in the repo knows that `openssl` exists. The authority is minted
 * once into a folder the user owns and read on every start after that, because
 * the machine has been told to trust that exact certificate: regenerating it
 * would silently break every Code session until the trust was updated. Renewing
 * is deleting the folder.
 */
export type { Authority } from "./internal/mint.ts";
export { ensureAuthority } from "./internal/mint.ts";
