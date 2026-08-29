import type { Vault } from "../../src/seats/index.ts";

/**
 * A stand-in for the machine's Keychain, so no test touches the real one.
 *
 * It records what it was asked to do, which is how a test proves the store never
 * puts a credential anywhere else.
 */
export type VaultInMemory = Vault & {
  readonly held: Map<string, string>;
  readonly asked: string[];
};

export function aVaultInMemory(): VaultInMemory {
  const held = new Map<string, string>();
  const asked: string[] = [];

  return {
    held,
    asked,
    async put(name, token) {
      asked.push(`put ${name}`);
      held.set(name, token);
    },
    async get(name) {
      asked.push(`get ${name}`);
      return held.get(name) ?? null;
    },
    async forget(name) {
      asked.push(`forget ${name}`);
      held.delete(name);
    },
  };
}
