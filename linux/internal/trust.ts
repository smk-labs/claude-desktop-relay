/**
 * Put everything a Code session needs into the Window's own store: the relay's
 * address and our certificate.
 *
 * The address could also be handed over at launch, and on macOS that is what
 * happens. Here it goes in the store as well, and the reason is the whole point
 * of this file: the store is applied to a Code session's environment whatever
 * started the app. So a Window opened from the desktop, from a menu, from a
 * shortcut somebody made a month ago, is relayed exactly like one opened by our
 * launcher. Nobody has to remember a command for the thing to work, and that is
 * worth more than the tidiness of having one way in.
 *
 * The certificate needs two variables, and the second is not optional: ours alone
 * would replace the bundle the app computed rather than adding to it, and a Code
 * session that trusted only us could not reach anything else. Together they mean
 * "the system's authorities, and this one as well".
 */
import { certificateVariables, CERTIFICATE_VARIABLES } from "../../src/app-store/index.ts";
import { proxyVariables } from "../../src/window/index.ts";
import { openEnvironmentStore, environmentStoreFileOn, safeStoragePassword } from "./app-store-linux.ts";
import { theKeyIsRight } from "./prove-store.ts";

export { CERTIFICATE_VARIABLES };

/** Exactly the names `trustTheRelay` writes, so a check cannot ask for others. */
export function everythingTheStoreCarries(options: { port: number; caCertificate: string }): Readonly<Record<string, string>> {
  return {
    ...proxyVariables({ host: "127.0.0.1", port: options.port }),
    ...certificateVariables(options.caCertificate),
  };
}

/** What was done, so the caller can say it rather than guess. */
export type Armed = { readonly file: string; readonly certificate: string; readonly keyProved: boolean };

export async function trustTheRelay(options: {
  readonly desktopFolder: string;
  readonly caCertificate: string;
  /** Where the relay answers, so the store can carry the address as well. */
  readonly port: number;
  readonly sessionBus?: string;
}): Promise<Armed> {
  const password = await safeStoragePassword(
    options.sessionBus === undefined ? {} : { sessionBus: options.sessionBus },
  );

  // Proved before it is used, never after. A store written with the wrong key
  // looks exactly like a store that works until a Code session fails.
  const keyProved = await theKeyIsRight({ desktopFolder: options.desktopFolder, password });
  if (!keyProved) {
    throw new Error(
      `the key from the login keyring does not open anything Claude Desktop encrypted, so writing its ` +
        `environment store with it would leave the app unable to read it. Nothing was written.`,
    );
  }

  const file = environmentStoreFileOn(options.desktopFolder);
  const store = openEnvironmentStore({ file, password: async () => password });
  await store.put({
    ...proxyVariables({ host: "127.0.0.1", port: options.port }),
    ...certificateVariables(options.caCertificate),
  });

  return { file, certificate: options.caCertificate, keyProved };
}

/** What the store says it holds, or null when it cannot be opened from here. */
export async function whatTheWindowTrusts(options: {
  readonly desktopFolder: string;
  readonly sessionBus?: string;
}): Promise<Record<string, string> | null> {
  return openEnvironmentStore({
    file: environmentStoreFileOn(options.desktopFolder),
    password: () =>
      safeStoragePassword(options.sessionBus === undefined ? {} : { sessionBus: options.sessionBus }),
  })
    .read()
    .catch(() => null);
}
