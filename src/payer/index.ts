/**
 * Who pays, and how that is decided.
 *
 * The Mode and the Seat the user picked are one small file on disk, read fresh
 * every time rather than remembered, so a change takes effect on the next request
 * and survives a restart of the relay. In Off mode nothing is chosen and the
 * caller's own credential travels untouched, which is what makes Off
 * indistinguishable from not having installed this at all.
 *
 * The Payer is one value for the machine and it is read fresh on every request
 * that is swapped. Nothing waits for the next conversation: a switch is in force
 * for the next request of a conversation already running, and the cost of that,
 * a history re-sent uncached to the new Organization, is stated after the fact
 * rather than gated before it.
 *
 * This is where the three modes are composed out of parts that each know one
 * thing: `src/chooser` says which Seat is worth the most, `src/usage` says what is
 * known about them, `src/conversation` says how much work a switch re-caches, and
 * `internal/auto` runs the ranking. Nothing here decides anything itself; it is
 * the one place that has all four and a request.
 */
import { openConversations, shapeOf, type Conversations } from "../conversation/index.ts";
import { describePick, type Pick } from "../chooser/index.ts";
import { readChoice } from "./internal/choice.ts";
import { openAuto, type Auto, type Standing } from "./internal/auto.ts";
import type { Choice } from "./internal/choice.ts";
import type { Charge, Decision, Exchange, RequestShape } from "../relay/index.ts";
import type { ListedSeat, SeatStore } from "../seats/index.ts";
import { refusalIsAboutTheSeat } from "../usage/index.ts";
import type { UsageMemory } from "../usage/index.ts";

export type { Mode, Choice } from "./internal/choice.ts";
export type { Pickable } from "./internal/pick.ts";
export type { Auto, Standing } from "./internal/auto.ts";
export { MODES, UNTOUCHED, readChoice, writeChoice } from "./internal/choice.ts";
export { pickPayer, turnOff } from "./internal/pick.ts";
export { openAuto, readStanding, writeStanding } from "./internal/auto.ts";

export type Payer = {
  /**
   * What should happen with one request: the Seat to charge it to, token and
   * identity together, and what the request itself is.
   *
   * Reads the choice, the Seats and what is known about them each time it is
   * asked, and keeps nothing between requests except which Seat each conversation
   * is sitting on. Whoever asks gets an answer that belongs to their own request
   * and to no other, which is also why the two halves come back together rather
   * than being left in a variable for the relay to pick up.
   *
   * The request's shape is read here because this is the only caller that has both
   * the body and a reason to look at it. What comes back is a model name and a
   * yes-or-no, and `src/conversation` is held to emitting nothing else.
   */
  decide(request: RequestShape): Promise<Decision>;
  /** The Mode and the Payer as they stand, for anyone who asks. */
  now(): Promise<Choice>;
  /** What Auto last settled on, and why, for anyone who asks. */
  standing(): Standing | null;
  /**
   * Where a refused request should be sent instead, or null to let the Refusal
   * stand.
   *
   * An ordinary switch, not a special case: the Seat goes on cooldown for that
   * model and the ranking is asked again. Three things make it return null, and each of them is deliberate. A Refusal we caused
   * ourselves (ADR 0005) is not the Seat's fault and moving would just get the same
   * answer somewhere else. In Manual the user picked one Seat on purpose (story 6),
   * so their choice is not quietly replaced. And with nothing left, the Window
   * account is the answer and the caller is told, never left guessing.
   */
  insteadOf(refused: Exchange, request: RequestShape): Promise<Charge | null>;
};

/** Nothing is being swapped: either Off, or Manual with no Seat picked. */
export function isOff(choice: Choice): boolean {
  return choice.mode === "off" || (choice.mode === "manual" && choice.payer === null);
}

export function openPayer(options: {
  file: string;
  seats: SeatStore;
  /**
   * What is known about each Seat's allowance. Without it, Auto has nothing to
   * rank on and every Seat reads as untouched, which is honest but blunt.
   */
  usage?: UsageMemory;
  conversations?: Conversations;
  auto?: Auto;
  /** Seconds since 1970. An argument, so the whole of this is testable. */
  now?: () => number;
  /** Told when a Payer was picked but cannot pay, which must never be silent. */
  onProblem?: (summary: string) => void;
  /**
   * Told when the Payer changed, and how many conversations that re-caches.
   *
   * Once per change rather than once per request, and after the fact: the switch
   * has already happened by the time this is called, because a gate before it is
   * the thing that was unshipped.
   */
  onSwitch?: (pick: Pick, conversationsRecached: number) => void;
}): Payer {
  const conversations = options.conversations ?? openConversations();
  const auto = options.auto ?? openAuto();
  const clock = options.now ?? (() => Math.trunc(Date.now() / 1000));

  /**
   * The Seat to charge, or null for the Window account, for one request.
   *
   * The Seat itself rather than its name, so the Seats are read once per request.
   * Looking the name up again afterwards read the file twice and left a gap where
   * the two reads could disagree about the same request.
   */
  async function seatFor(shape: ReturnType<typeof shapeOf>, at: number): Promise<ListedSeat | null> {
    // A read that fails must not read as Off. Falling back to the Window account
    // is allowed; doing it without saying so is not.
    let choice: Choice;
    try {
      choice = await readChoice(options.file);
    } catch (error) {
      options.onProblem?.(
        `could not read who should pay, so this request went to the Window account: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    if (choice.mode === "off") return null;

    const listed = await options.seats.list().catch((error: unknown) => {
      options.onProblem?.(
        `could not read the Seats, so this request went to the Window account: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    if (listed === null) return null;

    if (choice.mode === "manual") {
      if (choice.payer === null) return null;
      const seat = listed.find((held) => held.name === choice.payer);
      if (seat === undefined) {
        options.onProblem?.(
          `the Payer is "${choice.payer}", but there is no Seat by that name any more, ` +
            `so this request went to the Window account instead.`,
        );
        return null;
      }
      if (!seat.hasSendToken) {
        options.onProblem?.(
          `the Seat "${seat.name}" has no Send token, so this request went to the Window account instead. ` +
            `Mint one for it and add it again.`,
        );
        return null;
      }
      return seat;
    }

    // Auto. Ranked again on every request: the hold is gone, and a switch is in
    // force for conversations already running (see the module comment).
    const pick = await rankAgain(shape, listed, at);
    if (pick.seat === null) return null;
    return listed.find((held) => held.name === pick.seat) ?? null;
  }

  /**
   * Rank the Seats again for one request, and say so when the answer moved.
   *
   * Both the switch and the fallback to the Window account are reported on change
   * only. Deciding every request is cheap; saying it every request would bury the
   * one line that matters under a thousand identical ones.
   */
  async function rankAgain(shape: ReturnType<typeof shapeOf>, listed: readonly ListedSeat[], at: number): Promise<Pick> {
    // Placed so the count of live conversations is current. Nothing about the
    // decision depends on it any more; the count is what the switch costs.
    conversations.place(shape, at);
    const before = auto.standing();
    const known = (await options.usage?.known(at).catch(() => [])) ?? [];
    const pick = auto.decide({ model: shape.model, seats: listed, usage: known, at });

    if (before === null || before.seat !== pick.seat) {
      options.onSwitch?.(pick, conversations.held());
      if (pick.seat === null) options.onProblem?.(`nothing was swapped: ${describePick(pick)}`);
    }
    return pick;
  }

  /** The Seat's token and identity, or null when it cannot pay after all. */
  async function chargeFor(seat: ListedSeat | null): Promise<Charge | null> {
    if (seat === null) return null;

    const token = seat.hasSendToken ? await options.seats.sendTokenFor(seat.name).catch(() => null) : null;
    if (token === null) {
      options.onProblem?.(
        `the Seat "${seat.name}" has no Send token after all, so this request went to the Window account.`,
      );
      return null;
    }

    return { token, seat: seat.name, organizationId: seat.organization.id };
  }

  return {
    now: () => readChoice(options.file),
    standing: () => auto.standing(),

    async insteadOf(refused, request) {
      /**
       * A Refusal on a request that was not shaped like Code says nothing about
       * the Seat: those are refused for every premium model with a message that
       * reads like an exhausted allowance while the Seat is untouched (ADR 0005).
       * Sending it somewhere else would collect the same answer from a second Seat
       * and put a healthy one on cooldown on the way.
       *
       * One rule, asked of `src/usage`, rather than the shape test written out
       * again here. The two had drifted: a 429 whose own headers said the window
       * was spent was proof enough to set a cooldown and not proof enough to move
       * the request that earned it, so the work stayed on a Seat the memory had
       * already given up on.
       */
      if (!refusalIsAboutTheSeat(refused)) return null;

      const choice = await readChoice(options.file).catch(() => null);
      // Only Auto moves the work. In Manual the user picked one Seat on purpose,
      // and replacing their choice on their behalf is what story 6 forbids.
      if (choice === null || choice.mode !== "auto") return null;

      const at = clock();

      /**
       * The cooldown goes on before anything is chosen.
       *
       * `src/usage` runs its reads and writes through one queue, so the reading
       * below is already behind this write whether it is awaited or not. It is
       * awaited anyway, because a rule that holds because of something two modules
       * away is a rule that breaks the day that queue is optimised.
       */
      await options.usage?.rememberExchange(refused, at).catch(() => {});

      const listed = await options.seats.list().catch(() => null);
      if (listed === null) return null;

      const pick = await rankAgain(shapeOf(request.body), listed, at);

      if (pick.seat === null) {
        options.onProblem?.(
          `"${refused.chargedTo?.seat ?? "the Seat"}" answered ${refused.status} and ${describePick(pick)}`,
        );
        return null;
      }

      return chargeFor(listed.find((held) => held.name === pick.seat) ?? null);
    },

    async decide(request) {
      const read = shapeOf(request.body);
      const seat = await seatFor(read, clock());
      return {
        charge: await chargeFor(seat),
        about: { model: read.model, looksLikeCode: read.looksLikeCode, session: read.session },
      };
    },
  };
}
