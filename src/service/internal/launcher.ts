import { mkdir, rm, symlink, realpath } from "node:fs/promises";
import { dirname } from "node:path";

import { ON_WINDOWS } from "../../home/index.ts";

/**
 * Give the running program a name a person would recognise.
 *
 * macOS shows a background item by the executable that launchd runs, so a job
 * that runs `node` directly appears in Login Items and in Activity Monitor as
 * "node". That tells the user nothing, and an unexplained "node" starting at
 * login looks like something they did not agree to.
 *
 * A link to the same binary under our own name fixes it, and costs nothing: it is
 * the same node, so there is no copy to keep up to date and no unsigned duplicate
 * of somebody else's binary.
 *
 * Windows needs no such file and does not get one. The relay starts there from a
 * `.vbs` supervisor in the user's own Startup folder, opened by `wscript.exe`,
 * which is the windowless script host: the name the user reads is that file's own,
 * and what they never see is a black console window sitting on their desktop for
 * as long as the relay lives. The Task Scheduler would have been the closer match
 * to launchd and is refused outright for an account without administrator rights,
 * which `src/service/internal/startup-item.ts` records with the measurement. A
 * symbolic link is skipped there in any case, because one needs rights the user
 * may not have and would buy nothing.
 */
export async function nameTheLauncher(options: {
  /** Where the link goes. Its file name is the name the user will see. */
  readonly at: string;
  /** The real binary, usually `process.execPath`. */
  readonly to: string;
}): Promise<string> {
  await mkdir(dirname(options.at), { recursive: true, mode: 0o700 });
  if (ON_WINDOWS) return options.at;

  await rm(options.at, { force: true });

  // Through any links of its own, so a version manager moving its shims later
  // cannot leave this pointing at nothing.
  await symlink(await realpath(options.to), options.at);
  return options.at;
}
