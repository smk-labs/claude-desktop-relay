/**
 * The three releases, built from the one body of code.
 *
 *   npm run package                    all three
 *   npm run package -- macos           one of them
 *
 * There is one `src/` and there are three products. What separates them is not
 * the code, which is shared on purpose (ADR 0015), but what a person downloads:
 * a Windows user gets an archive with a Windows README at the top of it and no
 * `linux/` inside it, and never has to work out which half of a document is
 * about their machine.
 *
 * Everything is named rather than excluded, and that is the whole design of this
 * file. A packaging step built the other way round (take the repository, drop
 * `test/` and `.git`) ships every file nobody thought about, which is how a
 * scratch file with a real account in it reaches a public release. Adding a file
 * to a product is a line here or it does not ship.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What every product carries, whatever machine it is for. */
const SHARED = [
  "LICENSE",
  "package.json",
  "tsconfig.json",
  "CONTEXT.md",
  "src",
  "docs/adr",
  "docs/mechanism.md",
  "docs/known-gaps.md",
  "docs/spec.md",
  "docs/testing-on-a-second-profile.md",
  "docs/unship-holding-the-payer-for-a-conversation.md",
  "docs/later-ideas.md",
  "docs/design.md",
  "docs/coverage-matrix.md",
] as const;

type Product = {
  readonly name: string;
  /** The document that becomes `README.md` at the top of the archive. */
  readonly readme: string;
  /** What this machine needs and the other two do not. */
  readonly extra: readonly string[];
  /** zip for the machine whose users expect one, tar.gz for the two that do not. */
  readonly archive: "zip" | "tar.gz";
};

const PRODUCTS: readonly Product[] = [
  { name: "macos", readme: "docs/macos.md", extra: ["scripts"], archive: "tar.gz" },
  { name: "windows", readme: "docs/windows.md", extra: ["scripts"], archive: "zip" },
  { name: "linux", readme: "docs/linux.md", extra: ["linux"], archive: "tar.gz" },
];

/**
 * What must never be inside a release, checked after it is built rather than
 * trusted before it.
 *
 * The list above is an allowlist, so this should never fire. It is here because
 * "should never" is not a property anybody can see, and a release is the one step
 * in this program that cannot be taken back once somebody has downloaded it.
 */
const NEVER_SHIPPED = ["test", "issues", "mockup", "node_modules", ".git", "dist", "seats.json"];

async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("close", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}

async function there(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const HOME_PAGE = "https://github.com/smk-labs/claude-desktop-relay";

/**
 * A guide written for `docs/` becomes the README at the top of an archive, and
 * every relative link in it moves by one folder when it does.
 *
 * Rewritten here rather than written twice, because two copies of a guide is the
 * arrangement where one of them is corrected and the other is not. The check
 * below is what makes the rewrite safe to do at all: it opens every link in the
 * staged tree and fails the build on one that leads nowhere, so an archive whose
 * README points at a file it does not carry cannot be published.
 */
function asTheTopOfTheArchive(guide: string): string {
  return guide.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^(https?:|mailto:|#)/.test(target)) return whole;
    if (target === "../README.md") return `](${HOME_PAGE})`;
    if (target.startsWith("../")) return `](${target.slice(3)})`;
    return `](docs/${target})`;
  });
}

/** Every relative link in every document of a staged archive leads somewhere. */
async function everyLinkResolves(root: string): Promise<void> {
  const broken: string[] = [];

  const walk = async (folder: string): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(path)));
      else if (entry.name.endsWith(".md")) found.push(path);
    }
    return found;
  };

  for (const document of await walk(root)) {
    const text = await readFile(document, "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const named = (target ?? "").split("#")[0] ?? "";
      if (named === "" || /^(https?:|mailto:)/.test(named)) continue;
      if (!(await there(join(dirname(document), named)))) {
        broken.push(`${document.slice(root.length + 1)} points at ${named}, which is not in the archive`);
      }
    }
  }

  if (broken.length > 0) throw new Error(broken.join("\n"));
}

async function build(product: Product, version: string, into: string): Promise<string> {
  const folder = `claude-desktop-relay-${product.name}-${version}`;
  const staging = await mkdtemp(join(tmpdir(), "relay-package-"));
  const root = join(staging, folder);

  try {
    for (const path of [...SHARED, ...product.extra]) {
      const from = join(repo, path);
      if (!(await there(from))) throw new Error(`${path} is named by the ${product.name} product and is not there`);
      await mkdir(dirname(join(root, path)), { recursive: true });
      await cp(from, join(root, path), { recursive: true });
    }

    const readme = join(repo, product.readme);
    if (!(await there(readme))) throw new Error(`${product.readme} is the ${product.name} README and is not there`);
    await writeFile(join(root, "README.md"), asTheTopOfTheArchive(await readFile(readme, "utf8")), "utf8");

    await everyLinkResolves(root);

    for (const forbidden of NEVER_SHIPPED) {
      if (await there(join(root, forbidden))) throw new Error(`${forbidden} reached the ${product.name} archive`);
    }

    const archive = join(into, `${folder}.${product.archive}`);
    await rm(archive, { force: true });
    if (product.archive === "zip") {
      await run("/usr/bin/zip", ["-q", "-r", "-X", archive, folder], staging);
    } else {
      await run("/usr/bin/tar", ["-czf", archive, folder], staging);
    }
    return archive;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const asked = process.argv.slice(2);
const wanted = asked.length === 0 ? PRODUCTS : PRODUCTS.filter((one) => asked.includes(one.name));

if (wanted.length === 0) {
  process.stderr.write(`no such product: ${asked.join(", ")}. There are three: ${PRODUCTS.map((one) => one.name).join(", ")}\n`);
  process.exitCode = 1;
} else {
  const { version } = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as { version: string };
  const into = join(repo, "dist");
  await mkdir(into, { recursive: true });

  for (const product of wanted) {
    const archive = await build(product, version, into);
    const { size } = await stat(archive);
    process.stdout.write(`${product.name.padEnd(8)} ${Math.round(size / 1024)}K  ${archive}\n`);
  }
}

export {};
