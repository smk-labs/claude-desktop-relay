/**
 * The Chooser, as a table. Seam two of the three the spec names.
 *
 * Every case here is a list of Seats in and one Seat out. No relay, no files, no
 * clock: the moment is an argument, so the ranking rule can be examined instead of
 * being reasoned about against a live machine. This is the only place the rule is
 * pinned down, which is why the cases are the ones a real bill would raise.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { choose, describePick } from "../src/chooser/index.ts";
import type { ListedSeat, Multiplier } from "../src/seats/index.ts";
import type { AllowanceKnown, SeatUsage } from "../src/usage/index.ts";

const NOON = 1_776_000_000;
const HOUR = 3600;
const DAY = 24 * HOUR;
const MODEL = "claude-opus-5";

function aSeat(name: string, multiplier: Multiplier, over: Partial<ListedSeat> = {}): ListedSeat {
  return {
    name,
    account: `${name}@example.com`,
    organization: { id: `org-${name}`, label: name },
    multiplier,
    hasSendToken: true,
    ...over,
  };
}

/** One window as it reads now. `spent` is the share, `in` is seconds until reset. */
function window(spent: number, resetsIn: number | null): AllowanceKnown {
  return {
    utilization: spent,
    resetsAt: resetsIn === null ? null : NOON + resetsIn,
    readAt: NOON,
    readVia: "exchange",
    ageSeconds: 0,
    hasReset: false,
  };
}

function usage(seat: string, over: Partial<SeatUsage> = {}): SeatUsage {
  return { seat, fiveHour: window(0, 5 * HOUR), sevenDay: window(0, 7 * DAY), cooldowns: {}, ...over };
}

const auto = (seats: readonly ListedSeat[], known: readonly SeatUsage[], model: string | null = MODEL) =>
  choose({ seats, usage: known, mode: "auto" as never, picked: null, model, at: NOON });

// `auto` is not a Mode until ticket 14, so the tests reach it the way that ticket
// will: any Mode that is not "off" or "manual" ranks. Written once, here.

test("a table of Seats in, one Seat and a stated reason out", () => {
  const picked = auto([aSeat("big", 20), aSeat("small", 1.25)], [usage("big"), usage("small")]);

  assert.equal(picked.seat, "big");
  assert.equal(picked.because, "it-had-the-most-room");
  assert.match(describePick(picked), /^big: it had the most room/);
  assert.equal(picked.considered.length, 2, "what was weighed is kept, so the choice can be read afterwards");
});

test("a Seat whose allowance is about to reset unused beats a larger Seat with days to go", () => {
  // Story 8, and the reason this program exists. The small Seat loses its week in
  // twenty minutes whatever happens; the big one has six days to spend its own.
  const picked = auto(
    [aSeat("big", 20), aSeat("expiring", 1.25)],
    [
      usage("big", { sevenDay: window(0, 6 * DAY) }),
      usage("expiring", { sevenDay: window(0, 20 * 60) }),
    ],
  );

  assert.equal(picked.seat, "expiring");
});

test("a large Seat at half spent beats a small Seat barely touched", () => {
  const picked = auto(
    [aSeat("big", 20), aSeat("small", 1.25)],
    [
      usage("big", { sevenDay: window(0.5, 3 * DAY) }),
      usage("small", { sevenDay: window(0.05, 3 * DAY) }),
    ],
  );

  // Ten times the remaining capacity of a Seat that is nearly untouched, which is
  // the whole reason a Multiplier is shown next to a percentage (story 4).
  assert.equal(picked.seat, "big");
});

test("free Seats never win, even when they are the only ones with room", () => {
  const picked = auto([aSeat("free", 0)], [usage("free")]);

  assert.equal(picked.seat, null);
  assert.equal(picked.because, "no-seat-can-pay");
  assert.equal(picked.considered[0]?.ruledOut, "free");
});

test("a Seat on cooldown for the requested model is not a candidate, but is for another", () => {
  const seats = [aSeat("resting", 20), aSeat("other", 1.25)];
  const known = [usage("resting", { cooldowns: { [MODEL]: NOON + 600 } }), usage("other")];

  assert.equal(auto(seats, known).seat, "other", "it walked into the wall it was just refused at");
  // One model refusing is not every model. ADR 0005: a Refusal is evidence about
  // one request.
  assert.equal(auto(seats, known, "claude-haiku-4-5-20251001").seat, "resting");
});

test("a cooldown that has run out stops mattering", () => {
  const seats = [aSeat("rested", 20), aSeat("other", 1.25)];
  // `usage.known()` drops expired cooldowns, so the Chooser sees none. This asserts
  // it does not carry its own idea of expiry on top of that.
  assert.equal(auto(seats, [usage("rested"), usage("other")]).seat, "rested");
});

test("a Seat with no Send token is not a candidate, whatever it is worth", () => {
  const picked = auto([aSeat("big", 20, { hasSendToken: false }), aSeat("small", 1.25)], [usage("big"), usage("small")]);

  assert.equal(picked.seat, "small");
  assert.equal(picked.considered.find((one) => one.seat === "big")?.ruledOut, "no-send-token");
});

test("with nothing eligible it returns the Window account, with that as the reason", () => {
  const spent = auto(
    [aSeat("one", 20), aSeat("two", 6.25)],
    [
      usage("one", { fiveHour: window(1, 5 * HOUR), sevenDay: window(1, 3 * DAY) }),
      usage("two", { fiveHour: window(1, 5 * HOUR), sevenDay: window(1, 3 * DAY) }),
    ],
  );

  assert.equal(spent.seat, null);
  assert.equal(spent.because, "no-seat-has-room");
  assert.match(describePick(spent), /the Window account: every Seat you own is spent or resting/);
});

test("owning no Seats at all is told apart from owning Seats with nothing left", () => {
  const none = auto([], []);
  assert.equal(none.because, "no-seat-can-pay", "a reader with no Seats and a reader with spent Seats need different help");
});

test("a five-hour window with nothing left makes a Seat worth nothing, whatever its Multiplier", () => {
  // A request needs room in both windows, and the scarcer one is what it hits. A
  // 20x Seat with a fresh week and an exhausted five hours will refuse the very
  // next request.
  const picked = auto(
    [aSeat("locked", 20), aSeat("free-to-work", 1.25)],
    [usage("locked", { fiveHour: window(1, 4 * HOUR) }), usage("free-to-work")],
  );

  assert.equal(picked.seat, "free-to-work");
});

test("a Seat with more allowance left than time to spend it is preferred over one pacing evenly", () => {
  // The five-hour adjustment, on its own: same Multiplier, same week, and the only
  // difference is that one is about to lose what it has not spent.
  const picked = auto(
    [aSeat("about-to-lose-it", 20), aSeat("pacing", 20)],
    [
      usage("about-to-lose-it", { fiveHour: window(0.1, 30 * 60) }),
      usage("pacing", { fiveHour: window(0.1, 5 * HOUR) }),
    ],
  );

  assert.equal(picked.seat, "about-to-lose-it");
});

test("a Seat nothing is known about is read as untouched, and says that it was assumed", () => {
  const picked = auto([aSeat("unread", 6.25)], []);

  assert.equal(picked.seat, "unread");
  // Stated rather than silent. A Send token cannot read usage, so a Seat with no
  // reply is most often a Seat nobody has used; being wrong costs one Refusal,
  // which puts it on cooldown and moves the work along.
  assert.equal(picked.considered[0]?.weekly.assumed, true);
  assert.equal(picked.considered[0]?.fiveHour.assumed, true);
});

test("a Seat whose window has turned over reads as empty rather than as spent", () => {
  const reset: SeatUsage = {
    seat: "turned-over",
    fiveHour: { ...window(0.99, 5 * HOUR), hasReset: true, utilization: 0 },
    sevenDay: { ...window(0.99, 2 * DAY), hasReset: true, utilization: 0 },
    cooldowns: {},
  };
  const picked = auto([aSeat("turned-over", 1.25), aSeat("busy", 20)], [reset, usage("busy", { sevenDay: window(0.95, 6 * DAY) })]);

  assert.equal(picked.seat, "turned-over");
});

// ---- the Modes --------------------------------------------------------------

test("Off leaves everything on the Window account, whatever any Seat is worth", () => {
  const picked = choose({
    seats: [aSeat("big", 20)],
    usage: [usage("big")],
    mode: "off",
    picked: "big",
    model: MODEL,
    at: NOON,
  });

  assert.equal(picked.seat, null);
  assert.equal(picked.because, "it-is-off");
});

test("Manual holds the Seat the user picked, even when another would score higher", () => {
  const picked = choose({
    seats: [aSeat("chosen", 1.25), aSeat("better", 20)],
    usage: [usage("chosen"), usage("better")],
    mode: "manual",
    picked: "chosen",
    model: MODEL,
    at: NOON,
  });

  // Story 6: a deliberate choice is not something the app gets to second-guess.
  assert.equal(picked.seat, "chosen");
  assert.equal(picked.because, "the-user-picked-it");
});

test("Manual on a Seat that cannot pay falls back to the Window account, not to another Seat", () => {
  const picked = choose({
    seats: [aSeat("chosen", 20, { hasSendToken: false }), aSeat("better", 20)],
    usage: [usage("chosen"), usage("better")],
    mode: "manual",
    picked: "chosen",
    model: MODEL,
    at: NOON,
  });

  // Quietly choosing another Seat here is the failure the spec calls closed but
  // never quiet: the user believes one Seat is paying while another is.
  assert.equal(picked.seat, null);
  assert.equal(picked.because, "the-picked-seat-cannot-pay");
});

test("Manual with nothing ever picked is the same as Off, and never a guess", () => {
  const picked = choose({
    seats: [aSeat("big", 20)],
    usage: [usage("big")],
    mode: "manual",
    picked: null,
    model: MODEL,
    at: NOON,
  });

  assert.equal(picked.seat, null);
  assert.equal(picked.because, "it-is-off");
});

// ---- the property that makes it safe to use per request ---------------------

test("the same inputs always give the same answer", () => {
  // Several Seats of one Multiplier that nothing is known about is the ordinary
  // case, and they score identically. An unstable order there would move
  // the Payer between requests of one conversation and throw away prompt caching
  // for nothing at all (ADR 0003).
  const seats = ["d", "b", "a", "c"].map((name) => aSeat(name, 6.25));

  const answers = new Set(Array.from({ length: 20 }, () => JSON.stringify(auto(seats, []))));
  assert.equal(answers.size, 1, "twenty identical calls gave more than one answer");
  assert.equal(auto(seats, []).seat, "a", "ties are broken by name, so the order never moves");

  // And it holds when the input is shuffled, which is what reading a file gives.
  assert.equal(auto([...seats].reverse(), []).seat, "a");
});

test("the moment is an argument, so the same figures rank differently as the reset approaches", () => {
  const seats = [aSeat("small", 1.25), aSeat("big", 20)];
  const known = [
    usage("small", { sevenDay: window(0, 6 * DAY) }),
    usage("big", { sevenDay: window(0, 6 * DAY) }),
  ];

  // Six days out, capacity is what matters and the big Seat wins.
  const early = choose({ seats, usage: known, mode: "auto" as never, picked: null, model: MODEL, at: NOON });
  assert.equal(early.seat, "big");

  // Both weeks reset at the same moment, so approaching it changes both scores by
  // the same factor and the answer holds. This is the property that matters: the
  // clock moves the numbers and never the ordering on its own.
  const late = choose({
    seats,
    usage: known,
    mode: "auto" as never,
    picked: null,
    model: MODEL,
    at: NOON + 6 * DAY - 20 * 60,
  });
  assert.equal(late.seat, "big");
  assert.equal(
    (late.considered[0]?.score ?? 0) > (early.considered[0]?.score ?? 0),
    true,
    "the same allowance twenty minutes from being lost is worth more than six days out",
  );
});

/**
 * The bug this test was written to catch, and it did.
 *
 * A reset moment already in the past was read as "resets in no time at all", so a
 * Seat with a completely fresh week looked like the most urgent thing on the
 * machine. A reset that has happened means the opposite: the next one is a whole
 * week away.
 */
test("a reset moment that has already passed means a fresh window, not maximum urgency", () => {
  const seats = [aSeat("just-reset", 1.25), aSeat("expiring", 1.25)];
  const known = [
    // Its week turned over an hour ago, so the next reset is nearly a week out.
    usage("just-reset", { sevenDay: { ...window(0, -HOUR), hasReset: true } }),
    usage("expiring", { sevenDay: window(0, 20 * 60) }),
  ];

  const picked = choose({ seats, usage: known, mode: "auto" as never, picked: null, model: MODEL, at: NOON });
  assert.equal(picked.seat, "expiring", "the Seat with a whole week ahead was treated as the urgent one");
});

/**
 * The three numbers carried over from claude-deck, pinned as cases rather than as
 * constants.
 *
 * A test that read `URGENCY` back would pass whatever it was changed to. These
 * cases each fail at the value this module was written with, so re-deriving the
 * tuning by feel a second time cannot happen quietly.
 */
test("urgency outranks size: a small Seat whose week dies tonight beats a big idle one", () => {
  // At an exponent of one these two sit two-to-one and the five-hour term flips
  // them. At 2.5 the gap is two orders of magnitude and nothing flips it.
  const picked = auto(
    [aSeat("big", 20), aSeat("dying", 1)],
    [
      { ...usage("big"), sevenDay: window(0.5, 100 * HOUR) },
      { ...usage("dying"), sevenDay: window(0, 5 * HOUR) },
    ],
  );

  assert.equal(picked.seat, "dying");
  const scoreOf = (name: string) => picked.considered.find((c) => c.seat === name)?.score ?? 0;
  assert.ok(scoreOf("dying") > 50 * scoreOf("big"), "the week about to be lost has to win by a mile, not a nose");
});

test("under an hour to the reset, the divisor stops shrinking", () => {
  // The floor is one hour, and it is load-bearing at an exponent of 2.5: a divisor
  // of a twelfth would be a five-hundred-fold bonus, so a Seat with a sliver of
  // allowance and a reset a minute away would outrank every healthy Seat here.
  // Two identical Seats, one five minutes from its reset and one a full hour, have
  // to come out level.
  const picked = auto(
    [aSeat("minutes", 1), aSeat("an-hour", 1)],
    [
      { ...usage("minutes"), sevenDay: window(0.99, 5 * 60) },
      { ...usage("an-hour"), sevenDay: window(0.99, HOUR) },
    ],
  );

  const scoreOf = (name: string) => picked.considered.find((c) => c.seat === name)?.score ?? 0;
  assert.equal(scoreOf("minutes"), scoreOf("an-hour"));
  assert.ok(scoreOf("minutes") > 0);
});

test("the five-hour window can never resurrect a Seat whose week is gone", () => {
  // The best pace the rule allows, against a week with nothing in it. The factor is
  // a bounded multiplier on the weekly score, so a base of zero stays zero however
  // much of the five-hour window is about to expire unused.
  const picked = auto(
    [aSeat("dead-week", 20), aSeat("alive", 1)],
    [
      { ...usage("dead-week"), sevenDay: window(1, 2 * DAY), fiveHour: window(0, 5 * 60) },
      { ...usage("alive"), sevenDay: window(0.5, 2 * DAY), fiveHour: window(0.5, 3 * HOUR) },
    ],
  );

  assert.equal(picked.seat, "alive");
  assert.equal(picked.considered.find((c) => c.seat === "dead-week")?.score, 0);
});

test("the five-hour window reorders near-equals and no more", () => {
  // Worst pace against best pace is a span of 0.05 to 1.5, so it can move a Seat by
  // thirty-fold at the very most. A weekly score two orders of magnitude ahead has
  // to survive it; the earlier ratio form, which reached four with a floor of
  // nothing, could swing further than the numbers it was multiplying.
  const picked = auto(
    [aSeat("far-better-week", 20), aSeat("expiring-now", 1)],
    [
      { ...usage("far-better-week"), sevenDay: window(0, 2 * DAY), fiveHour: window(0.95, 5 * HOUR) },
      { ...usage("expiring-now"), sevenDay: window(0.9, 2 * DAY), fiveHour: window(0, 5 * 60) },
    ],
  );

  assert.equal(picked.seat, "far-better-week");
});

test("a fresh five-hour window is neutral, so the weekly signal does the ranking", () => {
  const picked = auto(
    [aSeat("fresh", 1), aSeat("spent-window", 1)],
    [
      { ...usage("fresh"), fiveHour: window(0, 5 * HOUR) },
      { ...usage("spent-window"), fiveHour: window(0.8, 5 * HOUR) },
    ],
  );

  const scoreOf = (name: string) => picked.considered.find((c) => c.seat === name)?.score ?? 0;
  assert.equal(picked.seat, "fresh");
  assert.ok(scoreOf("spent-window") > 0, "a bad pace is a penalty, never a disqualifier");
  assert.ok(scoreOf("spent-window") < scoreOf("fresh"));
});

test("a Seat whose five-hour window is spent is not a candidate at all", () => {
  // Measured on 2026-08-26 and the reason this rule-out exists. The spent Seat
  // scored a pace of 0.69 and stayed top of the ranking for six hours and 2,250
  // requests while Seats with a fresh window sat idle beside it. A bounded
  // multiplier cannot say "locked out"; only a rule-out can.
  const seats = [aSeat("spent", 6.25), aSeat("fresh", 1.25)];
  const known = [
    usage("spent", { fiveHour: window(1.02, 90 * 60), sevenDay: window(0.32, 16 * HOUR) }),
    usage("fresh", { fiveHour: window(0.07, 90 * 60), sevenDay: window(0.01, 18 * HOUR) }),
  ];

  const picked = auto(seats, known);

  assert.equal(picked.seat, "fresh");
  assert.equal(picked.considered.find((one) => one.seat === "spent")?.ruledOut, "five-hour-window-spent");
});

test("a spent five-hour window stops ruling a Seat out the moment it turns over", () => {
  const spent = { ...window(1.02, -60), hasReset: true, utilization: 0 };
  const picked = auto([aSeat("spent", 6.25)], [usage("spent", { fiveHour: spent })]);

  assert.equal(picked.seat, "spent");
  assert.equal(picked.considered[0]?.ruledOut, null);
});

test("a spent five-hour window that named no reset is trusted for one window and no longer", () => {
  // Nothing says when this one turns over, so the reading is all there is and it
  // stops being about the window that is running now once a window has passed.
  const noReset = (ageSeconds: number) => ({ ...window(1, null), ageSeconds });

  assert.equal(
    auto([aSeat("spent", 20)], [usage("spent", { fiveHour: noReset(HOUR) })]).considered[0]?.ruledOut,
    "five-hour-window-spent",
  );
  assert.equal(
    auto([aSeat("spent", 20)], [usage("spent", { fiveHour: noReset(6 * HOUR) })]).considered[0]?.ruledOut,
    null,
  );
});

test("every Seat spent for its five-hour window leaves the Window account paying, with the reason", () => {
  const picked = auto(
    [aSeat("one", 20), aSeat("two", 6.25)],
    [
      usage("one", { fiveHour: window(1, HOUR) }),
      usage("two", { fiveHour: window(1, HOUR) }),
    ],
  );

  assert.equal(picked.seat, null);
  assert.equal(picked.because, "no-seat-has-room");
});
