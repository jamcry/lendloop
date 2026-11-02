import { internalMutation } from "./_generated/server";

/**
 * Demo data so the public page is not empty on a fresh deployment.
 *
 *   npx convex run seed:populate
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

export const populate = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (process.env.SEED_ENABLED !== "true") {
      throw new Error(
        "Seeding is disabled. Set it with: npx convex env set SEED_ENABLED true",
      );
    }

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", DEMO_CLERK_ID))
      .unique();

    if (existing) {
      return { seeded: false, message: "Demo data already present." };
    }

    const now = Date.now();
    const ownerId = await ctx.db.insert("users", {
      clerkId: DEMO_CLERK_ID,
      name: "LendLoop Demo",
      email: "demo@lendloop.local",
      role: "user",
      trustedLender: true,
      createdAt: now,
    });

    for (const [index, tool] of DEMO_TOOLS.entries()) {
      await ctx.db.insert("tools", {
        ownerId,
        ...tool,
        // Slight stagger so the list has a stable, non-random order.
        createdAt: now - index * 60_000,
        updatedAt: now - index * 60_000,
      });
    }

    return { seeded: true, tools: DEMO_TOOLS.length };
  },
});
