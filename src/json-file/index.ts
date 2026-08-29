/**
 * Read and write one small JSON file, without ever leaving half of one behind.
 *
 * Writing goes to a neighbouring name and is moved into place, so a crash or two
 * writers cannot produce a file that parses to nonsense. Three modules kept their
 * own copy of this before it was one.
 */
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Counts every write this process makes, so two writes in the same millisecond
 * cannot pick the same neighbouring name. A clock is not unique enough: four
 * exchanges arriving together is ordinary, and the loser of that race used to
 * fail its rename and take the relay down with it.
 */
let writes = 0;

/**
 * The file's contents, or null when there is no file.
 *
 * Null means "there is nothing here", and nothing else. A file that exists but
 * cannot be read, or holds something that is not JSON, throws. Returning null for
 * those too is how a transient error turns into a silent change of behaviour:
 * this used to make a Payer read as Off, so requests quietly went to the Window
 * account and nothing anywhere said why.
 */
export async function readJsonFile<T>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${file} is not readable as JSON. Move it aside to start again.`);
  }
}

/** Owner-readable only, because some of these files sit next to secrets. */
export async function writeJsonFile(file: string, contents: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const beside = join(dirname(file), `.${process.pid}.${(writes += 1)}.writing`);
  await writeFile(beside, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  await moveIntoPlace(beside, file);
}

/**
 * Move the finished file onto the real name, working around two Windows facts.
 *
 * The first is a reader holding the destination open, which Windows refuses with
 * `EPERM` where macOS simply succeeds. Three processes read these files at once
 * here, so it is ordinary rather than rare, and losing a verdict to it took the
 * relay down once. It is transient by nature, so it is waited out.
 *
 * The second is stranger and was measured on this machine on 2026-08-25: under
 * `%APPDATA%` and `%LOCALAPPDATA%`, renaming a file onto a name that does not
 * exist yet, in the same directory, fails `EXDEV` every time, while `copyFile`
 * and `writeFile` in that same directory both succeed. A filter driver is the
 * likeliest reason and it does not matter which: the app's own environment store
 * lives under `%APPDATA%` and is not ours to move somewhere friendlier.
 *
 * So the copy is the last thing tried, after the rename has had its chances. It
 * is not atomic and does not pretend to be; it is what stands between this and an
 * install that cannot write the store at all.
 */
async function moveIntoPlace(beside: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(beside, file);
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;

      if (code === "EXDEV") {
        await copyFile(beside, file);
        await rm(beside, { force: true });
        return;
      }

      const heldOpen = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!heldOpen || attempt >= 20) throw error;
      await new Promise((wake) => setTimeout(wake, 10));
    }
  }
}
