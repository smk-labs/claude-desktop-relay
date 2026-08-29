import { access, stat } from "node:fs/promises";
import { connect } from "node:net";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";

/** One thing that has to be true for a Code session to reach the relay. */
export type Finding = {
  readonly what: string;
  readonly ok: boolean;
  /** What is wrong and what changed, in a sentence a user can act on. */
  readonly saying: string;
};

export type Inspection = {
  /** True only when every finding is ok. */
  readonly working: boolean;
  readonly findings: readonly Finding[];
};

/** What the check needs to know. Everything is passed in, so tests own it all. */
export type WhatToCheck = {
  /** Where the app keeps its environment store. */
  readonly storeFile: string;
  /** The variables the store must carry, and what they must say. */
  readonly wanted: Readonly<Record<string, string>>;
  /** What the store actually holds. */
  readonly reading: () => Promise<Record<string, string>>;
  /** The certificate the store points at. */
  readonly certificateFile: string;
  /** Where the relay should be listening. */
  readonly relay: { readonly host: string; readonly port: number };
  /** How long a certificate must still have, in days, before it is worth saying. */
  readonly warnWithinDays?: number;
  readonly now?: () => number;
};

async function isThere(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function listening(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, host);
    const answer = (yes: boolean) => {
      socket.destroy();
      resolve(yes);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => answer(true));
    socket.once("timeout", () => answer(false));
    socket.once("error", () => answer(false));
  });
}

/**
 * Whether the mechanism still works, and if not, which part of it changed.
 *
 * The point is the naming. When a Claude Desktop update closes the door, the
 * symptom is a Code session that cannot reach anything, and without this that
 * looks like a mystery. Each finding says the specific thing that is no longer
 * true.
 */
export async function inspect(what: WhatToCheck): Promise<Inspection> {
  const findings: Finding[] = [];
  const now = what.now ?? Date.now;

  const storeIsThere = await isThere(what.storeFile);
  findings.push({
    what: "the app's environment store",
    ok: storeIsThere,
    saying: storeIsThere
      ? `the store is where it has always been, at ${what.storeFile}`
      : `there is no store at ${what.storeFile}. An update has moved it, and until this is ` +
        `pointed at the new place nothing we write can reach a Code session.`,
  });

  let held: Record<string, string> = {};
  let couldRead = false;
  if (storeIsThere) {
    try {
      held = await what.reading();
      couldRead = true;
    } catch (error) {
      findings.push({
        what: "reading the store",
        ok: false,
        saying:
          `the store is there but will not open: ${error instanceof Error ? error.message : String(error)}. ` +
          `An update has changed how it is locked.`,
      });
    }
  }

  if (couldRead) {
    const missing = Object.entries(what.wanted).filter(([name, value]) => held[name] !== value);
    findings.push({
      what: "our variables in the store",
      ok: missing.length === 0,
      saying:
        missing.length === 0
          ? `all ${Object.keys(what.wanted).length} of our variables are in the store as written`
          : `the store no longer carries ${missing.map(([name]) => name).join(", ")}. ` +
            `An update is stripping them, which closes this off with no way around it.`,
    });
  }

  const certificateIsThere = await isThere(what.certificateFile);
  if (!certificateIsThere) {
    findings.push({
      what: "our certificate",
      ok: false,
      saying: `there is no certificate at ${what.certificateFile}, so no Code session can trust the relay.`,
    });
  } else {
    const certificate = new X509Certificate(await readFile(what.certificateFile));
    const endsAt = Date.parse(certificate.validTo);
    const daysLeft = Math.floor((endsAt - now()) / 86_400_000);
    const warnWithin = what.warnWithinDays ?? 30;

    findings.push({
      what: "our certificate",
      ok: daysLeft > warnWithin,
      saying:
        daysLeft > warnWithin
          ? `the certificate is good for another ${daysLeft} days`
          : daysLeft < 0
            ? `the certificate expired ${-daysLeft} days ago, so every Code session will refuse the relay. ` +
              `Delete the certificate folder and start again.`
            : `the certificate has ${daysLeft} days left. Delete the certificate folder to mint a new one ` +
              `before it runs out, because when it does nothing will reach the network.`,
    });
  }

  const relayAnswers = await listening(what.relay.host, what.relay.port);
  findings.push({
    what: "the relay",
    ok: relayAnswers,
    saying: relayAnswers
      ? `the relay is listening on ${what.relay.host}:${what.relay.port}`
      : `nothing is listening on ${what.relay.host}:${what.relay.port}, which is where every Code session ` +
        `has been told to go. Until something is, they cannot reach the network at all.`,
  });

  await stat(what.storeFile).catch(() => undefined);

  return { working: findings.every((finding) => finding.ok), findings };
}
