import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { forbidden, getViewer, notFound, requireViewer } from "./lib/authz";
import { lentToolsByToolId } from "./lib/loans";
import { cleanText, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from "./lib/validation";
import { toolCategoryValidator, toolConditionValidator } from "./schema";

function toToolFields(
  tool: Doc<"tools">,
  lent: Map<string, Doc<"loans">>,
  viewerId: Doc<"users">["_id"],
) {
  const activeLoan = lent.get(tool._id);
  return {
    id: tool._id,
    name: tool.name,
    category: tool.category,
    condition: tool.condition,
    description: tool.description,
    isMine: tool.ownerId === viewerId,
    availability: activeLoan
      ? { state: "lent" as const, until: activeLoan.endDate }
      : { state: "available" as const, until: null },
    createdAt: tool.createdAt,
  };
}

/**
 * Public, unauthenticated listing.
 *
 * Deliberately minimal: name and category only. No owner id, no condition, no
 * description — none of which a signed-out visitor needs in order to decide to
 * sign in.
 */
export const listPublic = query({
  args: {},
  handler: async (ctx) => {
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
      .collect();

    // "Available" means actually available: a tool that is out on loan is not.
    const lent = await lentToolsByToolId(ctx);

    return tools
      .filter((tool) => !lent.has(tool._id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((tool) => ({ name: tool.name, category: tool.category }));
  },
});

/** Signed-in browse list with availability. */
export const browse = query({
  args: { category: v.optional(toolCategoryValidator) },
  handler: async (ctx, { category }) => {
    // Tolerate a viewer that has not synced yet: the query reads the users table,
    // so Convex re-runs it as soon as the row appears. Throwing here would show an
    // error page in the window between sign-in and the first sync.
    const viewer = await getViewer(ctx);
    if (!viewer) return [];

    const lent = await lentToolsByToolId(ctx);

    const tools = category
      ? await ctx.db
          .query("tools")
          .withIndex("by_category", (q) => q.eq("category", category))
          .collect()
      : await ctx.db
          .query("tools")
          .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
          .collect();

    const visible = tools.filter((tool) => tool.archivedAt === undefined);

    const owners = new Map<string, { name: string; trustedLender: boolean }>();
    for (const tool of visible) {
      if (!owners.has(tool.ownerId)) {
        const owner = await ctx.db.get(tool.ownerId);
        owners.set(tool.ownerId, {
          name: owner?.name ?? "Neighbor",
          trustedLender: owner?.trustedLender ?? false,
        });
      }
    }

    return visible
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => {
        const owner = owners.get(tool.ownerId);
        return {
          ...toToolFields(tool, lent, viewer._id),
          ownerName: owner?.name ?? "Neighbor",
          ownerTrustedLender: owner?.trustedLender ?? false,
        };
      });
  },
});

/** One tool, with the caller's own pending request if there is one. */
export const get = query({
  args: { id: v.id("tools") },
  handler: async (ctx, { id }) => {
    const viewer = await getViewer(ctx);
    if (!viewer) return null;

    const tool = await ctx.db.get(id);
    // Returning null (rather than throwing) lets the page render its "does not
    // exist" state instead of a Next.js error boundary.
    if (!tool) return null;

    const lent = await lentToolsByToolId(ctx);
    const owner = await ctx.db.get(tool.ownerId);

    const myPending = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) =>
        q.eq("borrowerId", viewer._id).eq("status", "pending"),
      )
      .collect();

    const mine = myPending.find((loan) => loan.toolId === tool._id);
    const approved = await ctx.db
      .query("loans")
      .withIndex("by_tool", (q) => q.eq("toolId", tool._id).eq("status", "approved"))
      .collect();

    return {
      ...toToolFields(tool, lent, viewer._id),
      ownerName: owner?.name ?? "Neighbor",
      ownerTrustedLender: owner?.trustedLender ?? false,
      archivedAt: tool.archivedAt ?? null,
      myPendingRequest: mine
        ? { id: mine._id, startDate: mine.startDate, endDate: mine.endDate }
        : null,
      upcomingLoans: approved
        .filter((loan) => loan.endDate >= Date.now())
        .sort((a, b) => a.startDate - b.startDate)
        .map((loan) => ({ startDate: loan.startDate, endDate: loan.endDate })),
    };
  },
});

/** The caller's own listings, archived ones included but flagged. */
export const myListings = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getViewer(ctx);
    if (!viewer) return [];

    const lent = await lentToolsByToolId(ctx);

    const tools = await ctx.db
      .query("tools")
      .withIndex("by_owner", (q) => q.eq("ownerId", viewer._id))
      .collect();

    return tools
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((tool) => ({
        ...toToolFields(tool, lent, viewer._id),
        archivedAt: tool.archivedAt ?? null,
      }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    category: toolCategoryValidator,
    condition: toolConditionValidator,
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const now = Date.now();

    return await ctx.db.insert("tools", {
      ownerId: viewer._id,
      name: cleanText(args.name, { field: "Name", max: MAX_NAME_LENGTH }),
      category: args.category,
      condition: args.condition,
      description: cleanText(args.description, {
        field: "Description",
        max: MAX_DESCRIPTION_LENGTH,
      }),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("tools"),
    name: v.string(),
    category: toolCategoryValidator,
    condition: toolConditionValidator,
    description: v.string(),
  },
  handler: async (ctx, { id, ...fields }) => {
    const viewer = await requireViewer(ctx);
    const tool = await ctx.db.get(id);
    if (!tool) notFound("Tool");
    if (tool.archivedAt !== undefined) forbidden("This listing was removed.");
    if (tool.ownerId !== viewer._id) forbidden("You can only edit your own listings.");

    await ctx.db.patch(id, {
      name: cleanText(fields.name, { field: "Name", max: MAX_NAME_LENGTH }),
      category: fields.category,
      condition: fields.condition,
      description: cleanText(fields.description, {
        field: "Description",
        max: MAX_DESCRIPTION_LENGTH,
      }),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Soft delete. The row stays so past loans and audit events still resolve to a
 * real listing instead of a dangling reference.
 */
export const archive = mutation({
  args: { id: v.id("tools") },
  handler: async (ctx, { id }) => {
    // A mutation, not a query: refuse outright rather than silently doing
    // nothing, which would let the UI report a success that never happened.
    const viewer = await requireViewer(ctx);

    const tool = await ctx.db.get(id);
    if (!tool) notFound("Tool");
    // Admins remove listings through `admin.archiveTool`, which writes an audit
    // event. Allowing this path too would create an unaudited way to do the same
    // thing.
    if (tool.ownerId !== viewer._id) forbidden("You can only remove your own listings.");
    if (tool.archivedAt !== undefined) return;

    await ctx.db.patch(id, { archivedAt: Date.now(), updatedAt: Date.now() });
  },
});
