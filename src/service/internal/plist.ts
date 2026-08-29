/** What the service needs to know to run the relay and come back if it dies. */
export type ServicePlan = {
  /** The launchd label, which is also how the service is addressed afterwards. */
  readonly label: string;
  /** Absolute path to the node binary. Never resolved from a shell's PATH. */
  readonly node: string;
  /** Absolute path to the script that starts the relay. */
  readonly script: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  /**
   * Where the job's standard error goes.
   *
   * Only its error, and that is the point. The relay writes its own log, bounded,
   * because a file the service holds open cannot be rotated. What is left for this
   * file is the thing the relay cannot say for itself: the reason it could not
   * start at all. So this file is empty in ordinary life, and anything in it is a
   * diagnosis.
   */
  readonly logFile: string;
  /**
   * Where the job's standard output goes. Defaults to the same file.
   *
   * The relay says everything twice, to the terminal for whoever ran it by hand
   * and to its own bounded log. Letting the service capture the first of those
   * would fill this file with ordinary chatter and make "anything in it is a
   * diagnosis" false, which is exactly what happened when it did.
   */
  readonly outFile?: string;
  /**
   * Variables the job is given, because it inherits none.
   *
   * A launchd job gets no login shell and no environment of ours. Anything the
   * relay needs in order to know which Window it serves has to be written into
   * the job description itself. ADR 0012.
   */
  readonly environment?: Readonly<Record<string, string>>;
};

function escaped(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The launchd job that keeps the relay up.
 *
 * `RunAtLoad` and `KeepAlive` together are the whole point: the store points Code
 * sessions at a fixed address, so something has to be listening there after a
 * reboot and after a crash, without anyone starting it by hand.
 *
 * Every path is absolute and no environment is inherited, because a service does
 * not get a login shell and a job that depends on one works until the day it does
 * not.
 */
export function plistFor(plan: ServicePlan): string {
  const arguments_ = [plan.node, plan.script, ...plan.args]
    .map((one) => `    <string>${escaped(one)}</string>`)
    .join("\n");

  const named = Object.entries(plan.environment ?? {});
  const environment =
    named.length === 0
      ? ""
      : `\n  <key>EnvironmentVariables</key>\n  <dict>\n` +
        named
          .map(([name, value]) => `    <key>${escaped(name)}</key><string>${escaped(value)}</string>`)
          .join("\n") +
        `\n  </dict>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escaped(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
${arguments_}
  </array>
  <key>WorkingDirectory</key><string>${escaped(plan.workingDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
${environment}
  <key>StandardOutPath</key><string>${escaped(plan.outFile ?? plan.logFile)}</string>
  <key>StandardErrorPath</key><string>${escaped(plan.logFile)}</string>
</dict>
</plist>
`;
}
