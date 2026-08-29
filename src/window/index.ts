/**
 * Pointing the Window at the relay, and reading what the machine already does.
 *
 * The proxy variables are handed to the Window at launch and survive into the Code
 * sessions it starts. The certificate variable cannot come this way, which is why
 * there is a second module for the app's own store: see `src/app-store` and ADR
 * 0006.
 *
 * Nothing here writes inside the Claude Desktop bundle. It is read, and started,
 * and never modified, so its signature stays valid.
 *
 * One Window is never closed by anything in this program: the one the user is
 * working in. A Window on a Desktop folder of its own can be closed and opened
 * freely, which is what makes a Proving Window worth having, and `closeWindowOn`
 * is where that line is drawn rather than remembered.
 */
export type { Address } from "./internal/proxy-variables.ts";
export { proxyVariables } from "./internal/proxy-variables.ts";
export { machineProxy, readMachineProxy, machineEgress, machineEgressFrom, readSocksProxy } from "./internal/machine-proxy.ts";
export { windowsEgress, windowsEgressFrom, readWindowsProxy, readWindowsSocks } from "./internal/windows-proxy.ts";
export { launchWindow, openArguments, whatToAdd, windowExecutable, CLAUDE_DESKTOP } from "./internal/launch.ts";
export type { Closed } from "./internal/running.ts";
export {
  isWindowRunning,
  isWindowRunningOn,
  closeWindowOn,
  runningIn,
  runningOn,
  appLinesIn,
  pidsRunningOn,
  readProcessList,
  holdingItsOwnLock,
} from "./internal/running.ts";
