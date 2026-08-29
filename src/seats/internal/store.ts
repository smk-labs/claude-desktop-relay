import { readJsonFile, writeJsonFile } from "../../json-file/index.ts";

import type { Vault } from "./vault.ts";

/**
 * A Seat's weekly capacity relative to a Pro plan. Free Seats are 0, and the
 * Chooser will never pick one.
 */
export type Multiplier = 20 | 6.25 | 5 | 1.25 | 1 | 0;

/**
 * The billed group a Seat belongs to, under both its names.
 *
 * The two are never interchangeable. The id is what the server calls it and the
 * only thing a claim about who paid can be checked against. The label is what the
 * user reads, and the user may change it whenever they like.
 */
export type Organization = {
  /** As the server names it, for example `org-1a2b3c`. */
  readonly id: string;
  /** As the user reads it. Never compared against anything. */
  readonly label: string;
};

/** One account in one Organization. The unit that holds an allowance. */
export type Seat = {
  /** How the user refers to this Seat. Unique, and the key everywhere. */
  readonly name: string;
  readonly account: string;
  readonly organization: Organization;
  readonly multiplier: Multiplier;
};

/** A Seat as listed, with whether its Send token is actually there. */
export type ListedSeat = Seat & { readonly hasSendToken: boolean };

export type SeatStore = {
  /** Add a Seat, or replace one of the same name. */
  add(seat: Seat, sendToken: string): Promise<void>;
  /**
   * Change what is known about a Seat that is already held, without going near
   * its Send token.
   *
   * Separate from `add` on purpose. Keeping a plan change and a credential in one
   * call would mean re-pasting a token every time a Team renamed itself, and
   * would give a refresh the power to overwrite a credential it never read.
   * An unknown name is an error rather than an insert.
   */
  update(seat: Seat): Promise<void>;
  list(): Promise<ListedSeat[]>;
  /** Remove the Seat and forget its Send token. Unknown names are not an error. */
  remove(name: string): Promise<void>;
  /** The Seat's Send token. An unknown Seat, or a missing token, is an error. */
  sendTokenFor(name: string): Promise<string>;
};

type OnDisk = { readonly seats: readonly Seat[] };

async function read(file: string): Promise<Seat[]> {
  const held = await readJsonFile<OnDisk>(file);
  return Array.isArray(held?.seats) ? [...held.seats] : [];
}

async function write(file: string, seats: readonly Seat[]): Promise<void> {
  await writeJsonFile(file, { seats } satisfies OnDisk);
}

/**
 * The list of Seats and their credentials.
 *
 * The file holds identity and Multiplier. The Send tokens live in the vault and
 * are never written here, which a test proves by reading the file.
 */
export function openSeatStore(options: { file: string; vault: Vault }): SeatStore {
  const { file, vault } = options;

  return {
    async add(seat, sendToken) {
      // A blank Organization id would later be compared against a server answer
      // and could match another blank, which would report a swap as proved when
      // nothing was proved at all.
      if (seat.organization.id.trim() === "") {
        throw new Error(`the Seat "${seat.name}" needs an Organization id, which is what the server names`);
      }
      const seats = await read(file);
      const without = seats.filter((held) => held.name !== seat.name);
      await vault.put(seat.name, sendToken);
      await write(file, [...without, seat]);
    },

    async update(seat) {
      const seats = await read(file);
      if (!seats.some((held) => held.name === seat.name)) {
        throw new Error(`there is no Seat called "${seat.name}" to bring up to date`);
      }
      await write(file, seats.map((held) => (held.name === seat.name ? seat : held)));
    },

    async list() {
      const seats = await read(file);
      return Promise.all(
        seats.map(async (seat) => ({ ...seat, hasSendToken: (await vault.get(seat.name)) !== null })),
      );
    },

    async remove(name) {
      const seats = await read(file);
      await vault.forget(name);
      await write(file, seats.filter((seat) => seat.name !== name));
    },

    async sendTokenFor(name) {
      const seats = await read(file);
      if (!seats.some((seat) => seat.name === name)) {
        throw new Error(`there is no Seat called "${name}"`);
      }

      const token = await vault.get(name);
      if (token === null) {
        throw new Error(`the Seat "${name}" has no Send token. Mint one for it and add it again.`);
      }
      return token;
    },
  };
}
