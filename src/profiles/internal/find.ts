/**
 * Every Claude Desktop profile on this machine, and which of them is relayed.
 *
 * A profile is one Desktop folder: its own login, its own store, its own Payer
 * (ADR 0012). There are several now and only some are relayed, so "which profile
 * am I looking at" stopped being obvious the day the second one appeared. This is
 * the module that answers it from evidence rather than from a list somebody has
 * to keep up to date: the folders are discovered, and whether one is relayed is
 * read out of that profile's own store.
 *
 * Nothing here closes or changes a profile. It reads, and `open.ts` starts one.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { openAppStore } from "../../app-store/index.ts";
import { ON_WINDOWS, isTheUsersOwnDesktopFolder, sameFolder, THE_USERS_DESKTOP_FOLDER } from "../../home/index.ts";
import { appLinesIn, CLAUDE_DESKTOP, holdingItsOwnLock, readProcessList, runningOn } from "../../window/index.ts";
import { A_NAME_KEEPS_FOR, readAccount, signedInAs, type Account } from "./identity.ts";

/**
 * Whether a profile's Code sessions go through a relay, and whose.
 *
 * "unreadable" is its own answer on purpose: a store that cannot be opened is not
 * a store with nothing in it, and saying "not relayed" there would be a guess
 * dressed as a fact.
 */
export type Relayed = "this relay" | "another relay" | "no" | "unreadable";

export type Profile = {
  /** What the menu and the page call it. Short, and unique among the others. */
  readonly name: string;
  /** The Desktop folder, which is the whole identity of a profile. */
  readonly folder: string;
  /** Home-relative, because `~/...` is how a person says where a folder is. */
  readonly where: string;
  /** The one the user works in, which nothing here ever closes. */
  readonly theUsersOwn: boolean;
  readonly running: boolean;
  readonly relayed: Relayed;
  /** Whether anybody has ever signed in here, so an empty leftover is visible. */
  readonly signedIn: boolean;
  /**
   * Who it is signed in as, once the server has said so.
   *
   * Null while it is not known: nobody signed in, or the answer has not come back
   * yet. Never the last profile's name, and never a guess from an Organization,
   * because several accounts here share one Organization and the guess would be
   * wrong more often than right.
   */
  readonly account: Account | null;
};

/** The two files every Claude Desktop folder has, and a folder without them is not one. */
export function looksLikeAProfile(folder: string): boolean {
  return existsSync(join(folder, "config.json")) && existsSync(join(folder, "Local Storage"));
}

export function shorten(path: string, home: string = homedir()): string {
  // Case-insensitively on Windows, where the same folder is spelled two ways
  // by two programs on one machine and a person still reads one folder.
  const alike = ON_WINDOWS ? path.toLowerCase().startsWith(home.toLowerCase()) : path.startsWith(home);
  return home !== "" && alike ? `~${path.slice(home.length)}` : path;
}

/**
 * A short name for a Desktop folder.
 *
 * Derived from the folder, so a profile discovered tomorrow is named without
 * anybody editing anything. `.../Claude` is the one the user works in and is
 * called Main; everything else drops the parts every profile shares and keeps
 * what tells them apart.
 */
export function nameFor(folder: string): string {
  if (isTheUsersOwnDesktopFolder(folder)) return "Main";

  const parts = folder.replace(/[/\\]+$/, "").split(/[/\\]/);
  const last = parts[parts.length - 1] ?? folder;
  // `~/.claude-relayed/desktop` is named by its home, not by the word "desktop".
  const slug = last.toLowerCase() === "desktop" ? (parts[parts.length - 2] ?? last) : last;
  const bare = slug.replace(/^\.?claude[-_ ]?/i, "").replace(/^desktop[-_]/i, "");
  const words = (bare === "" ? slug : bare).split(/[-_ ]+/).filter((one) => one !== "");
  return words.map((one) => one.charAt(0).toUpperCase() + one.slice(1)).join(" ");
}

/** Names have to be unique: they are what a click sends back. */
export function namesApart(folders: readonly string[]): readonly { folder: string; name: string }[] {
  const taken = new Set<string>();
  return folders.map((folder) => {
    const wanted = nameFor(folder);
    let name = wanted;
    for (let n = 2; taken.has(name); n += 1) name = `${wanted} ${n}`;
    taken.add(name);
    return { folder, name };
  });
}

/** What a store's variables say about who is relaying that profile. */
export function relayedBy(variables: Readonly<Record<string, string>>, port: number): Relayed {
  const proxies = Object.entries(variables)
    .filter(([name]) => name.toLowerCase().endsWith("_proxy") && !name.toLowerCase().startsWith("no_"))
    .map(([, value]) => value);
  if (proxies.length === 0) return "no";
  return proxies.some((one) => one.includes(`:${port}`)) ? "this relay" : "another relay";
}

/**
 * Where a profile can be. Every one of these is a folder we only read.
 *
 * The first entry on each machine is where Claude Desktop puts its own, and the
 * rest are where a person who runs several has been putting them. Discovered
 * rather than configured: a profile made tomorrow in one of these appears without
 * anybody editing anything.
 */
export function whereProfilesLive(home: string = homedir()): readonly string[] {
  if (ON_WINDOWS) {
    const roaming = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
    const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    return [roaming, join(roaming, "Claude Profiles"), join(home, "ClaudeProfiles"), local, home];
  }

  const support = join(home, "Library", "Application Support");
  return [support, join(support, "Claude Profiles"), home];
}

/**
 * Every folder worth asking about, from the places profiles are kept.
 *
 * A folder counts when it is named after Claude Desktop and holds one, or when it
 * is one of ours with a `desktop` inside it. Anything else in those directories is
 * somebody else's business.
 */
async function foldersOnThisMachine(home: string): Promise<string[]> {
  const found = new Set<string>([THE_USERS_DESKTOP_FOLDER]);

  for (const place of whereProfilesLive(home)) {
    const entries = await readdir(place, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const here = join(place, entry.name);
      if (/^\.?claude/i.test(entry.name) && looksLikeAProfile(here)) found.add(here);
      const inside = join(here, "desktop");
      if (/^\.?claude/i.test(entry.name) && looksLikeAProfile(inside)) found.add(inside);
      // A folder kept for profiles is a profile directory by where it sits, so
      // what is in it is not required to be named after the app.
      if (/claude ?profiles$/i.test(place) && looksLikeAProfile(here)) found.add(here);
    }
  }

  // One folder under two spellings is one profile, and on Windows the two
  // spellings arrive from two different places that both name it.
  const apart: string[] = [];
  for (const one of found) {
    if (!apart.some((already) => sameFolder(already, one))) apart.push(one);
  }

  return apart.sort((a, b) =>
    isTheUsersOwnDesktopFolder(a) ? -1 : isTheUsersOwnDesktopFolder(b) ? 1 : a.localeCompare(b),
  );
}

/**
 * Is this profile open right now?
 *
 * The Window the user works in is started with no `--user-data-dir` at all, so
 * looking for its folder on a command line finds nothing and reports the profile
 * that is plainly in front of them as closed. That wrong answer is worse than no
 * answer, which is the same reason `isWindowRunning` reads the whole process list.
 * Every other profile is named by its folder, and only by its folder.
 */
export function openNow(processList: string, folder: string, bundle: string = CLAUDE_DESKTOP): boolean {
  /**
   * On Windows the folder answers for itself, and better than any list can.
   *
   * Every Claude Desktop profile holds `lockfile` in its own folder open for as
   * long as it runs, so the question ADR 0012 asks about one folder is answered
   * by that one folder. It also removes the special case below outright: the
   * Window the user works in holds its lock like every other one, whether or not
   * it was started with the flag that names it.
   */
  if (ON_WINDOWS) return holdingItsOwnLock(folder);

  if (runningOn(processList, folder)) return true;
  if (!isTheUsersOwnDesktopFolder(folder)) return false;
  // Its own processes and nobody else's: a line naming some other folder is
  // another profile, and counting it would say Main is open whenever anything is.
  return appLinesIn(processList, bundle).some((line) => !line.command.includes("--user-data-dir="));
}

/**
 * The profiles, read now.
 *
 * Reading whether one is relayed needs the Keychain, which is why the caller is
 * expected to hold the answer for a while rather than ask on every page refresh:
 * see `openProfiles`.
 */
export async function findProfiles(options: {
  port: number;
  home?: string;
  /** Names already read, by folder, so a fresh listing does not ask again. */
  accounts?: ReadonlyMap<string, Account | null>;
}): Promise<readonly Profile[]> {
  const home = options.home ?? homedir();
  const folders = await foldersOnThisMachine(home);
  // Not read at all where nothing asks for it: on Windows every folder answers
  // for itself, and reading this would be half a second of PowerShell for nobody.
  const processList = ON_WINDOWS ? "" : await readProcessList();

  return Promise.all(
    namesApart(folders).map(async ({ folder, name }) => {
      const relayed = await openAppStore(folder)
        .read()
        .then((held) => relayedBy(held, options.port), () => "unreadable" as const);

      return {
        name,
        folder,
        where: shorten(folder, home),
        theUsersOwn: isTheUsersOwnDesktopFolder(folder),
        running: openNow(processList, folder),
        relayed,
        signedIn: (await signedInAs(folder)) !== null,
        account: options.accounts?.get(folder) ?? null,
      };
    }),
  );
}

/**
 * The profiles, with the slow half held for a while.
 *
 * Whether a profile is relayed comes out of its own store and needs the Keychain,
 * and it changes when somebody runs install, which is to say almost never. Whether
 * it is running changes every minute, so that half is read fresh every time: a
 * page that says a Window is open after it was closed is worse than no page.
 */
export function openProfiles(options: { port: number; everyMs?: number }): { list(at: number): Promise<readonly Profile[]> } {
  const everyMs = (options.everyMs ?? 30_000) / 1000;
  let held: { at: number; profiles: readonly Profile[] } | null = null;
  /** The names, by folder, with when each was read. Kept far longer than the rest. */
  const names = new Map<string, { at: number; account: Account | null }>();
  const asking = new Set<string>();
  const accounts = () => new Map([...names].map(([folder, one]) => [folder, one.account]));

  /**
   * The names are asked for behind the page, never in front of it.
   *
   * Reading a name is a call to the server with that profile's own token, and a
   * page that waited on one would stall for as long as the network felt like it.
   * So the list answers with what is known and the answer arrives on a later
   * refresh, which for a name that changes when somebody signs out is soon enough.
   */
  const askFor = (profiles: readonly Profile[], at: number) => {
    for (const one of profiles) {
      if (!one.signedIn) continue;
      const known = names.get(one.folder);
      if (known !== undefined && at - known.at < A_NAME_KEEPS_FOR / 1000) continue;
      if (asking.has(one.folder)) continue;
      asking.add(one.folder);
      void readAccount(one.folder)
        .catch(() => null)
        .then((account) => {
          names.set(one.folder, { at, account });
          asking.delete(one.folder);
        });
    }
  };

  return {
    async list(at: number) {
      if (held === null || at - held.at >= everyMs) {
        const profiles = await findProfiles({ port: options.port, accounts: accounts() }).catch(() => held?.profiles ?? []);
        held = { at, profiles };
        askFor(profiles, at);
        return profiles;
      }

      // Not read at all where nothing asks for it: on Windows every folder answers
      // for itself and reading this would be half a second of PowerShell for nobody.
      const processList = ON_WINDOWS ? "" : await readProcessList();
      const known = accounts();
      return held.profiles.map((one) => ({
        ...one,
        running: openNow(processList, one.folder),
        account: known.get(one.folder) ?? one.account,
      }));
    },
  };
}
