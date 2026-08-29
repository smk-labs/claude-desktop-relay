import type { Multiplier } from "../../seats/index.ts";

/**
 * Why an Organization yields no Seat, or null when it yields one.
 *
 * Both of these are read off the server's own answer rather than decided here.
 * `free` is an Organization with no capacity to spend; `api-only` is one that
 * cannot hold a chat at all, which is what an evaluation Organization is.
 */
export type CannotPay = "free" | "api-only";


/**
 * What an account's own claude.ai login says it has spent in one Organization.
 *
 * Marked as read here, and it has to be. This figure and the one on a real
 * reply's headers are the same quantity from two different places, and they are
 * not interchangeable: a reply names the moment a Seat actually paid, where this
 * is a reading taken on the side and can be minutes stale. A Chooser that mixed
 * them would rank a Seat on a number it could not date.
 *
 * The share is 0 to 1, like the reply headers, because claude.ai states a
 * percentage and two scales for one quantity is a bug waiting for a reader.
 */
export type UsageAsRead = {
  readonly readVia: "stats-login";
  readonly fiveHour: AllowanceAsRead | null;
  readonly sevenDay: AllowanceAsRead | null;
};

/** One Allowance window as read: how much is spent, and when it starts again. */
export type AllowanceAsRead = {
  /** The share of the window already spent, 0 to 1. */
  readonly utilization: number;
  /** When the window resets, as seconds since 1970, or null if unsaid. */
  readonly resetsAt: number | null;
};

/** One Organization an account belongs to, as its Stats login reports it. */
export type OrganizationAsRead = {
  /** The bare UUID the server calls it. Never `org-` prefixed. */
  readonly id: string;
  /** What the user reads. Never compared against anything. */
  readonly label: string;
  /** Null when the server named a tier nothing here recognises. */
  readonly multiplier: Multiplier | null;
  readonly cannotPay: CannotPay | null;
  /**
   * What this Seat has spent, when it was asked for and could be read.
   *
   * Null covers both "not asked for" and "asked and the answer said nothing",
   * because neither is a figure and a consumer must work without one either way.
   */
  readonly usage: UsageAsRead | null;
};

/** One account, and every Organization it belongs to. */
export type AccountAsRead = {
  /** The login this was read from, so two accounts are told apart at a glance. */
  readonly profile: string;
  readonly account: string;
  readonly organizations: readonly OrganizationAsRead[];
};

/** A login that said nothing, and the reason, which is never swallowed. */
export type AccountUnread = {
  readonly profile: string;
  /** One plain sentence, fit to show the user as it stands. */
  readonly because: string;
};

/**
 * Everything the Stats logins said, including the ones that said nothing.
 *
 * The failures travel with the successes on purpose. A login that has expired is
 * the difference between "here is what you own" and "here is what could be read,
 * and these logins could not be", and reporting the first as if it were the whole
 * truth is how a Seat goes quietly missing for a year.
 */
export type WhatWasRead = {
  readonly accounts: readonly AccountAsRead[];
  readonly unread: readonly AccountUnread[];
};
