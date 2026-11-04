import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { getViewer, unauthenticated } from "./lib/authz";
import {
  fieldsFromIdentity,
  findViewer,
  insertViewer,
  isBootstrapAdmin,
} from "./lib/viewer";

/** Re-exported for tests and callers that only need the bootstrap predicate. */
export { isBootstrapAdmin };

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
 * Called once per session by `<UserSync />`, but it is no longer load-bearing:
 * `requireViewer` provisions a missing row inside a mutation, so the first write
 * is legal even if this has not run yet. Keeping it means profile changes and
 * ADMIN_EMAILS promotions are picked up without waiting for a write.
 *
 * Identity fields come from the JWT, never from arguments, so a client cannot set
 * its own email, name, or role. `role` is seeded from ADMIN_EMAILS on creation and
 * re-applied on every sync for listed addresses; unlisted users are managed from
 * the admin panel, which writes an audit event.
 */
export const sync = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) unauthenticated();

    const fields = fieldsFromIdentity(identity);
    const existing = await findViewer(ctx, identity);

    if (existing) {
      // Keep the profile fresh without clobbering role or trusted status.
      const profileDrift =
        existing.name !== fields.name ||
        existing.email !== fields.email ||
        existing.imageUrl !== fields.imageUrl;

      // ADMIN_EMAILS is authoritative for bootstrap admins: adding an address to
      // the deployment env promotes an existing account on the next sync. It only
      // ever promotes — a demoted bootstrap admin is re-promoted here, so the two
      // steps (remove from env, then demote) are both required.
      const needsPromotion = isBootstrapAdmin(fields.email) && existing.role !== "admin";

      if (profileDrift || needsPromotion) {
        await ctx.db.patch(existing._id, {
          ...fields,
          role: needsPromotion ? "admin" : existing.role,
        });
      }
      return existing._id;
    }

    const created = await insertViewer(ctx, identity);
    return created._id;
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
