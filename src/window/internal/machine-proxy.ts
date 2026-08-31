import { spawn } from "node:child_process";

import type { Egress } from "../../relay/index.ts";
import type { Address } from "./proxy-variables.ts";
import { ON_WINDOWS } from "../../home/index.ts";
import { windowsEgress } from "./windows-proxy.ts";

/**
 * Read the machine's own proxy setting from `scutil --proxy`, the same place the
 * app reads it, rather than from the environment.
 *
 * The environment is the wrong source once we have started: the Window's Code
 * sessions have our own address in theirs, and a relay that read that would chain
 * to itself. The system setting is the honest answer to "what would this machine
 * have done".
 */
export function readMachineProxy(text: string): Address | null {
  const value = (name: string): string | null => {
    const found = new RegExp("^\\s*" + name + "\\s*:\\s*(\\S+)\\s*$", "m").exec(text);
    return found?.[1] ?? null;
  };

  // Only the HTTPS setting matters: every request the relay chains is a CONNECT
  // to port 443, which is what the HTTPS setting governs.
  if (value("HTTPSEnable") !== "1") return null;

  const host = value("HTTPSProxy");
  const port = Number(value("HTTPSPort"));
  if (host === null || !Number.isInteger(port) || port <= 0) return null;

  return { host, port };
}

/**
 * Ask the machine what proxy it uses. Null when it uses none.
 *
 * Refusing to chain to ourselves is the relay's own rule, not this one's: only the
 * relay knows what address it ended up listening on.
 */
export function machineProxy(): Promise<Address | null> {
  if (ON_WINDOWS) {
    return windowsEgress().then((how) => (how.kind === "proxy" ? how.at : null));
  }
  return new Promise<Address | null>((resolve) => {
    const child = spawn("scutil", ["--proxy"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(readMachineProxy(out)));
  });
}

/**
 * What the machine says about how traffic leaves (ADR 0011).
 *
 * The SOCKS case is the point of this function. A machine can name a SOCKS proxy
 * and no HTTPS proxy, which is one setting away from the setup this was built on:
 * `scutil` on this machine names both, on the same port. Reading only the HTTPS one
 * and returning "none" for that case would have the relay go straight out past a
 * VPN that is running perfectly well, silently, which is the exact leak ADR 0011
 * exists to stop.
 *
 * It used to be refused, which was safe and not good enough. It is now carried:
 * see `src/socks`. `refuse` is still an answer this can give, and stays one,
 * because the next route nobody has implemented must land there rather than on
 * `direct`.
 *
 * The HTTPS proxy wins when both are named, which is what happens on this machine.
 * Not a preference: it is the one of the two the relay has been carrying traffic
 * through since phase one, so keeping it is the reading that changes nothing for
 * the setup that is already proved.
 */
export function machineEgressFrom(text: string): Egress {
  const proxy = readMachineProxy(text);
  if (proxy !== null) return { kind: "proxy", at: proxy };

  const socks = readSocksProxy(text);
  /**
   * No credentials, and that is a limit rather than an omission.
   *
   * macOS keeps a SOCKS username in the setting and its password in the Keychain,
   * under an item belonging to the system rather than to us. Reading it would mean
   * asking for access to a Keychain item this program has no business in. So a
   * proxy that asks for a password fails with a sentence saying so, which is the
   * criterion: never silently ignored.
   */
  if (socks !== null) return { kind: "socks", at: socks, credentials: null };

  return { kind: "direct" };
}

/**
 * The SOCKS setting, read so that it can be used, and told apart from none.
 *
 * "The machine names no way out" and "the machine names a SOCKS proxy" look
 * identical from the HTTPS setting alone, and only one of them is safe to go
 * direct on.
 */
export function readSocksProxy(text: string): Address | null {
  const value = (name: string): string | null => {
    const found = new RegExp("^\\s*" + name + "\\s*:\\s*(\\S+)\\s*$", "m").exec(text);
    return found?.[1] ?? null;
  };

  if (value("SOCKSEnable") !== "1") return null;

  const host = value("SOCKSProxy");
  const port = Number(value("SOCKSPort"));
  if (host === null || !Number.isInteger(port) || port <= 0) return null;

  return { host, port };
}

/**
 * How long the machine has to say what proxy it uses.
 *
 * A healthy `scutil --proxy` answers in about ten milliseconds, measured on
 * 2026-08-30, so two seconds is two hundred times the honest cost and this only
 * fires when something is genuinely wrong.
 *
 * It exists because this command is asked for from inside a relay turn, and a
 * turn is one of twelve. `scutil` reads the SystemConfiguration store, which a
 * VPN rewrites every time it changes a route, and a read of a store mid-rewrite
 * can block. Without a clock that block is permanent: the promise below settles
 * only on `close` or `error`, so twelve of them take every turn the relay has and
 * nothing is ever written to say why. That is the wedge of 2026-08-30, which took
 * a restart to clear and left an empty log behind it.
 */
export const THE_MACHINE_HAS_THIS_LONG = 2_000;

/** Ask the machine how traffic leaves. The reading `serve` actually uses. */
export function machineEgress(): Promise<Egress> {
  if (ON_WINDOWS) return windowsEgress();
  return new Promise<Egress>((resolve) => {
    const child = spawn("scutil", ["--proxy"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;

    /**
     * Answered once, whichever of the three ways gets here first.
     *
     * The clock and the process can both fire, and a second answer to a promise
     * is silent rather than wrong, so this is guarded here to say plainly that
     * only the first one counts.
     */
    const answer = (egress: Egress) => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      resolve(egress);
    };

    /**
     * SIGKILL rather than SIGTERM, because the case being killed is a process
     * stuck in a system call, and that is the one a polite signal does not reach.
     */
    const clock = setTimeout(() => {
      child.kill("SIGKILL");
      answer({
        kind: "refuse",
        why: `this machine did not say what proxy it uses within ${THE_MACHINE_HAS_THIS_LONG}ms`,
      });
    }, THE_MACHINE_HAS_THIS_LONG);

    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    // A machine that will not answer is not a machine with no proxy. Refusing is
    // the safe reading: going direct on the strength of a failed command is how a
    // bypass gets in without anybody choosing it.
    child.on("error", () => answer({ kind: "refuse", why: "this machine would not say what proxy it uses" }));
    child.on("close", (code) =>
      answer(
        code === 0
          ? machineEgressFrom(out)
          : { kind: "refuse", why: `this machine would not say what proxy it uses (scutil exited ${String(code)})` },
      ),
    );
  });
}
