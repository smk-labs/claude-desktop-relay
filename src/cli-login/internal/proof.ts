import type { CliLoginReading } from "./read.ts";

/**
 * What a pair of readings proves about the CLI login, over whatever happened
 * between them.
 *
 * "Cannot say" is a first-class answer and the most important one. A run that
 * could not read the entry before or after has proved nothing, and a flow that
 * treated silence as safety would be exactly the bug this is here to prevent.
 */
export type Proof =
  | { readonly kind: "untouched" }
  | { readonly kind: "written"; readonly was: string; readonly now: string }
  | { readonly kind: "created"; readonly now: string }
  | { readonly kind: "vanished"; readonly was: string }
  | { readonly kind: "cannot-say"; readonly because: string };

export function whatItProves(before: CliLoginReading, after: CliLoginReading): Proof {
  if (before.kind === "unreadable") return { kind: "cannot-say", because: before.because };
  if (after.kind === "unreadable") return { kind: "cannot-say", because: after.because };

  if (before.kind === "none") {
    return after.kind === "none" ? { kind: "untouched" } : { kind: "created", now: after.lastChanged };
  }
  if (after.kind === "none") return { kind: "vanished", was: before.lastChanged };

  return before.lastChanged === after.lastChanged
    ? { kind: "untouched" }
    : { kind: "written", was: before.lastChanged, now: after.lastChanged };
}

/** Whether the run may carry on. Only an untouched login says yes. */
export function safeToCarryOn(proof: Proof): boolean {
  return proof.kind === "untouched";
}

/** One plain sentence, fit to show the user as it stands. */
export function describeProof(proof: Proof): string {
  switch (proof.kind) {
    case "untouched":
      return "your own Claude Code login was not written to.";
    case "written":
      return `your own Claude Code login was written to: it was dated ${proof.was} and is now dated ${proof.now}.`;
    case "created":
      return `a Claude Code login was created where there was none, dated ${proof.now}.`;
    case "vanished":
      return `your own Claude Code login is gone: it was dated ${proof.was} and there is now no entry at all.`;
    case "cannot-say":
      return `whether your own Claude Code login was written to could not be read: ${proof.because}`;
  }
}
