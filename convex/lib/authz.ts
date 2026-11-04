import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { findViewer, insertViewer } from "./viewer";

/**
 * Authorization helpers.
 *
 * Every public function in this app resolves the caller through `getViewer` and
 * then asserts what it needs. The rules are enforced here — in Convex — not in
 * the UI. The UI only hides controls for convenience.
 *
 * Deliberate choices documented in the README:
 *  - Roles are read from the `users` table, the single source of truth. They are
 *    never accepted as a function argument, and never read from a client-supplied
 *    value, so a caller cannot claim to be an admin.
 *  - The caller is identified by `identity.tokenIdentifier`, which Convex derives
 *    from the verified Clerk JWT. A user id passed as an argument is only ever
 *    used as a *target* of an action, after the caller's own identity is proven.
 */

export type Viewer = Doc<"users">;
type Ctx = QueryCtx | MutationCtx;

export function forbidden(message = "You do not have permission to do that."): never {
  throw new ConvexError(message);
}

export function unauthenticated(): never {
  throw new ConvexError("You must be signed in.");
}

export function notFound(what = "Record"): never {
  throw new ConvexError(`${what} not found.`);
}

/** The signed-in user's row, or null when signed out / not yet synced. */
export async function getViewer(ctx: Ctx): Promise<Viewer | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  return await findViewer(ctx, identity);
}

/** Queries read; only mutations are allowed to create the row. */
function canWrite(ctx: Ctx): ctx is MutationCtx {
  return "insert" in ctx.db;
}

/**
 * The signed-in user's row.
 *
 * In a mutation, a missing row is created from the verified identity, so the
 * first write after sign-in cannot race the client's `users.sync`. In a query it
 * still throws: a query must not write, and every read path that tolerates a
 * missing row already handles `null` itself.
 */
export async function requireViewer(ctx: Ctx): Promise<Viewer> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) unauthenticated();

  const viewer = await findViewer(ctx, identity);
  if (viewer) return viewer;

  if (!canWrite(ctx)) unauthenticated();
  return await insertViewer(ctx, identity);
}

export async function requireAdmin(ctx: Ctx): Promise<Viewer> {
  const viewer = await requireViewer(ctx);
  if (viewer.role !== "admin") forbidden("Administrator access is required.");
  return viewer;
}

/** Guard for destructive self-actions, such as an admin demoting themselves. */
export function assertNotSelf(viewer: Viewer, userId: Id<"users">): void {
  if (viewer._id === userId) forbidden("You cannot change your own account.");
}

/**
 * A loan may be acted on by the two people it involves, or by an admin.
 * `role` narrows it further so the borrower cannot approve their own request.
 */
export function assertLoanParticipant(
  viewer: Viewer,
  loan: Doc<"loans">,
  role: "owner" | "borrower" | "any" = "any",
): void {
  if (viewer.role === "admin") return;

  const isOwner = viewer._id === loan.ownerId;
  const isBorrower = viewer._id === loan.borrowerId;

  if (role === "owner" && !isOwner) forbidden("Only the tool owner can do that.");
  if (role === "borrower" && !isBorrower) forbidden("Only the borrower can do that.");
  if (role === "any" && !isOwner && !isBorrower) forbidden("This request is not yours.");
}
