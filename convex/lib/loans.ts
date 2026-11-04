import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { rangesOverlap, todayUtc } from "./validation";

type Ctx = QueryCtx | MutationCtx;

/**
 * Loans that currently block a tool.
 *
 * An `approved` loan keeps the tool reserved until the lender marks it returned.
 * That includes overdue loans: a loan past its return date is still out, so the
 * board must not advertise the tool as available. `returned` is a different
 * status, so returning the tool frees it automatically.
 *
 * Only `approved` loans reserve a tool. Several neighbors may hold `pending`
 * requests for the same weekend — the owner picks — but once one is approved the
 * range is taken, and approving a second overlapping request is refused.
 */
export async function lentToolsByToolId(
  ctx: Ctx,
  now = Date.now(),
): Promise<Map<Id<"tools">, Doc<"loans">>> {
  const today = todayUtc(now);

  const approved = await ctx.db
    .query("loans")
    .withIndex("by_status_start", (q) =>
      q.eq("status", "approved").lte("startDate", today),
    )
    .collect();

  const map = new Map<Id<"tools">, Doc<"loans">>();
  for (const loan of approved) map.set(loan.toolId, loan);
  return map;
}

/**
 * The earliest approved booking that starts after today, per tool.
 *
 * Availability answers "can I have it now"; this answers "when is it next taken".
 * Both are shown in the board, because a tool that is free today but booked for
 * the weekend the borrower has in mind is not useful information on its own.
 */
export async function futureLoansByToolId(
  ctx: Ctx,
  now = Date.now(),
): Promise<Map<Id<"tools">, Doc<"loans">>> {
  const today = todayUtc(now);

  const approved = await ctx.db
    .query("loans")
    .withIndex("by_status_start", (q) =>
      q.eq("status", "approved").gt("startDate", today),
    )
    .collect();

  const map = new Map<Id<"tools">, Doc<"loans">>();
  for (const loan of approved) {
    const current = map.get(loan.toolId);
    if (!current || loan.startDate < current.startDate) map.set(loan.toolId, loan);
  }
  return map;
}

/** Throws when an approved loan already covers any part of the range. */
export async function assertRangeIsFree(
  ctx: Ctx,
  toolId: Id<"tools">,
  startDate: number,
  endDate: number,
): Promise<void> {
  const approved = await ctx.db
    .query("loans")
    .withIndex("by_tool", (q) => q.eq("toolId", toolId).eq("status", "approved"))
    .collect();

  const conflict = approved.find((loan) =>
    rangesOverlap(startDate, endDate, loan.startDate, loan.endDate),
  );

  if (conflict) {
    throw new ConvexError(
      "Those dates overlap a loan that is already approved. Try a different range.",
    );
  }
}

/**
 * An approved loan that is past its return date and not yet marked returned.
 *
 * While one exists the tool is physically out, so new requests are refused rather
 * than queued against a date the lender cannot promise.
 */
export async function findOverdueLoan(
  ctx: Ctx,
  toolId: Id<"tools">,
  now = Date.now(),
): Promise<Doc<"loans"> | null> {
  const today = todayUtc(now);
  const approved = await ctx.db
    .query("loans")
    .withIndex("by_tool", (q) => q.eq("toolId", toolId).eq("status", "approved"))
    .collect();

  return approved.find((loan) => loan.endDate < today) ?? null;
}

/** An approved loan that is past its return date and not yet marked returned. */
export function isOverdue(loan: Doc<"loans">, now = Date.now()): boolean {
  return loan.status === "approved" && loan.endDate < todayUtc(now);
}
