import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { getViewer, unauthenticated } from "./lib/authz";

/** Emails promoted to admin on first sign-in. Server-side env only. */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isBootstrapAdmin(email: string): boolean {
  return adminEmails().includes(email.trim().toLowerCase());
}

/** Public shape sent to the client. Never includes anything vault-like. */
export function toPublicUser(user: Doc<"users">) {
  return {
    id: user._id,
    name: user.name,
    imageUrl: user.imageUrl ?? null,
    role: user.role,
    trustedLender: user.trustedLender,
  };
}

/**
 * Creates or refreshes the caller's row from their verified Clerk identity.
 *
 * Called once per session by `<UserSync />`. Identity fields come from the JWT,
 * never from arguments, so a client cannot set its own email, name, or role.
 * `role` is seeded from ADMIN_EMAILS on creation only — later changes go through
 * the admin panel, which writes an audit event.
 */
export const sync = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) unauthenticated();

    const email = (identity.email ?? "").trim().toLowerCase();
    const name = identity.name?.trim() || email.split("@")[0] || "Neighbor";
    const imageUrl = identity.pictureUrl ?? undefined;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.tokenIdentifier))
      .unique();

    if (existing) {
      // Keep the profile fresh without clobbering role or trusted status.
      if (existing.name !== name || existing.email !== email || existing.imageUrl !== imageUrl) {
        await ctx.db.patch(existing._id, { name, email, imageUrl });
      }
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clerkId: identity.tokenIdentifier,
      name,
      email,
      imageUrl,
      role: isBootstrapAdmin(email) ? "admin" : "user",
      trustedLender: false,
      createdAt: Date.now(),
    });
  },
});

/** The signed-in user, or null. Used to gate admin-only navigation. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getViewer(ctx);
    return viewer ? toPublicUser(viewer) : null;
  },
});

/** Directory of lenders, so a tool page can show who owns it. */
export const publicProfile = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return { name: user.name, trustedLender: user.trustedLender };
  },
});
