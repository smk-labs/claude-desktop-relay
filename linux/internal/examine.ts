/**
 * Whether a Code session started from this Window could actually reach a Seat.
 *
 * Five findings decide it, and every one is asked of the machine rather than of
 * our own intentions. Is anything listening where the Window has been told to find
 * us? Is the certificate there? Does any Seat hold a Send token? Does the Window's
 * own store carry the relay's address and that certificate? And was the Window
 * opened *after* that store was written, since the app reads it once at startup
 * and never again? `working` is all five or none, because a chain that is four
 * fifths there swaps nothing.
 *
 * It used to read the running app's environment out of `/proc` instead. That is
 * gone, and the reason is worth keeping: Chromium overwrites its own process
 * title, which on Linux is the same memory `/proc/<pid>/environ` reads, so the
 * main process answers with blanks and every variable looks absent. Read
 * naively, a perfectly relayed Window was reported broken with a confident list
 * of variables to go and fix. The store is both the mechanism and the honest
 * place to check it.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { connect } from "node:net";

import type { Finding } from "../../src/mechanism/internal/check.ts";
import { DESKTOP_FOLDER, serviceNameFor } from "./where.ts";
import { environmentStoreFileOn } from "./app-store-linux.ts";
import { everythingTheStoreCarries, whatTheWindowTrusts } from "./trust.ts";

export type { Finding };

export type LinuxExamination = {
  readonly findings: readonly Finding[];
  readonly working: boolean;
  /** The Window's process id, when one is running on this Desktop folder. */
  readonly windowPid: number | null;
};

/** Is anything listening where the Window has been told to find us? */
function listening(port: number, host = "127.0.0.1", withinMs = 2000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host });
    // Every wait gets a ceiling: a dial that neither connects nor fails would
    // otherwise hold a status screen open for as long as the kernel allows.
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(withinMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The Window running on this Desktop folder, by what it was started with. */
async function windowPidOn(folder: string): Promise<number | null> {
  const wanted = `--user-data-dir=${folder}`;
  const pids = (await readdir("/proc").catch(() => [] as string[])).filter((name) => /^\d+$/.test(name));

  for (const pid of pids) {
    const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (!command.includes(wanted)) continue;
    // The main process only: the renderers and the zygotes carry the same flag.
    if (command.includes("--type=")) continue;
    return Number(pid);
  }
  return null;
}

/**
 * When a process started, in seconds since 1970.
 *
 * From the boot time plus the process's own start offset, because that is the
 * only reading that survives a clock change and is exact to the tick. The tick
 * is 100 a second on every Linux this runs on.
 */
async function startedAt(pid: number): Promise<number | null> {
  const [stat_, uptime] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""),
    readFile("/proc/stat", "utf8").catch(() => ""),
  ]);
  // The command name can hold spaces and brackets, so fields are counted from
  // after the closing bracket rather than from the start of the line.
  const fields = stat_.slice(stat_.lastIndexOf(")") + 1).trim().split(/\s+/);
  const ticks = Number(fields[19]);
  const boot = Number(/^btime (\d+)$/m.exec(uptime)?.[1]);
  if (!Number.isFinite(ticks) || !Number.isFinite(boot)) return null;
  return boot + Math.trunc(ticks / 100);
}

/**
 * Does the store carry everything a Code session needs? Pure, so it is a table.
 *
 * Null means the store could not be opened, which is a different answer from
 * "the variables are not in it" and is never reported as that one: opening it
 * needs the desktop session's keyring, and over ssh there is none.
 */
export function judgeTheStore(options: {
  readonly file: string;
  readonly there: boolean;
  readonly held: Record<string, string> | null;
  readonly wanted: Readonly<Record<string, string>>;
}): Finding {
  const { file, there, held, wanted } = options;

  if (!there) {
    return {
      what: "the Window's store",
      ok: false,
      saying: `it does not carry the relay yet. Put it there:  relay-linux trust`,
    };
  }
  if (held === null) {
    return {
      what: "the Window's store",
      ok: true,
      saying: `${file} is in place, and could not be opened from here: that needs the desktop session's keyring`,
    };
  }

  const wrong = Object.entries(wanted).filter(([name, value]) => held[name] !== value).map(([name]) => name);
  return {
    what: "the Window's store",
    ok: wrong.length === 0,
    saying:
      wrong.length === 0
        ? `carries the relay's address and our certificate, so every Code session comes to us`
        : `is missing ${wrong.join(", ")}. Put them back:  relay-linux trust`,
  };
}

/**
 * Has the running Window actually read that store? Pure, for the same reason.
 *
 * The app reads it once when it starts. A Window that was already open when the
 * store was written is pointed nowhere, and nothing about the store on disk can
 * tell you that. The two timestamps can.
 */
export function judgeTheWindow(options: {
  readonly pid: number | null;
  readonly startedAt: number | null;
  readonly storeWrittenAt: number | null;
}): Finding {
  const { pid, startedAt: started, storeWrittenAt } = options;

  if (pid === null) {
    return {
      what: "the Window",
      ok: false,
      saying: `no Claude Desktop is running on this Desktop folder. Start it any way you like, ` +
        `or with  relay-linux launch`,
    };
  }
  if (started === null || storeWrittenAt === null) {
    return { what: "the Window", ok: true, saying: `running as ${pid}` };
  }
  if (started < storeWrittenAt) {
    return {
      what: "the Window",
      ok: false,
      saying:
        `running as ${pid}, but it started before the store was written, and the app reads that store only ` +
        `when it starts. Close Claude Desktop and open it again.`,
    };
  }
  return { what: "the Window", ok: true, saying: `running as ${pid}, started after the store was written` };
}

export async function examineLinux(options: {
  readonly port: number;
  readonly caCertificate: string;
  readonly seatsWithTokens: number;
  readonly desktopFolder?: string;
}): Promise<LinuxExamination> {
  const folder = options.desktopFolder ?? DESKTOP_FOLDER;
  const findings: Finding[] = [];

  const up = await listening(options.port);
  findings.push({
    what: "the relay",
    ok: up,
    saying: up
      ? `listening on 127.0.0.1:${options.port}`
      : `nothing is listening on 127.0.0.1:${options.port}. Start it:  systemctl --user start ${serviceNameFor(options.port)}`,
  });

  const ca = await stat(options.caCertificate).then(() => true).catch(() => false);
  findings.push({
    what: "the certificate",
    ok: ca,
    saying: ca ? options.caCertificate : `${options.caCertificate} is not there. It is minted when the relay starts.`,
  });

  findings.push({
    what: "the Seats",
    ok: options.seatsWithTokens > 0,
    saying:
      options.seatsWithTokens > 0
        ? `${options.seatsWithTokens} hold a Send token`
        : `none holds a Send token, so nothing can be charged to anything`,
  });

  const file = environmentStoreFileOn(folder);
  const written = await stat(file)
    .then((held) => Math.trunc(held.mtimeMs / 1000))
    .catch(() => null);

  findings.push(
    judgeTheStore({
      file,
      there: written !== null,
      held: written === null ? null : await whatTheWindowTrusts({ desktopFolder: folder }),
      wanted: everythingTheStoreCarries({ port: options.port, caCertificate: options.caCertificate }),
    }),
  );

  const pid = await windowPidOn(folder);
  findings.push(
    judgeTheWindow({
      pid,
      startedAt: pid === null ? null : await startedAt(pid),
      storeWrittenAt: written,
    }),
  );

  return { findings, working: findings.every((finding) => finding.ok), windowPid: pid };
}
