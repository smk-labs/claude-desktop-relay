/**
 * The coverage matrix: which ways of making Claude do work land on the Seat we
 * chose, measured rather than reasoned about.
 *
 * Pure. Reading and writing the record is the caller's business; this is the
 * paths, the judgement and the table.
 */

/** One way this app can make Claude do work. */
export type Path = {
  /** Short, stable, and what a row is keyed by. Never renamed once measured. */
  readonly key: string;
  readonly called: string;
  /** Exactly what a person has to do in the Proving Window. Never a paraphrase. */
  readonly byHand: readonly string[];
  /** Why this one is worth measuring, or what is expected to go wrong. */
  readonly note: string;
};

/**
 * The twelve paths of ticket 21, in the order they are worth doing.
 *
 * Anything running inside the Code session's own process is covered by
 * construction: the mechanism is an environment variable a child inherits, and a
 * subagent is another context window in the same program. Those are here to be
 * proved rather than assumed. The ones that matter are where a separate process or
 * a separate network stack is involved.
 */
export const PATHS: readonly Path[] = [
  {
    key: "plain",
    called: "A plain conversation in the Window",
    byHand: [
      "In the Proving Window, start a Code session in any folder.",
      'Ask it: "read package.json and tell me the name field".',
      "Wait for the answer.",
    ],
    note: "The baseline. If this fails, nothing below means anything.",
  },
  {
    key: "one-subagent",
    called: "A single subagent inside a session",
    byHand: [
      "In the same session, ask: \"use a subagent to find every .ts file under src and report the count\".",
      "Wait for the subagent to report.",
    ],
    note: "Same process, same environment. Expected covered by construction.",
  },
  {
    key: "many-subagents",
    called: "Several subagents at once",
    byHand: [
      'Ask: "launch three subagents in parallel, each summarising one file under docs, and report all three".',
      "Wait for all three.",
    ],
    note: "Adds concurrency, which is where the collapse of 2026-08-22 lived.",
  },
  {
    key: "workflow",
    called: "A workflow fanning out across agents",
    byHand: [
      'Ask: "use a workflow with two phases and two agents each to list the files under src and test".',
      "Wait for the workflow to finish.",
    ],
    note: "Same process again, but many agents and a real fan-out.",
  },
  {
    key: "nested-claude",
    called: "A nested claude started from a shell command",
    byHand: [
      "Ask the session to run this in a shell:",
      '  claude -p "Reply with exactly: nested ok"',
      "Report whether it answered, or what it said instead.",
    ],
    note: "A separate process. Covered only if the app passes its environment down.",
  },
  {
    key: "compaction",
    called: "Auto-compaction and the app's own summarising",
    byHand: [
      "Keep the session going until it compacts on its own, or ask it to compact.",
      "Report whether compaction completed.",
    ],
    note: "A request the app makes for itself, not one the user asked for.",
  },
  {
    key: "side-requests",
    called: "Conversation titles and other small side-requests",
    byHand: [
      "Start a brand new conversation in the Proving Window and send one message.",
      "Report whether the conversation gained a title of its own.",
    ],
    note: "These may come from the app rather than a Code session, which is a different process.",
  },
  {
    key: "scheduled",
    called: "A scheduled task firing with nobody watching",
    byHand: [
      "Schedule a task in the Proving Window for a couple of minutes from now.",
      "Leave the Window alone until it fires, then report whether it did its work.",
    ],
    note: "Fires without a session in front of it, so it may be started differently.",
  },
  {
    key: "cowork",
    called: "Work inside the Cowork virtual machine",
    byHand: [
      "Open Cowork in the Proving Window and ask it to do anything that needs Claude.",
      "Report whether it worked.",
    ],
    note: "Its own network stack and its own address. The one most likely not covered.",
  },
  {
    key: "remote",
    called: "A session on another machine over a remote connection",
    byHand: ["Nothing. This one leaves from the other machine, so a relay here cannot see it."],
    note: "Out of scope by the spec. Recorded as a stated limit rather than an omission.",
  },
  {
    key: "cloud",
    called: "A cloud session",
    byHand: ["Nothing. Measured already: billable but unusable."],
    note: "The request never leaves from here, so the relay cannot move it.",
  },
  {
    key: "mcp",
    called: "Traffic from MCP servers",
    byHand: [
      "Ask the session to use any MCP tool.",
      "Report whether the tool answered.",
    ],
    note: "An MCP server talks to its own host with its own credential and costs no allowance. What it returns becomes input tokens on whichever Seat is paying.",
  },
];

/** What was found out about one path, and when. */
export type Row = {
  readonly key: string;
  /**
   * `covered` means the work completed with the negative control armed, so it can
   * only have completed through the relay. `not-covered` means it did not, or it
   * completed while the relay saw nothing, which is the same thing said twice.
   */
  readonly verdict: "covered" | "not-covered" | "not-applicable";
  /** The day it was measured, as `YYYY-MM-DD`. */
  readonly on: string;
  /** The app and CLI versions it was measured against. */
  readonly versions: string;
  /** What the relay's own record said while the work was being done. */
  readonly saw: { readonly verified: number; readonly mismatch: number; readonly unverified: number };
  /** Anything a reader needs that the numbers do not say. */
  readonly saying: string;
};

export type Record_ = { readonly rows: readonly Row[]; readonly negativeControl: boolean };

/**
 * The judgement, and it is deliberately not a count.
 *
 * A request that went round the relay is simply absent, and an absence looks
 * exactly like work that never happened. With the negative control armed the
 * Window's own credential cannot buy anything, so completing the work is the
 * proof and the counts are only there to say what it looked like from here.
 *
 * The one thing a count can prove is the bad case: a swap the server said went to
 * a different Organization is a failure whatever the work did.
 */
export function judgePath(options: {
  workCompleted: boolean;
  negativeControl: boolean;
  saw: Row["saw"];
}): { verdict: "covered" | "not-covered"; saying: string } {
  if (!options.negativeControl) {
    return {
      verdict: "not-covered",
      saying:
        "the negative control was not armed, so nothing was proved: work completing " +
        "is what the Window's own credential does anyway.",
    };
  }

  if (options.saw.mismatch > 0) {
    return {
      verdict: "not-covered",
      saying: `${options.saw.mismatch} exchanges were paid for by a different Organization than the Seat chosen.`,
    };
  }

  if (!options.workCompleted) {
    return {
      verdict: "not-covered",
      saying:
        options.saw.verified === 0
          ? "the work did not complete and no request reached the relay, so this path goes round it."
          : `the work did not complete, though ${options.saw.verified} requests were swapped, so something else stopped it.`,
    };
  }

  if (options.saw.verified === 0) {
    return {
      verdict: "not-covered",
      saying:
        "the work completed while the relay saw nothing, which with the control armed should be impossible. " +
        "Check that the control is really in that Window's store before believing this.",
    };
  }

  return {
    verdict: "covered",
    saying: `${options.saw.verified} exchanges swapped and verified, on a credential that cannot buy anything.`,
  };
}

const MARK: Record<Row["verdict"], string> = {
  covered: "covered",
  "not-covered": "**not covered**",
  "not-applicable": "not applicable",
};

/** The matrix as a table, built from the record so the two cannot disagree. */
export function asTable(record: Record_): readonly string[] {
  const found = new Map(record.rows.map((row) => [row.key, row] as const));

  const lines = [
    "| Path | Result | Measured | What the relay saw |",
    "| --- | --- | --- | --- |",
  ];

  for (const path of PATHS) {
    const row = found.get(path.key);
    if (row === undefined) {
      lines.push(`| ${path.called} | not measured yet | — | — |`);
      continue;
    }
    const saw =
      row.verdict === "not-applicable"
        ? "—"
        : `${row.saw.verified} verified, ${row.saw.mismatch} to another Organization, ${row.saw.unverified} unproved`;
    lines.push(`| ${path.called} | ${MARK[row.verdict]} | ${row.on}, ${row.versions} | ${saw} |`);
  }

  return lines;
}

/** Every path that has been measured and found not to be covered. */
export function knownLimits(record: Record_): readonly Row[] {
  return record.rows.filter((row) => row.verdict !== "covered");
}
