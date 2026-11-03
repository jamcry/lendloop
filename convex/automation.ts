import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { assertLoanParticipant, requireViewer } from "./lib/authz";
import { canonicalJson, signedHeaders } from "./lib/signing";
import { todayUtc } from "./lib/validation";

/**
 * n8n integration.
 *
 * Outbound: a loan mutation inserts a row into `automationJobs` in the same
 * transaction as the state change, then schedules `deliver`. This is a
 * transactional outbox — the state change and the intent to notify commit
 * together, so nothing is lost if the process dies, and nothing is duplicated if
 * Convex retries the transaction (a retry rolls back the earlier insert).
 *
 * Inbound: `convex/http.ts` exposes signed endpoints. See `docs/n8n-design.md`.
 */

/** Backoff ladder. Length is also the attempt limit. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 14_400_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;
const REQUEST_TIMEOUT_MS = 10_000;

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type LoanEventKind = "loan.requested" | "loan.status_changed";

/**
 * Queues a notification for a loan event.
 *
 * Called inside the loan mutation so the job and the state change share a
 * transaction. The payload is snapshotted here, which keeps the delivery action
 * from needing to re-read tables that may have changed by the time it runs.
 */
export async function enqueueLoanEvent(
  ctx: MutationCtx,
  loan: {
    _id: Id<"loans">;
    toolId: Id<"tools">;
    borrowerId: Id<"users">;
    ownerId: Id<"users">;
    status: string;
    startDate: number;
    endDate: number;
  },
  kind: LoanEventKind,
): Promise<void> {
  const [tool, borrower, owner] = await Promise.all([
    ctx.db.get(loan.toolId),
    ctx.db.get(loan.borrowerId),
    ctx.db.get(loan.ownerId),
  ]);

  const now = Date.now();

  // Only the person who needs to act is addressed. The lender hears about new
  // requests and cancellations; the borrower hears about decisions. The other
  // party's email is never included.
  const audience: "lender" | "borrower" =
    kind === "loan.requested" || loan.status === "cancelled" ? "lender" : "borrower";

  const recipient = audience === "lender" ? owner : borrower;
  const counterparty = audience === "lender" ? borrower : owner;

  const payload = {
    eventId: `${kind}:${loan._id}:${loan.status}:${now}`,
    kind,
    occurredAt: now,
    data: {
      loanId: loan._id,
      toolName: tool?.name ?? "a tool",
      toolCategory: tool?.category ?? "other",
      status: loan.status,
      startDate: loan.startDate,
      endDate: loan.endDate,
      audience,
      recipientName: recipient?.name ?? "A neighbor",
      recipientEmail: recipient?.email ?? null,
      counterpartyName: counterparty?.name ?? "A neighbor",
    },
  };

  const jobId = await ctx.db.insert("automationJobs", {
    eventKey: payload.eventId,
    kind,
    loanId: loan._id,
    payload,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.scheduler.runAfter(0, internal.automation.deliver, { jobId });
}

export const getJob = internalQuery({
  args: { jobId: v.id("automationJobs") },
  handler: async (ctx, { jobId }) => ctx.db.get(jobId),
});

export const markSent = internalMutation({
  args: { jobId: v.id("automationJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status === "sent") return;

    const now = Date.now();
    await ctx.db.patch(jobId, {
      status: "sent",
      attempts: job.attempts + 1,
      lastError: undefined,
      updatedAt: now,
    });

    await ctx.db.insert("loanActivity", {
      loanId: job.loanId,
      kind: "notification.sent",
      channel: "n8n",
      detail:
        job.kind === "loan.requested"
          ? "Request notification delivered"
          : "Status change delivered",
      dedupeKey: `job:${jobId}`,
      createdAt: now,
    });
  },
});

/**
 * Records a failed attempt. Schedules the next one with exponential backoff, and
 * after the last attempt marks the job failed *and* writes a visible activity
 * row — a failed notification must never disappear silently.
 */
export const scheduleRetry = internalMutation({
  args: { jobId: v.id("automationJobs"), error: v.string() },
  handler: async (ctx, { jobId, error }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status === "sent") return;

    const attempts = job.attempts + 1;
    const now = Date.now();

    if (attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(jobId, {
        status: "failed",
        attempts,
        lastError: error,
        updatedAt: now,
      });
      await ctx.db.insert("loanActivity", {
        loanId: job.loanId,
        kind: "notification.failed",
        channel: "n8n",
        detail: `Gave up after ${attempts} attempts: ${error}`.slice(0, 300),
        dedupeKey: `job:${jobId}:failed`,
        createdAt: now,
      });
      return;
    }

    const delay = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    await ctx.db.patch(jobId, {
      status: "pending",
      attempts,
      lastError: error,
      nextAttemptAt: now + delay,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(delay, internal.automation.deliver, { jobId });
  },
});

export const failJob = internalMutation({
  args: { jobId: v.id("automationJobs"), error: v.string() },
  handler: async (ctx, { jobId, error }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return;

    const now = Date.now();
    await ctx.db.patch(jobId, {
      status: "failed",
      lastError: error,
      updatedAt: now,
    });
    await ctx.db.insert("loanActivity", {
      loanId: job.loanId,
      kind: "notification.failed",
      channel: "n8n",
      detail: error.slice(0, 300),
      dedupeKey: `job:${jobId}:failed`,
      createdAt: now,
    });
  },
});

/**
 * Signs and POSTs one job to n8n.
 *
 * Runs as an action because mutations cannot perform network calls. Every failure
 * path reschedules rather than throwing, so a dead n8n never turns into a broken
 * user-facing mutation.
 */
export const deliver = internalAction({
  args: { jobId: v.id("automationJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runQuery(internal.automation.getJob, { jobId });
    if (!job || job.status === "sent") return;

    const secret = process.env.LENDLOOP_SHARED_SECRET;
    const url = process.env.N8N_WEBHOOK_URL;

    if (!secret || !url) {
      // Fail closed and loudly: an unconfigured integration is a deployment bug,
      // not something to retry forever.
      await ctx.runMutation(internal.automation.failJob, {
        jobId,
        error:
          "n8n is not configured: set LENDLOOP_SHARED_SECRET and N8N_WEBHOOK_URL on the deployment.",
      });
      return;
    }

    // Canonical form, so n8n can reproduce these exact bytes after parsing.
    const body = canonicalJson(job.payload);
    const headers = await signedHeaders(secret, body);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`n8n responded ${response.status}`);
      }

      await ctx.runMutation(internal.automation.markSent, { jobId });
    } catch (error) {
      await ctx.runMutation(internal.automation.scheduleRetry, {
        jobId,
        error: describeError(error),
      });
    }
  },
});

/**
 * Idempotent write-back from n8n.
 *
 * `dedupeKey` comes from the request's `Idempotency-Key` header. The lookup and
 * the insert run in one serializable mutation, so a retried delivery collapses
 * onto the original row instead of creating a second reminder.
 */
export const recordReminder = internalMutation({
  args: {
    loanId: v.id("loans"),
    idempotencyKey: v.string(),
    channel: v.string(),
    detail: v.string(),
  },
  handler: async (ctx, { loanId, idempotencyKey, channel, detail }) => {
    const existing = await ctx.db
      .query("loanActivity")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", idempotencyKey))
      .unique();

    if (existing) {
      // A key must describe one loan. Reusing it for another loan is a bug on the
      // caller's side, not a retry, and must not report success.
      if (existing.loanId !== loanId) return { duplicate: false, conflict: true };
      return { duplicate: true, activityId: existing._id };
    }

    const loan = await ctx.db.get(loanId);
    if (!loan) throw new ConvexError("Unknown loan.");

    const activityId = await ctx.db.insert("loanActivity", {
      loanId,
      kind: "reminder.sent",
      channel,
      detail: detail.slice(0, 300),
      dedupeKey: idempotencyKey,
      createdAt: Date.now(),
    });

    return { duplicate: false, activityId };
  },
});

/** Records a failed workflow run so it is visible in the app, not just n8n. */
export const recordWorkflowFailure = internalMutation({
  args: {
    idempotencyKey: v.string(),
    workflow: v.string(),
    detail: v.string(),
    loanId: v.optional(v.id("loans")),
  },
  handler: async (ctx, { idempotencyKey, workflow, detail, loanId }) => {
    const existing = await ctx.db
      .query("loanActivity")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", idempotencyKey))
      .unique();
    if (existing) return { duplicate: true };

    await ctx.db.insert("loanActivity", {
      loanId,
      kind: "workflow.failed",
      channel: workflow,
      detail: detail.slice(0, 300),
      dedupeKey: idempotencyKey,
      createdAt: Date.now(),
    });

    return { duplicate: false };
  },
});

/**
 * Loans that are approved, past their return date, and not yet returned.
 *
 * Only the fields a reminder needs — six. No lender email, no description, no
 * borrower history.
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
          borrowerName: borrower?.name ?? "A neighbor",
          dueDate: loan.endDate,
          daysOverdue: Math.round((today - loan.endDate) / 86_400_000),
        };
      }),
    );
  },
});

/** Activity for one loan, visible to its lender, borrower, and admins. */
export const activityForLoan = query({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const viewer = await requireViewer(ctx);
    const loan = await ctx.db.get(loanId);
    if (!loan) return [];

    assertLoanParticipant(viewer, loan);

    return await ctx.db
      .query("loanActivity")
      .withIndex("by_loan_created", (q) => q.eq("loanId", loanId))
      .order("desc")
      .take(20);
  },
});

/**
 * Everything the automation layer did recently, for the admin panel.
 * Failure rows are the point: a broken workflow must be discoverable in-app.
 */
export const recentActivity = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    if (viewer.role !== "admin") return [];

    return await ctx.db
      .query("loanActivity")
      .withIndex("by_created")
      .order("desc")
      .take(20);
  },
});
