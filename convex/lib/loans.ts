import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { rangesOverlap, todayUtc } from "./validation";

type Ctx = QueryCtx | MutationCtx;

/**
 * Loans that currently block a tool.
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
    .withIndex("by_status_end", (q) => q.eq("status", "approved").gte("endDate", today))
    .collect();

  const map = new Map<Id<"tools">, Doc<"loans">>();
  for (const loan of approved) {
    if (loan.startDate <= today) map.set(loan.toolId, loan);
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

/** An approved loan that is past its return date and not yet marked returned. */
export function isOverdue(loan: Doc<"loans">, now = Date.now()): boolean {
  return loan.status === "approved" && loan.endDate < todayUtc(now);
}
