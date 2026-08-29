/**
 * The relay as a service that outlives every session.
 *
 * It has to. Everything a Code session needs is written into the app's own store
 * once, and that names a fixed address, so something must be listening there after
 * a reboot and after a crash without anyone starting it by hand. ADR 0009.
 *
 * A per-user login agent on macOS and a per-user login item on Windows. Per-user
 * on both, so installing it needs no administrator rights and nothing is written
 * outside the user's own home. Nothing above this line knows how either of them
 * is arranged.
 */
import { ON_WINDOWS } from "../home/index.ts";
import { launchdService, type Run, type Service } from "./internal/launchd.ts";
import { startupItemService } from "./internal/startup-item.ts";
import type { ServicePlan } from "./internal/plist.ts";

export type { ServicePlan } from "./internal/plist.ts";
export { plistFor } from "./internal/plist.ts";
export type { Service, ServiceState, Run, Ran } from "./internal/launchd.ts";
export { launchdService } from "./internal/launchd.ts";
export { startupItemService, supervisorScriptFor, startupFolder, aWindowlessRun, asVbsText } from "./internal/startup-item.ts";

/**
 * The label the service for the Window the user works in goes by.
 *
 * Two spellings, because the two machines key a background job by this name and
 * their conventions are not the same: launchd wants a reverse domain name, and on
 * Windows the label becomes the file name of the login item in the user's own
 * Startup folder, which a person reads in a folder listing. Both are keys, and
 * both are keyed on exactly this string.
 */
export const SERVICE_LABEL = ON_WINDOWS ? "claude-desktop-relay" : "com.claude-desktop-relay.agent";

/**
 * The label for the relay that serves one Window, told apart by its port.
 *
 * launchd keys everything by the label, so two relays sharing one would be one
 * job: installing the second would silently replace the first, and the Window the
 * user works in would stop being relayed the moment a Proving Window was set up.
 * The Window the user works in keeps the plain label, so nothing already installed
 * has to be reinstalled to gain this. ADR 0012.
 */
export function serviceLabelFor(port: number, theUsersPort: number): string {
  return port === theUsersPort ? SERVICE_LABEL : `${SERVICE_LABEL}.${port}`;
}

export { nameTheLauncher } from "./internal/launcher.ts";

/**
 * The relay as a service, however this machine keeps one.
 *
 * The two adapters answer the same four questions and are addressed by the same
 * label, so everything above them is one body of code: install, undo and the
 * doctor never learn which machine they are on.
 */
export function machineService(options: { plan: ServicePlan; run?: Run }): Service {
  return ON_WINDOWS ? startupItemService(options) : launchdService(options);
}
