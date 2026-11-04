import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

/**
 * Demo data so the public page is not empty on a fresh deployment.
 *
 *   npx convex run seed:populate
 *   npx convex run seed:populate '{"ownerEmail":"you@example.com"}'
 *
 * With `ownerEmail`, the tools are assigned to that account, so the seeded
 * listings are fully usable: you can approve and return requests against them.
 * Without it, they belong to a demo account that cannot sign in, which makes them
 * read-only in practice.
 *
 * Refuses to run unless SEED_ENABLED=true on the deployment, so it can never
 * quietly inject rows into a real environment.
 */

const DEMO_CLERK_ID = "seed|lendloop-demo";

const DEMO_TOOLS = [
  {
    name: "DeWalt cordless drill",
    category: "power-tools" as const,
    condition: "good" as const,
    description:
      "18V hammer drill with two batteries and a charger. Bits included. Good for shelves, curtain rails, and the occasional stubborn wall.",
  },
  {
    name: "Stihl hedge trimmer",
    category: "garden" as const,
    condition: "fair" as const,
    description:
      "Petrol trimmer, starts on the second pull. Heavy, so best for a full afternoon of hedges rather than a quick tidy.",
  },
  {
    name: "Stand mixer",
    category: "kitchen" as const,
    condition: "new" as const,
    description:
      "Bowl, whisk, and dough hook. Happy to lend it out for a weekend of baking — just please hand-wash the bowl.",
  },
  {
    name: "Two-person tent",
    category: "camping" as const,
    condition: "good" as const,
    description:
      "Three-season tent, sleeps two comfortably. Comes with a footprint and a repair patch kit.",
  },
  {
    name: "Pressure washer",
    category: "cleaning" as const,
    condition: "good" as const,
    description:
      "Karcher K4 with a patio attachment. Great for driveways and garden furniture. Bring your own hose.",
  },
  {
    name: "Trolley jack and stands",
    category: "automotive" as const,
    condition: "good" as const,
    description:
      "Two-tonne jack with a pair of axle stands. Please return it clean and tell me if anything felt off.",
  },
  {
    name: "Extension ladder",
    category: "other" as const,
    condition: "worn" as const,
    description:
      "Aluminium, extends to about five metres. It has done a lot of gutters. Test the locks before you climb.",
  },
  {
    name: "Cordless strimmer",
    category: "garden" as const,
    condition: "fair" as const,
    description:
      "Light and quiet, good for edges. One battery lasts about forty minutes of real work.",
  },
  {
    name: "Camping stove and kettle",
    category: "camping" as const,
    condition: "good" as const,
    description:
      "Two-burner gas stove with a kettle that fits. I keep a spare canister in the box.",
  },
  {
    name: "Tile cutter",
    category: "power-tools" as const,
    condition: "good" as const,
    description:
      "Manual wet tile cutter, good up to 600mm tiles. Lend it with the blade guard, obviously.",
  },
];

const DEMO_TOOL_NAMES = new Set(DEMO_TOOLS.map((tool) => tool.name));

function assertSeedingEnabled() {
  if (process.env.SEED_ENABLED !== "true") {
    throw new Error(
      "Seeding is disabled. Set it with: npx convex env set SEED_ENABLED true",
    );
  }
}

export const populate = internalMutation({
  args: { ownerEmail: v.optional(v.string()) },
  handler: async (ctx, { ownerEmail }) => {
    assertSeedingEnabled();

    const targetEmail = ownerEmail?.trim().toLowerCase();
    let ownerId: Id<"users">;

    if (targetEmail) {
      const owner = (await ctx.db.query("users").collect()).find(
        (user) => user.email === targetEmail,
      );
      if (!owner) {
        throw new Error(
          `No user with email ${targetEmail}. Sign in once with that address, then run the seed again.`,
        );
      }
      ownerId = owner._id;
    } else {
      const demo = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", DEMO_CLERK_ID))
        .unique();
      ownerId =
        demo?._id ??
        (await ctx.db.insert("users", {
          clerkId: DEMO_CLERK_ID,
          name: "LendLoop Demo",
          email: "demo@lendloop.local",
          role: "user",
          trustedLender: true,
          createdAt: Date.now(),
        }));
    }

    // Idempotent per owner, not globally: seeding under a real account after an
    // earlier demo-account seed should not duplicate the ten listings.
    const owned = await ctx.db
      .query("tools")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    if (owned.some((tool) => DEMO_TOOL_NAMES.has(tool.name))) {
      return { seeded: false, message: "Demo data already present for this owner." };
    }

    // Adopt an earlier seed made under the non-login demo account. Tools and
    // their loans are reassigned together, because `loans.ownerId` is denormalized
    // and the new owner must be able to approve or close those loans.
    const demo = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", DEMO_CLERK_ID))
      .unique();
    if (targetEmail && demo && demo._id !== ownerId) {
      const demoTools = await ctx.db
        .query("tools")
        .withIndex("by_owner", (q) => q.eq("ownerId", demo._id))
        .collect();

      if (demoTools.length > 0) {
        const now = Date.now();
        for (const tool of demoTools) {
          await ctx.db.patch(tool._id, { ownerId, updatedAt: now });
        }

        const demoLoans = await ctx.db
          .query("loans")
          .withIndex("by_owner", (q) => q.eq("ownerId", demo._id))
          .collect();
        for (const loan of demoLoans) {
          await ctx.db.patch(loan._id, { ownerId, updatedAt: now });
        }

        return {
          seeded: true,
          adopted: demoTools.length,
          owner: targetEmail,
        };
      }
    }

    const now = Date.now();
    for (const [index, tool] of DEMO_TOOLS.entries()) {
      await ctx.db.insert("tools", {
        ownerId,
        ...tool,
        // Slight stagger so the list has a stable, non-random order.
        createdAt: now - index * 60_000,
        updatedAt: now - index * 60_000,
      });
    }

    return {
      seeded: true,
      tools: DEMO_TOOLS.length,
      owner: targetEmail ?? "LendLoop Demo",
    };
  },
});

const DEMO_BORROWER_CLERK_ID = "seed|lendloop-borrower";

/**
 * Creates one approved loan that is already overdue, so the daily reminder
 * workflow has something real to find on a fresh deployment.
 *
 *   npx convex run seed:createDemoOverdueLoan
 *
 * Same SEED_ENABLED guard as `populate`; never runs on a real environment.
 */
export const createDemoOverdueLoan = internalMutation({
  args: {},
  handler: async (ctx) => {
    assertSeedingEnabled();

    const existingBorrower = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", DEMO_BORROWER_CLERK_ID))
      .unique();

    const now = Date.now();
    const day = 86_400_000;
    const today = Math.floor(now / day) * day;

    const borrowerId =
      existingBorrower?._id ??
      (await ctx.db.insert("users", {
        clerkId: DEMO_BORROWER_CLERK_ID,
        name: "Demo Borrower",
        email: "borrower@lendloop.local",
        role: "user",
        trustedLender: false,
        createdAt: now,
      }));

    // One overdue loan is enough for the reminder workflow; re-running this should
    // not add another row every time.
    const existingOverdue = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) =>
        q.eq("borrowerId", borrowerId).eq("status", "approved"),
      )
      .collect();
    const overdue = existingOverdue.find((loan) => loan.endDate < today);
    if (overdue) {
      const tool = await ctx.db.get(overdue.toolId);
      return {
        created: false,
        loanId: overdue._id,
        toolName: tool?.name ?? "a tool",
      };
    }

    const tool = await ctx.db
      .query("tools")
      .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
      .first();

    if (!tool) {
      throw new Error("Run seed:populate first so there is a tool to borrow.");
    }

    const loanId = await ctx.db.insert("loans", {
      toolId: tool._id,
      ownerId: tool.ownerId,
      borrowerId,
      startDate: today - 5 * day,
      endDate: today - 2 * day,
      status: "approved",
      message: "Seeded demo loan, already overdue.",
      decidedAt: now - 6 * day,
      createdAt: now - 6 * day,
      updatedAt: now - 6 * day,
    });

    return { created: true, loanId, toolName: tool.name };
  },
});
