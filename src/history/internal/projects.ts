import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which project a session's work was for, without reading a word of it.
 *
 * Claude Code writes each session's transcript into a directory named after the
 * working directory it ran in, one file per session id. So the directory holding a
 * session names the project, and the session id is already on the request, in the
 * CLI's own metadata. Nothing here opens a transcript: only the names of things.
 *
 * Confirmed on a real machine on 2026-08-22: over a hundred such directories,
 * named after their paths. That order of magnitude is the whole reason the listing
 * below is done once and kept.
 */

/** Where Claude Code keeps its transcripts, one directory per working directory. */
export const WHERE_THE_TRANSCRIPTS_ARE = join(homedir(), ".claude", "projects");

/**
 * The encoding Claude Code uses for a directory name.
 *
 * A working directory becomes its path with every separator turned into a dash, so
 * `/Users/me/Projects/thing` becomes `-Users-me-Projects-thing`. Decoded back the
 * other way rather than guessed at, and a name that does not decode is reported as
 * it is rather than being turned into a plausible path that never existed.
 */
export function pathFromDirectory(name: string): string {
  return name.startsWith("-") ? name.replace(/-/g, "/") : name;
}

/**
 * The shortest name for a project that a person would recognise.
 *
 * The whole path is what a row is keyed by, because two repositories can share a
 * last segment. This is only for showing.
 */
export function shortNameFor(path: string): string {
  const segments = path.split("/").filter((one) => one !== "");
  return segments.slice(-2).join("/") || path;
}

export type Projects = {
  /**
   * The project a session ran in, or null when nothing here can say.
   *
   * Null, never a guess. A transcript that has not been written yet reads as null
   * so the row is filled in on a later pass, and a session that genuinely belongs
   * to no project stays null for ever, which is the honest answer.
   */
  of(session: string): Promise<string | null>;
};

/**
 * Look sessions up in the transcript directories.
 *
 * Every transcript directory is listed once, on the first question asked of it,
 * and the whole session-to-project map is kept for the life of the object. Eager
 * rather than one directory at a time, because a month of rows asks about nearly
 * all of them anyway and a second pass over the same rows must not read the disk
 * again. That is what makes this cheap enough to run over a whole month: the
 * directories are read once, not once per row.
 *
 * It is deliberately not on the request path. Naming a project means reading
 * directories, and nothing is allowed to delay a request; the session id is kept on
 * the row and the name is filled in afterwards.
 */
export function openProjects(options: { folder?: string } = {}): Projects {
  const folder = options.folder ?? WHERE_THE_TRANSCRIPTS_ARE;

  /** Session id to project path, built as directories are read. */
  const known = new Map<string, string>();
  let read: Promise<void> | null = null;

  const readEverything = async (): Promise<void> => {
    const directories = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      const project = pathFromDirectory(entry.name);
      const files = await readdir(join(folder, entry.name)).catch(() => []);
      for (const file of files) {
        // One file per session, named by the session id. The extension is whatever
        // the CLI writes; only the stem is the id.
        const session = file.replace(/\.[^.]+$/, "");
        if (session !== "") known.set(session, project);
      }
    }
  };

  return {
    async of(session) {
      // Read once. A second pass over the same rows must not walk every transcript
      // directory again, and a session that appeared since is picked up by the next command
      // rather than by re-reading the disk mid-pass.
      read ??= readEverything();
      await read;
      return known.get(session) ?? null;
    },
  };
}
