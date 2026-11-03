import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import {
  assertLoanParticipant,
  forbidden,
  notFound,
  requireViewer,
  type Viewer,
} from "./lib/authz";
import { enqueueLoanEvent } from "./automation";
import { assertRangeIsFree, isOverdue } from "./lib/loans";
import {
  assertLoanRange,
  cleanText,
  MAX_MESSAGE_LENGTH,
  startOfUtcDay,
  todayUtc,
} from "./lib/validation";

/**
 * Loan lifecycle:
 *
 *   pending ──approve──> approved ──return──> returned
 *      │                    │
 *      ├──decline──> declined
 *      └──cancel───> cancelled
 *
 * Transitions are only reachable from the status they expect, so a replayed or
 * out-of-order request fails instead of corrupting state.
 */

/** Tool, owner, and borrower names for rendering a loan outside a tool page. */
export async function describeLoan(ctx: QueryCtx | MutationCtx, loan: Doc<"loans">) {
  const tool = await ctx.db.get(loan.toolId);
  const owner = await ctx.db.get(loan.ownerId);
  const borrower = await ctx.db.get(loan.borrowerId);

  return {
    id: loan._id,
    toolId: loan.toolId,
    toolName: tool?.name ?? "Removed tool",
    toolCategory: tool?.category ?? "other",
    ownerName: owner?.name ?? "Neighbor",
    ownerTrustedLender: owner?.trustedLender ?? false,
    borrowerName: borrower?.name ?? "Neighbor",
    startDate: loan.startDate,
    endDate: loan.endDate,
    status: loan.status,
    message: loan.message ?? null,
    overdue: isOverdue(loan),
    createdAt: loan.createdAt,
    decidedAt: loan.decidedAt ?? null,
    returnedAt: loan.returnedAt ?? null,
  };
}

export const request = mutation({
  args: {
    toolId: v.id("tools"),
    startDate: v.number(),
    endDate: v.number(),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);

    const tool = await ctx.db.get(args.toolId);
    if (!tool) notFound("Tool");
    if (tool.archivedAt !== undefined) forbidden("This listing is no longer available.");
    if (tool.ownerId === viewer._id) forbidden("You cannot borrow your own tool.");

    assertLoanRange(args.startDate, args.endDate);

    // Normalize before storing. Validation compares UTC day boundaries, so if the
    // raw timestamp were persisted, a caller hitting the mutation directly could
    // store a mid-day range that `rangesOverlap` misjudges as non-overlapping and
    // that `lentToolsByToolId` never counts as lent.
    const startDate = startOfUtcDay(args.startDate);
    const endDate = startOfUtcDay(args.endDate);

    await assertRangeIsFree(ctx, tool._id, startDate, endDate);

    const existingPending = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) =>
        q.eq("borrowerId", viewer._id).eq("status", "pending"),
      )
      .collect();

    const duplicate = existingPending.find(
      (loan) =>
        loan.toolId === tool._id &&
        loan.startDate === startDate &&
        loan.endDate === endDate,
    );
    if (duplicate) {
      throw new ConvexError("You already have a pending request for those dates.");
    }

    const now = Date.now();
    const loanId = await ctx.db.insert("loans", {
      toolId: tool._id,
      ownerId: tool.ownerId,
      borrowerId: viewer._id,
      startDate,
      endDate,
      status: "pending",
      message: args.message
        ? cleanText(args.message, {
            field: "Message",
            max: MAX_MESSAGE_LENGTH,
            required: false,
          }) || undefined
        : undefined,
      createdAt: now,
      updatedAt: now,
    });

    // Same transaction as the insert: the notification cannot be lost or doubled.
    await enqueueLoanEvent(
      ctx,
      {
        _id: loanId,
        toolId: tool._id,
        borrowerId: viewer._id,
        ownerId: tool.ownerId,
        status: "pending",
        startDate,
        endDate,
      },
      "loan.requested",
    );

    return loanId;
  },
});

/**
 * Approve or decline. Only the lender may decide — admins can see every loan but
 * not act on one, because the decision belongs to the person risking their tool.
 */
export const decide = mutation({
  args: {
    loanId: v.id("loans"),
    decision: v.union(v.literal("approved"), v.literal("declined")),
  },
  handler: async (ctx, { loanId, decision }) => {
    const viewer = await requireViewer(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan) notFound("Loan");

    if (loan.ownerId !== viewer._id)
      forbidden("Only the lender can decide on a request.");
    if (loan.status !== "pending") {
      throw new ConvexError(`This request was already ${loan.status}.`);
    }

    if (decision === "approved") {
      // A listing can be removed while a request is still pending. Approving it
      // would reserve a tool the board no longer shows. Declining must stay
      // possible, otherwise the request is stuck forever.
      const tool = await ctx.db.get(loan.toolId);
      if (tool?.archivedAt !== undefined) {
        throw new ConvexError(
          "This listing was removed, so the request cannot be approved.",
        );
      }

      // Approving a window that has already passed would create a loan that is
      // overdue the moment it starts.
      if (loan.endDate < todayUtc()) {
        throw new ConvexError("That borrowing window has already passed.");
      }

      // Re-check at approval time: another request may have been approved while
      // this one sat in the queue.
      await assertRangeIsFree(ctx, loan.toolId, loan.startDate, loan.endDate);
    }

    await ctx.db.patch(loanId, {
      status: decision,
      decidedAt: Date.now(),
      updatedAt: Date.now(),
    });

    await enqueueLoanEvent(ctx, { ...loan, status: decision }, "loan.status_changed");
  },
});

/** The borrower withdraws a request that has not been decided yet. */
export const cancel = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const viewer = await requireViewer(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan) notFound("Loan");

    if (loan.borrowerId !== viewer._id)
      forbidden("Only the borrower can cancel this request.");
    if (loan.status !== "pending") {
      throw new ConvexError("Only pending requests can be cancelled.");
    }

    await ctx.db.patch(loanId, {
      status: "cancelled",
      updatedAt: Date.now(),
    });

    await enqueueLoanEvent(ctx, { ...loan, status: "cancelled" }, "loan.status_changed");
  },
});

/** The lender confirms the tool came back. */
export const markReturned = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const viewer = await requireViewer(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan) notFound("Loan");

    if (loan.ownerId !== viewer._id)
      forbidden("Only the lender can mark a loan returned.");
    if (loan.status !== "approved") {
      throw new ConvexError("Only approved loans can be marked returned.");
    }

    await ctx.db.patch(loanId, {
      status: "returned",
      returnedAt: Date.now(),
      updatedAt: Date.now(),
    });

    await enqueueLoanEvent(ctx, { ...loan, status: "returned" }, "loan.status_changed");
  },
});

/** Requests the caller has made. */
export const myRequests = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", viewer._id))
      .collect();

    const described = await Promise.all(loans.map((loan) => describeLoan(ctx, loan)));
    return described.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Requests against the caller's tools. */
export const incoming = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_owner", (q) => q.eq("ownerId", viewer._id))
      .collect();

    const described = await Promise.all(loans.map((loan) => describeLoan(ctx, loan)));
    return described.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** A single loan: visible to the lender, the borrower, and admins. */
export const get = query({
  args: { id: v.id("loans") },
  handler: async (ctx, { id }) => {
    const viewer: Viewer = await requireViewer(ctx);
    const loan = await ctx.db.get(id);
    // No distinct "not found" error: otherwise the difference between a missing
    // loan and someone else's loan tells a caller which ids exist.
    if (!loan) return null;

    assertLoanParticipant(viewer, loan);
    return await describeLoan(ctx, loan);
  },
});

/** Convenience for the tool detail page: the caller's own loan on a tool. */
export const forTool = query({
  args: { toolId: v.id("tools") },
  handler: async (ctx, { toolId }) => {
    const viewer = await requireViewer(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", viewer._id))
      .collect();

    const active = loans
      .filter((loan) => loan.toolId === toolId && loan.status !== "cancelled")
      .sort((a, b) => b.createdAt - a.createdAt);

    return active.length ? await describeLoan(ctx, active[0]) : null;
  },
});

export type LoanId = Id<"loans">;
