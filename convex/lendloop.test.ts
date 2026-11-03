import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema, { TOOL_CATEGORIES, TOOL_CONDITIONS } from "./schema";
import { CATEGORY_LABELS, CONDITION_LABELS } from "../lib/labels";
import { todayUtc } from "./lib/validation";

const DAY = 86_400_000;

/** Uses convex-test's built-in module discovery for this project's `convex/` dir. */
function setup() {
  return convexTest(schema);
}

type Test = ReturnType<typeof setup>;
type Identity = { tokenIdentifier: string; subject: string; email: string; name: string };

const alice: Identity = {
  tokenIdentifier: "clerk|alice",
  subject: "alice",
  email: "alice@example.com",
  name: "Alice",
};
const bob: Identity = {
  tokenIdentifier: "clerk|bob",
  subject: "bob",
  email: "bob@example.com",
  name: "Bob",
};
const cam: Identity = {
  tokenIdentifier: "clerk|cam",
  subject: "cam",
  email: "cam@example.com",
  name: "Cam",
};

/** Signs a user in, exercising the real sync path, and returns their client. */
async function signIn(t: Test, identity: Identity) {
  const client = t.withIdentity(identity);
  await client.mutation(api.users.sync, {});
  return client;
}

async function userId(t: Test, tokenIdentifier: string): Promise<Id<"users">> {
  const user = await t.run(async (ctx) =>
    ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", tokenIdentifier))
      .unique(),
  );
  if (!user) throw new Error(`no user ${tokenIdentifier}`);
  return user._id;
}

async function promoteToAdmin(t: Test, tokenIdentifier: string) {
  await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", tokenIdentifier))
      .unique();
    if (!user) throw new Error("missing user");
    await ctx.db.patch(user._id, { role: "admin" });
  });
}

async function createTool(t: Test, identity: Identity, name = "Cordless drill") {
  const client = await signIn(t, identity);
  return await client.mutation(api.tools.create, {
    name,
    category: "power-tools",
    condition: "good",
    description: "Battery and charger included.",
  });
}

function range(startOffsetDays: number, endOffsetDays: number) {
  const today = todayUtc();
  return {
    startDate: today + startOffsetDays * DAY,
    endDate: today + endOffsetDays * DAY,
  };
}

describe("users", () => {
  it("creates a row from the verified identity, defaulting to the user role", async () => {
    const t = setup();
    const asAlice = await signIn(t, alice);

    const me = await asAlice.query(api.users.me, {});
    expect(me).toMatchObject({ name: "Alice", role: "user", trustedLender: false });
    // Email is stored but never returned by the public shape.
    expect(me).not.toHaveProperty("email");
  });

  it("is idempotent: signing in twice does not duplicate the user", async () => {
    const t = setup();
    await signIn(t, alice);
    await signIn(t, alice);

    const count = await t.run(
      async (ctx) => (await ctx.db.query("users").collect()).length,
    );
    expect(count).toBe(1);
  });

  it("promotes an address listed in ADMIN_EMAILS, including an existing account", async () => {
    const previous = process.env.ADMIN_EMAILS;
    const t = setup();
    const boss: Identity = {
      tokenIdentifier: "clerk|boss",
      subject: "boss",
      email: "boss@example.com",
      name: "Boss",
    };

    try {
      // First sign-in without the env var: plain user.
      const asBoss = await signIn(t, boss);
      expect((await asBoss.query(api.users.me, {}))?.role).toBe("user");

      // Adding the address to the deployment env promotes on the next sync.
      process.env.ADMIN_EMAILS = "boss@example.com";
      await asBoss.mutation(api.users.sync, {});
      expect((await asBoss.query(api.users.me, {}))?.role).toBe("admin");
    } finally {
      if (previous === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = previous;
    }
  });

  it("does not let a client promote itself", async () => {
    const t = setup();
    const asAlice = await signIn(t, alice);

    // `sync` takes no arguments, so there is no role to smuggle in. Passing one
    // must fail validation rather than being silently ignored.
    await expect(
      asAlice.mutation(api.users.sync, { role: "admin" } as never),
    ).rejects.toThrow(/validator/i);

    const me = await asAlice.query(api.users.me, {});
    expect(me?.role).toBe("user");
  });
});

describe("tools", () => {
  it("gives signed-out callers no data rather than an error", async () => {
    const t = setup();
    // Reads degrade to empty so a not-yet-synced viewer doesn't hit the error
    // boundary; writes still refuse outright.
    await expect(t.query(api.tools.browse, {})).resolves.toEqual([]);
    await expect(t.query(api.tools.myListings, {})).resolves.toEqual([]);
    await expect(
      t.mutation(api.tools.create, {
        name: "Ladder",
        category: "garden",
        condition: "good",
        description: "nope",
      }),
    ).rejects.toThrow(/signed in/i);
  });

  it("validates name and description", async () => {
    const t = setup();
    const asAlice = await signIn(t, alice);

    await expect(
      asAlice.mutation(api.tools.create, {
        name: "   ",
        category: "garden",
        condition: "good",
        description: "ok",
      }),
    ).rejects.toThrow(/name is required/i);

    await expect(
      asAlice.mutation(api.tools.create, {
        name: "Ladder",
        category: "garden",
        condition: "good",
        description: "x".repeat(600),
      }),
    ).rejects.toThrow(/500 characters/i);
  });

  it("exposes only name and category to signed-out visitors", async () => {
    const t = setup();
    await createTool(t, alice, "Tile cutter");

    const publicList = await t.query(api.tools.listPublic, {});
    expect(publicList).toEqual([{ name: "Tile cutter", category: "power-tools" }]);
    // No owner, condition, or description leaked.
    expect(Object.keys(publicList[0]).sort()).toEqual(["category", "name"]);
  });

  it("hides archived listings from the public list", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);

    await asAlice.mutation(api.tools.archive, { id: toolId });
    expect(await t.query(api.tools.listPublic, {})).toEqual([]);
  });

  it("refuses edits and deletes from anyone but the owner", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asBob = await signIn(t, bob);

    await expect(
      asBob.mutation(api.tools.update, {
        id: toolId,
        name: "Stolen",
        category: "power-tools",
        condition: "good",
        description: "nope",
      }),
    ).rejects.toThrow(/your own listings/i);

    await expect(asBob.mutation(api.tools.archive, { id: toolId })).rejects.toThrow(
      /your own listings/i,
    );
  });

  it("lets an admin remove any listing, and records it", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    await signIn(t, cam);
    await promoteToAdmin(t, cam.tokenIdentifier);
    const asCam = t.withIdentity(cam);

    await asCam.mutation(api.admin.archiveTool, { toolId });

    const log = await asCam.query(api.admin.auditLog, {});
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "tool.archived", actorName: "Cam" });

    const publicList = await t.query(api.tools.listPublic, {});
    expect(publicList).toEqual([]);
  });
});

describe("admin authorization", () => {
  it("blocks non-admins from every admin function", async () => {
    const t = setup();
    const asAlice = await signIn(t, alice);

    await expect(asAlice.query(api.admin.allUsers, {})).rejects.toThrow(/administrator/i);
    await expect(asAlice.query(api.admin.allLoans, {})).rejects.toThrow(/administrator/i);
    await expect(asAlice.query(api.admin.auditLog, {})).rejects.toThrow(/administrator/i);
    await expect(
      asAlice.mutation(api.admin.setTrustedLender, {
        userId: await userId(t, alice.tokenIdentifier),
        trusted: true,
      }),
    ).rejects.toThrow(/administrator/i);
  });

  it("lets an admin grant trusted lender status", async () => {
    const t = setup();
    await signIn(t, alice);
    await signIn(t, cam);
    await promoteToAdmin(t, cam.tokenIdentifier);
    const asCam = t.withIdentity(cam);

    await asCam.mutation(api.admin.setTrustedLender, {
      userId: await userId(t, alice.tokenIdentifier),
      trusted: true,
    });

    const asAlice = t.withIdentity(alice);
    const me = await asAlice.query(api.users.me, {});
    expect(me?.trustedLender).toBe(true);
  });

  it("stops an admin from changing their own role", async () => {
    const t = setup();
    await signIn(t, cam);
    await promoteToAdmin(t, cam.tokenIdentifier);
    const asCam = t.withIdentity(cam);

    await expect(
      asCam.mutation(api.admin.setRole, {
        userId: await userId(t, cam.tokenIdentifier),
        role: "user",
      }),
    ).rejects.toThrow(/your own account/i);
  });
});

describe("loans", () => {
  it("runs the full request → approve → return flow", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asBob = await signIn(t, bob);
    const asAlice = t.withIdentity(alice);

    const loanId = await asBob.mutation(api.loans.request, {
      toolId,
      ...range(1, 3),
      message: "Shelf project.",
    });

    const incoming = await asAlice.query(api.loans.incoming, {});
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ status: "pending", borrowerName: "Bob" });

    await asAlice.mutation(api.loans.decide, { loanId, decision: "approved" });

    const browse = await asBob.query(api.tools.browse, {});
    expect(browse[0].availability.state).toBe("available"); // loan starts tomorrow
    const detail = await asAlice.query(api.loans.get, { id: loanId });
    expect(detail?.status).toBe("approved");

    await asAlice.mutation(api.loans.markReturned, { loanId });
    const returned = await asAlice.query(api.loans.get, { id: loanId });
    expect(returned?.status).toBe("returned");
    expect(returned?.returnedAt).not.toBeNull();
  });

  it("refuses a borrower approving their own request", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asBob = await signIn(t, bob);

    const loanId = await asBob.mutation(api.loans.request, { toolId, ...range(1, 2) });
    await expect(
      asBob.mutation(api.loans.decide, { loanId, decision: "approved" }),
    ).rejects.toThrow(/only the lender/i);
  });

  it("refuses a borrower marking someone else's loan returned", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);
    const asBob = await signIn(t, bob);

    const loanId = await asBob.mutation(api.loans.request, { toolId, ...range(1, 2) });
    await asAlice.mutation(api.loans.decide, { loanId, decision: "approved" });

    await expect(asBob.mutation(api.loans.markReturned, { loanId })).rejects.toThrow(
      /only the lender/i,
    );
  });

  it("refuses borrowing your own tool", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);

    await expect(
      asAlice.mutation(api.loans.request, { toolId, ...range(1, 2) }),
    ).rejects.toThrow(/your own tool/i);
  });

  it("keeps a loan private from unrelated users", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asBob = await signIn(t, bob);
    const loanId = await asBob.mutation(api.loans.request, { toolId, ...range(1, 2) });

    const asCam = await signIn(t, cam);
    await expect(asCam.query(api.loans.get, { id: loanId })).rejects.toThrow(
      /not yours/i,
    );
  });

  it("blocks a request that overlaps an approved loan", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);
    const asBob = await signIn(t, bob);
    const asCam = await signIn(t, cam);

    const first = await asBob.mutation(api.loans.request, { toolId, ...range(1, 4) });
    await asAlice.mutation(api.loans.decide, { loanId: first, decision: "approved" });

    await expect(
      asCam.mutation(api.loans.request, { toolId, ...range(3, 6) }),
    ).rejects.toThrow(/overlap/i);

    // A non-overlapping window is still fine.
    const second = await asCam.mutation(api.loans.request, { toolId, ...range(10, 12) });
    expect(second).toBeTruthy();
  });

  it("allows several pending requests, but approving two overlapping ones fails", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);
    const asBob = await signIn(t, bob);
    const asCam = await signIn(t, cam);

    const bobLoan = await asBob.mutation(api.loans.request, { toolId, ...range(2, 4) });
    const camLoan = await asCam.mutation(api.loans.request, { toolId, ...range(3, 5) });

    await asAlice.mutation(api.loans.decide, { loanId: bobLoan, decision: "approved" });
    await expect(
      asAlice.mutation(api.loans.decide, { loanId: camLoan, decision: "approved" }),
    ).rejects.toThrow(/overlap/i);
  });

  it("only the borrower can cancel, and only while pending", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);
    const asBob = await signIn(t, bob);

    const loanId = await asBob.mutation(api.loans.request, { toolId, ...range(1, 2) });

    await expect(asAlice.mutation(api.loans.cancel, { loanId })).rejects.toThrow(
      /only the borrower/i,
    );

    await asBob.mutation(api.loans.cancel, { loanId });
    await expect(asBob.mutation(api.loans.cancel, { loanId })).rejects.toThrow(
      /only pending/i,
    );
  });

  it("validates the date range", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asBob = await signIn(t, bob);

    await expect(
      asBob.mutation(api.loans.request, { toolId, ...range(5, 2) }),
    ).rejects.toThrow(/on or after/i);

    await expect(
      asBob.mutation(api.loans.request, { toolId, ...range(-3, 1) }),
    ).rejects.toThrow(/past/i);

    await expect(
      asBob.mutation(api.loans.request, { toolId, ...range(1, 120) }),
    ).rejects.toThrow(/90 days/i);
  });

  it("refuses a request against a removed listing", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);
    await asAlice.mutation(api.tools.archive, { id: toolId });

    const asBob = await signIn(t, bob);
    await expect(
      asBob.mutation(api.loans.request, { toolId, ...range(1, 2) }),
    ).rejects.toThrow(/no longer available/i);
  });
});

describe("schema and UI labels", () => {
  it("has a display label for every category and condition", () => {
    // Convex can only bundle files under convex/, so the label maps are a
    // deliberate duplicate. This fails the build if a new enum value is added
    // without one, instead of rendering a raw slug like "power-tools".
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...TOOL_CATEGORIES].sort());
    expect(Object.keys(CONDITION_LABELS).sort()).toEqual([...TOOL_CONDITIONS].sort());
  });
});

describe("removed listings and pending requests", () => {
  it("refuses to approve a request once the listing is removed", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);
    const asBob = await signIn(t, bob);

    const loanId = await asBob.mutation(api.loans.request, { toolId, ...range(1, 2) });

    // The owner removes the listing while the request is still pending.
    await asAlice.mutation(api.tools.archive, { id: toolId });

    await expect(
      asAlice.mutation(api.loans.decide, { loanId, decision: "approved" }),
    ).rejects.toThrow(/listing was removed/i);
  });

  it("returns null for a listing that does not exist, instead of throwing", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);

    const deleted = await t.run(async (ctx) => {
      await ctx.db.delete(toolId);
      return toolId;
    });

    await expect(asAlice.query(api.tools.get, { id: deleted })).resolves.toBeNull();
  });
});

describe("public availability", () => {
  it("hides a tool from the public list while it is out on loan", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);
    const asBob = await signIn(t, bob);

    expect(await t.query(api.tools.listPublic, {})).toHaveLength(1);

    const loanId = await asBob.mutation(api.loans.request, { toolId, ...range(0, 0) });
    await asAlice.mutation(api.loans.decide, { loanId, decision: "approved" });

    // Started today, so it is actively lent.
    expect(await t.query(api.tools.listPublic, {})).toHaveLength(0);

    await asAlice.mutation(api.loans.markReturned, { loanId });
    expect(await t.query(api.tools.listPublic, {})).toHaveLength(1);
  });
});

describe("date normalization", () => {
  it("stores the UTC day, not the exact timestamp the caller sent", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asBob = await signIn(t, bob);

    // A caller hitting the mutation directly can send any millisecond value.
    const midDay = todayUtc() + 23 * 60 * 60 * 1000;
    const loanId = await asBob.mutation(api.loans.request, {
      toolId,
      startDate: midDay,
      endDate: midDay,
    });

    const stored = await t.run(async (ctx) => ctx.db.get(loanId as Id<"loans">));
    expect(stored?.startDate).toBe(todayUtc());
    expect(stored?.endDate).toBe(todayUtc());
  });

  it("keeps the overlap invariant for an unaligned range", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);
    const asBob = await signIn(t, bob);
    const asCam = await signIn(t, cam);

    const midDay = todayUtc() + 23 * 60 * 60 * 1000;
    const unaligned = await asBob.mutation(api.loans.request, {
      toolId,
      startDate: midDay,
      endDate: midDay,
    });
    await asAlice.mutation(api.loans.decide, {
      loanId: unaligned,
      decision: "approved",
    });

    // Same calendar day, but expressed as midnight. Without normalization this
    // would be judged non-overlapping and both requests could be approved.
    await expect(
      asCam.mutation(api.loans.request, {
        toolId,
        startDate: todayUtc(),
        endDate: todayUtc(),
      }),
    ).rejects.toThrow(/overlap/i);
  });
});

describe("archived listings with pending requests", () => {
  it("still allows declining, so the request is not stuck forever", async () => {
    const t = setup();
    const toolId = await createTool(t, alice);
    const asAlice = t.withIdentity(alice);
    const asBob = await signIn(t, bob);

    const loanId = await asBob.mutation(api.loans.request, { toolId, ...range(1, 2) });
    await asAlice.mutation(api.tools.archive, { id: toolId });

    await asAlice.mutation(api.loans.decide, { loanId, decision: "declined" });
    const loan = await asAlice.query(api.loans.get, { id: loanId });
    expect(loan?.status).toBe("declined");
  });
});
