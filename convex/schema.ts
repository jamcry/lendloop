import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Shared enums live here so validators, UI labels, and tests all read from the
 * same place. Anything added here must also be added to the label maps in
 * `lib/labels.ts`.
 */
export const TOOL_CATEGORIES = [
  "power-tools",
  "garden",
  "kitchen",
  "camping",
  "cleaning",
  "automotive",
  "other",
] as const;

export const TOOL_CONDITIONS = ["new", "good", "fair", "worn"] as const;

export const LOAN_STATUSES = [
  "pending",
  "approved",
  "declined",
  "cancelled",
  "returned",
] as const;

export const USER_ROLES = ["user", "admin"] as const;

export const toolCategoryValidator = v.union(
  ...TOOL_CATEGORIES.map((category) => v.literal(category)),
);

export const toolConditionValidator = v.union(
  ...TOOL_CONDITIONS.map((condition) => v.literal(condition)),
);

export const loanStatusValidator = v.union(
  ...LOAN_STATUSES.map((status) => v.literal(status)),
);

export const userRoleValidator = v.union(...USER_ROLES.map((role) => v.literal(role)));

export default defineSchema({
  /**
   * One row per Clerk user. `role` is the authoritative permission source and is
   * only ever written server-side (admin promotion, or the ADMIN_EMAILS
   * bootstrap). It is never accepted as a client argument.
   */
  users: defineTable({
    clerkId: v.string(),
    name: v.string(),
    email: v.string(),
    imageUrl: v.optional(v.string()),
    role: userRoleValidator,
    trustedLender: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"])
    .index("by_role", ["role"]),

  /**
   * A tool someone is willing to lend. Soft-deleted via `archivedAt` so loan
   * history and audit records keep pointing at something real.
   */
  tools: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    category: toolCategoryValidator,
    condition: toolConditionValidator,
    description: v.string(),
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_category", ["category"])
    .index("by_archived", ["archivedAt"]),

  /**
   * A borrow request and, once approved, the loan itself. `ownerId` is
   * denormalized from the tool so "incoming requests" is a single indexed read
   * and authorization checks never need a second table lookup.
   */
  loans: defineTable({
    toolId: v.id("tools"),
    ownerId: v.id("users"),
    borrowerId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
    status: loanStatusValidator,
    message: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    returnedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tool", ["toolId", "status"])
    .index("by_owner", ["ownerId", "status"])
    .index("by_borrower", ["borrowerId", "status"])
    .index("by_status_end", ["status", "endDate"]),

  /**
   * Admin-only trail for privileged actions (listing removal, role and
   * trusted-lender changes). Rendered in the admin panel.
   */
  auditEvents: defineTable({
    actorId: v.id("users"),
    action: v.union(
      v.literal("tool.archived"),
      v.literal("loan.reviewed"),
      v.literal("user.trusted_lender_granted"),
      v.literal("user.trusted_lender_revoked"),
      v.literal("user.role_changed"),
    ),
    targetType: v.union(v.literal("tool"), v.literal("loan"), v.literal("user")),
    targetId: v.string(),
    summary: v.string(),
    createdAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_target", ["targetType", "targetId"]),

  /**
   * Transactional outbox for the n8n integration.
   *
   * A loan mutation writes its state change and the intent to notify in one
   * transaction, then schedules `automation.deliver`. A crash between the two
   * cannot lose a notification, and a retried mutation cannot produce a second
   * one, because the job is keyed to a specific loan event.
   */
  automationJobs: defineTable({
    eventKey: v.string(),
    kind: v.union(v.literal("loan.requested"), v.literal("loan.status_changed")),
    loanId: v.id("loans"),
    payload: v.any(),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_next", ["status", "nextAttemptAt"])
    .index("by_event_key", ["eventKey"])
    .index("by_loan", ["loanId"]),

  /**
   * What the automation layer actually did, shown in the app.
   *
   * `dedupeKey` is the idempotency key from n8n write-backs. The check and the
   * insert happen in one mutation, so a retried write-back collapses instead of
   * creating a second "reminder sent" row.
   */
  loanActivity: defineTable({
    // Optional because a workflow failure may not belong to any specific loan
    // (a schedule run that never reached the loan stage, for example).
    loanId: v.optional(v.id("loans")),
    kind: v.union(
      v.literal("notification.sent"),
      v.literal("notification.failed"),
      v.literal("reminder.sent"),
      v.literal("workflow.failed"),
    ),
    channel: v.string(),
    detail: v.string(),
    dedupeKey: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_loan_created", ["loanId", "createdAt"])
    .index("by_created", ["createdAt"])
    .index("by_dedupe", ["dedupeKey"]),
});
