import { internalQuery } from "./_generated/server";
import { todayUtc } from "./lib/validation";

/**
 * n8n integration — design only, not implemented.
 *
 * The scope for this take-home stops at the application. These are the exact
 * integration points, left as stubs on purpose so the wiring is not half-built.
 * The full design (payload shapes, HMAC scheme, retries, idempotency) is in
 * `docs/n8n-design.md`.
 *
 * TODO(n8n): on every loan create/status change, insert an outbox row in the
 *            same transaction as the state change, then `ctx.scheduler.runAfter`
 *            an action that signs and POSTs to the n8n webhook.
 * TODO(n8n): expose `overdueLoans` over HTTP for the scheduled workflow, with an
 *            HMAC header check over `timestamp + "." + body`.
 * TODO(n8n): accept an idempotent reminder write-back keyed by
 *            `Idempotency-Key`, recording to a `loanActivity` table.
 * TODO(n8n): render that activity on the loan detail page ("Reminder sent 2
 *            days ago", bonus requirement).
 *
 * Nothing here sends anything today, so no secret handling is required yet.
 */

/**
 * Loans that are approved, past their return date, and not yet returned.
 *
 * Implemented because it is pure data selection and is what the scheduled n8n
 * workflow will consume. It returns only the fields a notification needs — no
 * lender email, no description, no borrower history.
 */
export const overdueLoans = internalQuery({
  args: {},
  handler: async (ctx) => {
    const today = todayUtc();

    const approved = await ctx.db
      .query("loans")
      .withIndex("by_status_end", (q) => q.eq("status", "approved").lt("endDate", today))
      .collect();

    return await Promise.all(
      approved.map(async (loan) => {
        const tool = await ctx.db.get(loan.toolId);
        const borrower = await ctx.db.get(loan.borrowerId);

        return {
          loanId: loan._id,
          toolName: tool?.name ?? "a tool",
          borrowerEmail: borrower?.email ?? null,
          dueDate: loan.endDate,
          daysOverdue: Math.round((today - loan.endDate) / 86_400_000),
        };
      }),
    );
  },
});
