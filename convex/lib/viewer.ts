import { ConvexError } from "convex/values";
import type { UserIdentity } from "convex/server";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Identity → `users` row provisioning, in one place so the lazy path in
 * `requireViewer` and the explicit `users.sync` cannot drift apart.
 *
 * The app used to depend on a client-triggered `users.sync` before any write was
 * legal. That left a window after sign-in where a valid Clerk token reached
 * Convex but no row existed yet, so the first mutation could fail with "You must
 * be signed in." Provisioning from the verified identity closes it: a write is
 * allowed as soon as the token is.
 */

/** Emails promoted to admin on first sign-in. Server-side env only. */
export function isBootstrapAdmin(email: string): boolean {
  const configured = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(email.trim().toLowerCase());
}

/** The profile fields a user is allowed to have, derived only from the JWT. */
export function fieldsFromIdentity(identity: UserIdentity) {
  const email = (identity.email ?? "").trim().toLowerCase();
  return {
    email,
    name: identity.name?.trim() || email.split("@")[0] || "Neighbor",
    imageUrl: identity.pictureUrl ?? undefined,
  };
}

export async function findViewer(
  ctx: QueryCtx | MutationCtx,
  identity: UserIdentity,
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.tokenIdentifier))
    .unique();
}

/**
 * Creates the caller's row. Called only from a mutation context.
 *
 * Two concurrent first writes both read no row and both insert. They write the
 * same `by_clerk_id` index key, so Convex's optimistic concurrency makes one
 * retry; the retry sees the other row and returns it instead of duplicating.
 */
export async function insertViewer(
  ctx: MutationCtx,
  identity: UserIdentity,
): Promise<Doc<"users">> {
  const fields = fieldsFromIdentity(identity);
  const id = await ctx.db.insert("users", {
    clerkId: identity.tokenIdentifier,
    ...fields,
    role: isBootstrapAdmin(fields.email) ? "admin" : "user",
    trustedLender: false,
    createdAt: Date.now(),
  });

  const row = await ctx.db.get(id);
  if (!row) {
    throw new ConvexError("Could not create your account. Try again.");
  }
  return row;
}
