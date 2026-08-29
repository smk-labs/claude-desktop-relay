import { spawn } from "node:child_process";

import type { Egress } from "../../relay/index.ts";
import type { Address } from "./proxy-variables.ts";

/**
 * What this machine says about how traffic leaves, on Windows.
 *
 * The same rule as macOS and for the same reason (ADR 0011): the relay uses the
 * way out the machine names, or it refuses. It never goes round one. What differs
 * is only where the machine keeps the answer. macOS has `scutil --proxy`; Windows
 * keeps it in the registry, under the settings every HTTP client on the machine
 * reads, and that is what is read here.
 *
 * Not the environment, which is the wrong source once we have started: the
 * Window's Code sessions have our own address in theirs, and a relay that read
 * that would chain to itself.
 *
 * There is no VPN and no tunnel on the machine this was written for, so in
 * practice this reads "nothing named" and the relay goes straight out, which is
 * exactly what the machine itself would do. The reading is still done rather than
 * assumed, because a machine that grows a proxy tomorrow must not be quietly
 * bypassed on the strength of what was true today.
 */
const SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/** One value out of a `reg query` dump. Null when it is not there. */
function value(dump: string, name: string): string | null {
  const found = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "m").exec(dump);
  return found?.[1] ?? null;
}

function address(text: string): Address | null {
  const at = text.lastIndexOf(":");
  if (at === -1) return null;
  const host = text.slice(0, at).trim();
  const port = Number(text.slice(at + 1));
  if (host === "" || !Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  return { host, port };
}

/**
 * The proxy the machine names for HTTPS, from what the registry holds.
 *
 * `ProxyServer` has two forms. One address on its own means every scheme goes
 * there. A list of `scheme=host:port` separated by semicolons names them apart,
 * and only the HTTPS one matters: every request the relay chains is a CONNECT to
 * port 443.
 */
export function readWindowsProxy(dump: string): Address | null {
  if (value(dump, "ProxyEnable") !== "0x1") return null;

  const server = value(dump, "ProxyServer");
  if (server === null || server.trim() === "") return null;

  if (!server.includes("=")) return address(server);

  for (const part of server.split(";")) {
    const [scheme, where] = part.split("=");
    if (scheme?.trim().toLowerCase() === "https" && where !== undefined) return address(where);
  }
  return null;
}

/**
 * A SOCKS proxy the machine names, told apart from naming nothing.
 *
 * "The machine names no way out" and "the machine names a SOCKS proxy" look the
 * same from the HTTPS setting alone, and only one of them is safe to go direct on.
 * So this exists to make that case refuse rather than leak.
 *
 * The relay does speak SOCKS: `src/socks` dials one and `src/relay/internal/dial.ts`
 * chains through it whenever the egress says so, which is what macOS gets. It is
 * this reading that is not wired to it. Nothing has been carried over a SOCKS
 * proxy named in the Windows registry, and the safe half of that pair is the
 * refusal, so the refusal is where Windows stands until somebody proves the other
 * half against a real one. It costs a Windows user behind a SOCKS-only tunnel a
 * working relay. Going direct instead would cost them the tunnel.
 */
export function readWindowsSocks(dump: string): Address | null {
  if (value(dump, "ProxyEnable") !== "0x1") return null;

  const server = value(dump, "ProxyServer");
  if (server === null || !server.includes("=")) return null;

  for (const part of server.split(";")) {
    const [scheme, where] = part.split("=");
    if (scheme?.trim().toLowerCase() === "socks" && where !== undefined) return address(where);
  }
  return null;
}

/** The reading, turned into the one answer the relay acts on. */
export function windowsEgressFrom(dump: string): Egress {
  const proxy = readWindowsProxy(dump);
  if (proxy !== null) return { kind: "proxy", at: proxy };

  const socks = readWindowsSocks(dump);
  if (socks !== null) {
    return {
      kind: "refuse",
      why:
        `this machine names a SOCKS proxy at ${socks.host}:${socks.port} and no HTTPS one. ` +
        `The relay can dial a SOCKS proxy, but that path has never been proved on this machine, ` +
        `and going round the proxy instead would put this machine's traffic to Anthropic ` +
        `out over the ordinary connection.`,
    };
  }

  return { kind: "direct" };
}

function ask(): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("reg.exe", ["query", SETTINGS], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => resolve({ code: -1, out: "" }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

/** Ask this machine how traffic leaves. The reading `serve` actually uses. */
export async function windowsEgress(): Promise<Egress> {
  const asked = await ask();
  // A machine that will not answer is not a machine with no proxy. Refusing is
  // the safe reading: going direct on the strength of a failed command is how a
  // bypass gets in without anybody choosing it.
  if (asked.code !== 0) {
    return { kind: "refuse", why: `this machine would not say what proxy it uses (reg query exited ${asked.code})` };
  }
  return windowsEgressFrom(asked.out);
}
