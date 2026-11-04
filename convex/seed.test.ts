import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

function setup() {
  return convexTest(schema);
}

type Test = ReturnType<typeof setup>;

const alice = {
  tokenIdentifier: "clerk|seed-alice",
  subject: "seed-alice",
  email: "alice@example.com",
  name: "Alice",
};

async function signIn(t: Test) {
  const client = t.withIdentity(alice);
  await client.mutation(api.users.sync, {});
  return client;
}

async function aliceRow(t: Test) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", alice.tokenIdentifier))
      .unique(),
  );
}

beforeEach(() => {
  process.env.SEED_ENABLED = "true";
});

afterEach(() => {
  delete process.env.SEED_ENABLED;
});

describe("seed", () => {
  it("assigns the demo tools to a real account when ownerEmail is given", async () => {
    const t = setup();
    await signIn(t);

    const result = await t.mutation(internal.seed.populate, {
      ownerEmail: "alice@example.com",
    });
    expect(result.seeded).toBe(true);

    const owner = await aliceRow(t);
    const tools = await t.run(async (ctx) => ctx.db.query("tools").collect());
    expect(tools).toHaveLength(10);
    for (const tool of tools) expect(tool.ownerId).toBe(owner?._id);
  });

  it("is idempotent per owner", async () => {
    const t = setup();
    await signIn(t);

    await t.mutation(internal.seed.populate, { ownerEmail: "alice@example.com" });
    const second = await t.mutation(internal.seed.populate, {
      ownerEmail: "alice@example.com",
    });

    expect(second.seeded).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.query("tools").collect())).toHaveLength(10);
  });

  it("refuses an owner email that has not signed in", async () => {
    const t = setup();

    await expect(
      t.mutation(internal.seed.populate, { ownerEmail: "nobody@example.com" }),
    ).rejects.toThrow(/sign in once/i);
  });

  it("adopts an earlier demo-account seed instead of duplicating it", async () => {
    const t = setup();
    await signIn(t);

    // Seed without an email first, as the old quick start did.
    await t.mutation(internal.seed.populate, {});
    const adopted = (await t.mutation(internal.seed.populate, {
      ownerEmail: "alice@example.com",
    })) as { seeded: boolean; adopted?: number };

    expect(adopted.seeded).toBe(true);
    expect(adopted.adopted).toBe(10);

    const owner = await aliceRow(t);
    const tools = await t.run(async (ctx) => ctx.db.query("tools").collect());
    expect(tools).toHaveLength(10);
    for (const tool of tools) expect(tool.ownerId).toBe(owner?._id);

    // Loans follow the tools, or the new owner could not close them.
    const loans = await t.run(async (ctx) => ctx.db.query("loans").collect());
    for (const loan of loans) expect(loan.ownerId).toBe(owner?._id);
  });

  it("does not create a second overdue loan on a replay", async () => {
    const t = setup();
    await signIn(t);
    await t.mutation(internal.seed.populate, { ownerEmail: "alice@example.com" });

    const first = await t.mutation(internal.seed.createDemoOverdueLoan, {});
    const second = await t.mutation(internal.seed.createDemoOverdueLoan, {});

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.loanId).toBe(first.loanId);
    expect(await t.run(async (ctx) => ctx.db.query("loans").collect())).toHaveLength(1);
  });

  it("refuses to run when seeding is disabled", async () => {
    delete process.env.SEED_ENABLED;
    const t = setup();

    await expect(t.mutation(internal.seed.populate, {})).rejects.toThrow(/disabled/i);
  });
});
