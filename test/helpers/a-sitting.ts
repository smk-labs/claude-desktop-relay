import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserProfile } from "../../src/browser/index.ts";
import type { CliLoginReading } from "../../src/cli-login/index.ts";
import type { MintOutcome } from "../../src/minting/index.ts";
import { openSeatStore, type Seat, type SeatStore } from "../../src/seats/index.ts";
import type { Asking, WhatASittingNeeds } from "../../src/sitting/index.ts";
import type { Verdict } from "../../src/verify/index.ts";
import type { WorklistEntry } from "../../src/worklist/index.ts";
import { aVaultInMemory } from "./a-vault-in-memory.ts";

export const A_TOKEN = "sk-ant-oat01-one-that-only-a-test-ever-sees";

export function aSeat(what: Partial<Seat> = {}): Seat {
  return {
    name: "bo-acme-c3d4",
    account: "bo@example.com",
    organization: { id: "c3d4e5f6-0000-4000-8000-000000000003", label: "Acme" },
    multiplier: 5,
    ...what,
  };
}

export function anEntry(what: Partial<Seat> = {}): WorklistEntry {
  return { seat: aSeat(what), filled: false };
}

/** A Probe that proved the Seat: the server named the Organization it was for. */
export const verified: Verdict = {
  kind: "verified",
  seat: "bo-acme-c3d4",
  expected: "c3d4e5f6-0000-4000-8000-000000000003",
  paidBy: "c3d4e5f6-0000-4000-8000-000000000003",
  method: "POST",
  path: "/v1/messages",
  status: 200,
  refused: false,
  because: null,
};

/** The likeliest mistake in a sitting: the wrong Organization was active. */
export const paidBySomebodyElse: Verdict = {
  ...verified,
  kind: "mismatch",
  paidBy: "eeeeeeee-0000-0000-0000-000000000000",
  because: "a-different-organization-paid",
};

/**
 * Everything a sitting reaches for, replaced.
 *
 * The whole flow runs against this: no network, no Keychain, no Claude Desktop, no
 * browser and no authorization. What each part was asked and what it answered is
 * recorded, so a test says what the flow did rather than what it returned.
 */
export type WhatHappened = {
  said: string[];
  complaints: string[];
  mintedIn: string[];
  probed: { token: string; seat: string }[];
  backups: number;
  cliLoginReads: number;
};

export type ASitting = {
  readonly needs: WhatASittingNeeds;
  readonly seats: SeatStore;
  /** Read after the flow has run. One object, so counts on it stay current. */
  readonly it: WhatHappened;
  readonly away: () => Promise<void>;
};

export async function aSittingWhere(options: {
  mint?: (folder: string) => Promise<MintOutcome>;
  probe?: (token: string, seat: Seat) => Promise<Verdict>;
  cliLogin?: (readsSoFar: number) => CliLoginReading;
  profiles?: readonly BrowserProfile[];
  readyFor?: () => Promise<boolean>;
  carryOn?: Asking["carryOn"];
  backUp?: () => Promise<{ kind: "backed-up"; file: string } | { kind: "not-backed-up"; because: string }>;
  somebodyIsAtTheKeyboard?: boolean;
} = {}): Promise<ASitting> {
  const folder = await mkdtemp(join(tmpdir(), "relay-sitting-"));
  const seats = openSeatStore({ file: join(folder, "seats.json"), vault: aVaultInMemory() });

  const it: WhatHappened = {
    said: [],
    complaints: [],
    mintedIn: [],
    probed: [],
    backups: 0,
    cliLoginReads: 0,
  };

  const needs: WhatASittingNeeds = {
    seats,
    somebodyIsAtTheKeyboard: options.somebodyIsAtTheKeyboard ?? true,
    under: folder,
    say: (line = "") => void it.said.push(line),
    complain: (line) => void it.complaints.push(line),
    backUp: async () => {
      it.backups += 1;
      return options.backUp === undefined ? { kind: "backed-up", file: `${folder}/a-backup` } : await options.backUp();
    },
    readBrowserProfiles: async () => [...(options.profiles ?? [])],
    readTheCliLogin: async () => {
      it.cliLoginReads += 1;
      return options.cliLogin === undefined
        ? { kind: "held", lastChanged: "20260822031527Z" }
        : options.cliLogin(it.cliLoginReads);
    },
    mint: async (one) => {
      it.mintedIn.push(one.folder);
      await one.link("https://claude.ai/oauth/authorize?code=true&state=abc");
      return options.mint === undefined ? { kind: "minted", token: A_TOKEN } : await options.mint(one.folder);
    },
    probe: async ({ token, seat }) => {
      it.probed.push({ token, seat: seat.name });
      return options.probe === undefined ? verified : await options.probe(token, seat);
    },
    ask: {
      readyFor: options.readyFor ?? (async () => true),
      carryOn: options.carryOn ?? (async () => true),
    },
  };

  return { needs, seats, it, away: () => rm(folder, { recursive: true, force: true }) };
}
