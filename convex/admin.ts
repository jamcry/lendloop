import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { assertNotSelf, notFound, requireAdmin } from "./lib/authz";
import { describeLoan } from "./loans";
import { userRoleValidator } from "./schema";

/**
 * Administrator surface.
 *
 * Every function here starts with `requireAdmin`, which re-reads the caller's
 * role from the database. Nothing trusts a client claim. All privileged writes
 * are recorded in `auditEvents` so the admin panel can show who did what.
 */

async function recordAudit(
  ctx: MutationCtx,
  event: {
    actorId: Id<"users">;
    action:
      | "tool.archived"
      | "loan.reviewed"
      | "user.trusted_lender_granted"
      | "user.trusted_lender_revoked"
      | "user.role_changed";
    targetType: "tool" | "loan" | "user";
    targetId: string;
    summary: string;
  },
) {
  await ctx.db.insert("auditEvents", { ...event, createdAt: Date.now() });
}

/** Removes any listing, regardless of owner. */
export const archiveTool = mutation({
  args: { toolId: v.id("tools") },
  handler: async (ctx, { toolId }) => {
    const admin = await requireAdmin(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool) notFound("Tool");
    if (tool.archivedAt !== undefined) return;

    await ctx.db.patch(toolId, { archivedAt: Date.now(), updatedAt: Date.now() });
    await recordAudit(ctx, {
      actorId: admin._id,
      action: "tool.archived",
      targetType: "tool",
      targetId: toolId,
      summary: `Removed listing "${tool.name}".`,
    });
  },
});

export const setTrustedLender = mutation({
  args: { userId: v.id("users"), trusted: v.boolean() },
  handler: async (ctx, { userId, trusted }) => {
    const admin = await requireAdmin(ctx);
    const user = await ctx.db.get(userId);
    if (!user) notFound("User");
    if (user.trustedLender === trusted) return;

    await ctx.db.patch(userId, { trustedLender: trusted });
    await recordAudit(ctx, {
      actorId: admin._id,
      action: trusted ? "user.trusted_lender_granted" : "user.trusted_lender_revoked",
      targetType: "user",
      targetId: userId,
      summary: `${trusted ? "Granted" : "Revoked"} trusted lender status for ${user.name}.`,
    });
  },
});

/** Changes a role. Admins cannot change their own, which prevents lockout. */
export const setRole = mutation({
  args: { userId: v.id("users"), role: userRoleValidator },
  handler: async (ctx, { userId, role }) => {
    const admin = await requireAdmin(ctx);
    assertNotSelf(admin, userId);

    const user = await ctx.db.get(userId);
    if (!user) notFound("User");
    if (user.role === role) return;

    await ctx.db.patch(userId, { role });
    await recordAudit(ctx, {
      actorId: admin._id,
      action: "user.role_changed",
      targetType: "user",
      targetId: userId,
      summary: `Set ${user.name}'s role to ${role}.`,
    });
  },
});

export const allLoans = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const loans = await ctx.db.query("loans").collect();
    const described = await Promise.all(loans.map((loan) => describeLoan(ctx, loan)));
    return described.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const allTools = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const tools = await ctx.db.query("tools").collect();
    const owners = new Map<string, string>();

    for (const tool of tools) {
      if (!owners.has(tool.ownerId)) {
        const owner = await ctx.db.get(tool.ownerId);
        owners.set(tool.ownerId, owner?.name ?? "Neighbor");
      }
    }

    return tools
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((tool) => ({
        id: tool._id,
        name: tool.name,
        category: tool.category,
        condition: tool.condition,
        ownerName: owners.get(tool.ownerId) ?? "Neighbor",
        archivedAt: tool.archivedAt ?? null,
      }));
  },
});

export const allUsers = query({
  args: {},
  handler: async (ctx) => {
    const admin = await requireAdmin(ctx);
    const users = await ctx.db.query("users").collect();

    return users
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((user) => ({
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        trustedLender: user.trustedLender,
        isSelf: user._id === admin._id,
      }));
  },
});

export const auditLog = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const events = await ctx.db
      .query("auditEvents")
      .withIndex("by_created")
      .order("desc")
      .take(50);

    const actors = new Map<string, string>();
    for (const event of events) {
      if (!actors.has(event.actorId)) {
        const actor = await ctx.db.get(event.actorId);
        actors.set(event.actorId, actor?.name ?? "Neighbor");
      }
    }

    return events.map((event) => ({
      id: event._id,
      action: event.action,
      summary: event.summary,
      actorName: actors.get(event.actorId) ?? "Neighbor",
      createdAt: event.createdAt,
    }));
  },
});

/** Counts for the admin header. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [tools, loans, users] = await Promise.all([
      ctx.db.query("tools").collect(),
      ctx.db.query("loans").collect(),
      ctx.db.query("users").collect(),
    ]);

    return {
      listings: tools.filter((tool) => tool.archivedAt === undefined).length,
      archived: tools.filter((tool) => tool.archivedAt !== undefined).length,
      pendingRequests: loans.filter((loan) => loan.status === "pending").length,
      activeLoans: loans.filter((loan) => loan.status === "approved").length,
      users: users.length,
      trustedLenders: users.filter((user) => user.trustedLender).length,
    };
  },
});
