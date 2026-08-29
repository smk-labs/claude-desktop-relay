import { readChoice, writeChoice, type Choice } from "./choice.ts";

/** All this needs to know about a Seat to decide whether it can be the Payer. */
export type Pickable = { readonly name: string; readonly hasSendToken: boolean };

/**
 * Pick a Seat to pay, by name.
 *
 * A Seat that does not exist, or exists with no Send token, is refused with a
 * reason and the previous choice stands: half-applying this would leave the user
 * believing one Seat is paying while another is.
 */
export async function pickPayer(options: {
  file: string;
  among: readonly Pickable[];
  name: string;
}): Promise<Choice> {
  const seat = options.among.find((held) => held.name === options.name);

  if (seat === undefined) {
    const known = options.among.map((held) => held.name);
    throw new Error(
      `there is no Seat called "${options.name}". ` +
        (known.length === 0 ? "No Seats have been added yet." : `There is ${known.join(", ")}.`),
    );
  }

  if (!seat.hasSendToken) {
    throw new Error(
      `the Seat "${seat.name}" has no Send token, so it cannot pay for anything. ` +
        `Mint one for it and add it again. The Payer has not been changed.`,
    );
  }

  const chosen: Choice = { mode: "manual", payer: seat.name };
  await writeChoice(options.file, chosen);
  return chosen;
}

/** Leave every request on the Window account. */
export async function turnOff(file: string): Promise<Choice> {
  const chosen: Choice = { mode: "off", payer: (await readChoice(file)).payer };
  await writeChoice(file, chosen);
  return chosen;
}
