import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { hmacSha256Hex, verifyRequestSignature } from "./lib/signing";
import { todayUtc } from "./lib/validation";

const DAY = 86_400_000;

function setup() {
  return convexTest(schema);
}

type Test = ReturnType<typeof setup>;
type Identity = { tokenIdentifier: string; subject: string; email: string; name: string };

const alice: Identity = {
  tokenIdentifier: "clerk|a",
  subject: "a",
  email: "alice@example.com",
  name: "Alice",
};
const bob: Identity = {
  tokenIdentifier: "clerk|b",
  subject: "b",
  email: "bob@example.com",
  name: "Bob",
};
const cam: Identity = {
  tokenIdentifier: "clerk|c",
  subject: "c",
  email: "cam@example.com",
  name: "Cam",
};

async function signIn(t: Test, identity: Identity) {
  const client = t.withIdentity(identity);
  await client.mutation(api.users.sync, {});
  return client;
}

async function makeLoan(t: Test) {
  const asAlice = await signIn(t, alice);
  const asBob = await signIn(t, bob);

  const toolId = await asAlice.mutation(api.tools.create, {
    name: "Cordless drill",
    category: "power-tools",
    condition: "good",
    description: "Battery and charger included.",
  });

  const loanId = await asBob.mutation(api.loans.request, {
    toolId,
    startDate: todayUtc() + DAY,
    endDate: todayUtc() + 2 * DAY,
  });

  return { asAlice, asBob, toolId, loanId };
}

describe("signing", () => {
  it("matches an independent HMAC-SHA256 implementation", async () => {
    // Known-answer vector computed with Python's hmac/hashlib, so this test does
    // not compare our code against itself.
    const signature = await hmacSha256Hex("test-secret", '1700000000.{"hello":"world"}');
    expect(signature).toBe(
      "f85455a1b55ea86f7a15f5f9923d0abc4b888da84ec485f2ff358f427776beca",
    );
  });

  it("accepts a fresh, correctly signed request", async () => {
    const now = 1_700_000_000_000;
    const timestamp = "1700000000";
    const body = '{"loanId":"x"}';
    const signature = await hmacSha256Hex("test-secret", `${timestamp}.${body}`);

    await expect(
      verifyRequestSignature({
        secret: "test-secret",
        timestamp,
        signature,
        body,
        now,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects a forged signature and a tampered body", async () => {
    const now = 1_700_000_000_000;
    const timestamp = "1700000000";
    const body = '{"loanId":"x"}';

    await expect(
      verifyRequestSignature({
        secret: "test-secret",
        timestamp,
        signature: "0".repeat(64),
        body,
        now,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });

    // Same signature, different body: the body is covered by the HMAC.
    const signature = await hmacSha256Hex("test-secret", `${timestamp}.${body}`);
    await expect(
      verifyRequestSignature({
        secret: "test-secret",
        timestamp,
        signature,
        body: '{"loanId":"y"}',
        now,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a replay outside the five minute window", async () => {
    const timestamp = "1700000000";
    const body = "{}";
    const signature = await hmacSha256Hex("test-secret", `${timestamp}.${body}`);

    await expect(
      verifyRequestSignature({
        secret: "test-secret",
        timestamp,
        signature,
        body,
        now: 1_700_000_000_000 + 6 * 60_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "stale" });
  });

  it("rejects missing headers", async () => {
    await expect(
      verifyRequestSignature({
        secret: "test-secret",
        timestamp: null,
        signature: null,
        body: "{}",
      }),
    ).resolves.toEqual({ ok: false, reason: "missing" });
  });
});

describe("automation outbox", () => {
  it("queues exactly one job per loan event, with a minimal payload", async () => {
    const t = setup();
    const { loanId } = await makeLoan(t);

    const jobs = await t.run(async (ctx) =>
      ctx.db
        .query("automationJobs")
        .withIndex("by_loan", (q) => q.eq("loanId", loanId as Id<"loans">))
        .collect(),
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "loan.requested",
      status: "pending",
      attempts: 0,
    });

    const data = (jobs[0].payload as { data: Record<string, unknown> }).data;
    // Only what a notification needs. No tool description, no user ids, and no
    // email for the party who is not being addressed.
    expect(Object.keys(data).sort()).toEqual([
      "audience",
      "counterpartyName",
      "endDate",
      "loanId",
      "recipientEmail",
      "recipientName",
      "startDate",
      "status",
      "toolCategory",
      "toolName",
    ]);
    expect(data).not.toHaveProperty("description");
    // A new request addresses the lender.
    expect(data.audience).toBe("lender");
    expect(data.recipientEmail).toBe("alice@example.com");
  });

  it("queues a status change when a request is approved", async () => {
    const t = setup();
    const { asAlice, loanId } = await makeLoan(t);

    await asAlice.mutation(api.loans.decide, { loanId, decision: "approved" });

    const jobs = await t.run(async (ctx) =>
      ctx.db
        .query("automationJobs")
        .withIndex("by_loan", (q) => q.eq("loanId", loanId as Id<"loans">))
        .collect(),
    );

    expect(jobs).toHaveLength(2);
    const statuses = jobs.map(
      (job) => (job.payload as { data: { status: string } }).data.status,
    );
    expect(statuses).toContain("pending");
    expect(statuses).toContain("approved");

    // A decision addresses the borrower, and the lender's email is not included.
    const approved = jobs.find(
      (job) => (job.payload as { data: { status: string } }).data.status === "approved",
    );
    const approvedData = (approved?.payload as { data: Record<string, unknown> }).data;
    expect(approvedData.audience).toBe("borrower");
    expect(approvedData.recipientEmail).toBe("bob@example.com");
    expect(JSON.stringify(approvedData)).not.toContain("alice@example.com");
  });

  it("fails loudly, and visibly, when the integration is not configured", async () => {
    const t = setup();
    const { loanId } = await makeLoan(t);

    const job = await t.run(async (ctx) =>
      ctx.db
        .query("automationJobs")
        .withIndex("by_loan", (q) => q.eq("loanId", loanId as Id<"loans">))
        .first(),
    );
    if (!job) throw new Error("no job");

    const previousSecret = process.env.LENDLOOP_SHARED_SECRET;
    const previousUrl = process.env.N8N_WEBHOOK_URL;
    delete process.env.LENDLOOP_SHARED_SECRET;
    delete process.env.N8N_WEBHOOK_URL;

    try {
      await t.action(internal.automation.deliver, { jobId: job._id });

      const failed = await t.run(async (ctx) => ctx.db.get(job._id));
      expect(failed?.status).toBe("failed");
      expect(failed?.lastError).toMatch(/not configured/i);

      const activity = await t.run(async (ctx) =>
        ctx.db
          .query("loanActivity")
          .withIndex("by_loan_created", (q) => q.eq("loanId", job.loanId))
          .collect(),
      );
      // A failure the user can see, not a silent drop.
      expect(activity.map((row) => row.kind)).toContain("notification.failed");
    } finally {
      if (previousSecret !== undefined)
        process.env.LENDLOOP_SHARED_SECRET = previousSecret;
      if (previousUrl !== undefined) process.env.N8N_WEBHOOK_URL = previousUrl;
    }
  });

  it("backs off, then gives up and records a visible failure", async () => {
    const t = setup();
    const { loanId } = await makeLoan(t);

    const job = await t.run(async (ctx) =>
      ctx.db
        .query("automationJobs")
        .withIndex("by_loan", (q) => q.eq("loanId", loanId as Id<"loans">))
        .first(),
    );
    if (!job) throw new Error("no job");

    // Five attempts is the ladder length; the fifth marks the job failed.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await t.mutation(internal.automation.scheduleRetry, {
        jobId: job._id,
        error: "n8n responded 500",
      });
    }

    const after = await t.run(async (ctx) => ctx.db.get(job._id));
    expect(after?.status).toBe("failed");
    expect(after?.attempts).toBe(5);

    const activity = await t.run(async (ctx) =>
      ctx.db
        .query("loanActivity")
        .withIndex("by_loan_created", (q) => q.eq("loanId", after!.loanId))
        .collect(),
    );
    const failures = activity.filter((row) => row.kind === "notification.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toMatch(/5 attempts/);
  });
});

describe("idempotent write-back", () => {
  it("records a reminder once, and reports the replay as a duplicate", async () => {
    const t = setup();
    const { loanId } = await makeLoan(t);

    const args = {
      loanId: loanId as Id<"loans">,
      idempotencyKey: "reminder:loan:2026-11-03",
      channel: "mock",
      detail: "Overdue reminder sent",
    };

    const first = await t.mutation(internal.automation.recordReminder, args);
    const second = await t.mutation(internal.automation.recordReminder, args);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("loanActivity")
        .withIndex("by_dedupe", (q) => q.eq("dedupeKey", args.idempotencyKey))
        .collect(),
    );
    // A retried delivery must not create a second reminder.
    expect(rows).toHaveLength(1);
  });

  it("refuses to record a reminder for a loan that no longer exists", async () => {
    const t = setup();
    const { loanId } = await makeLoan(t);

    // A deleted loan leaves a structurally valid id behind, which is the case
    // that reaches the handler: the validator has already accepted the format.
    await t.run(async (ctx) => {
      await ctx.db.delete(loanId as Id<"loans">);
    });

    await expect(
      t.mutation(internal.automation.recordReminder, {
        loanId: loanId as Id<"loans">,
        idempotencyKey: "reminder:missing",
        channel: "mock",
        detail: "nope",
      }),
    ).rejects.toThrow(/unknown loan/i);
  });

  it("rejects a malformed loan id before any handler runs", async () => {
    const t = setup();

    await expect(
      t.mutation(internal.automation.recordReminder, {
        loanId: "not-an-id" as Id<"loans">,
        idempotencyKey: "reminder:garbage",
        channel: "mock",
        detail: "nope",
      }),
    ).rejects.toThrow(/validator/i);
  });
});

describe("overdue query", () => {
  it("returns only approved loans past their return date, with minimal fields", async () => {
    const t = setup();
    const { asAlice, loanId } = await makeLoan(t);
    await asAlice.mutation(api.loans.decide, { loanId, decision: "approved" });

    // The mutation layer refuses past dates, so age the loan directly to
    // simulate a loan that has since run out of time.
    await t.run(async (ctx) => {
      await ctx.db.patch(loanId as Id<"loans">, {
        startDate: todayUtc() - 5 * DAY,
        endDate: todayUtc() - 2 * DAY,
      });
    });

    const overdue = await t.query(internal.automation.overdueLoans, {});

    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({
      loanId,
      toolName: "Cordless drill",
      daysOverdue: 2,
    });
    expect(Object.keys(overdue[0]).sort()).toEqual([
      "borrowerEmail",
      "borrowerName",
      "daysOverdue",
      "dueDate",
      "loanId",
      "toolName",
    ]);
  });

  it("ignores loans that are still active", async () => {
    const t = setup();
    const { asAlice, loanId } = await makeLoan(t);
    await asAlice.mutation(api.loans.decide, { loanId, decision: "approved" });

    expect(await t.query(internal.automation.overdueLoans, {})).toHaveLength(0);
  });
});

describe("loan activity authorization", () => {
  it("shows activity to participants and hides it from everyone else", async () => {
    const t = setup();
    const { asAlice, asBob, loanId } = await makeLoan(t);

    await t.mutation(internal.automation.recordReminder, {
      loanId: loanId as Id<"loans">,
      idempotencyKey: "reminder:authz",
      channel: "mock",
      detail: "Overdue reminder sent",
    });

    const forLender = await asAlice.query(api.automation.activityForLoan, { loanId });
    const forBorrower = await asBob.query(api.automation.activityForLoan, { loanId });
    expect(forLender).toHaveLength(1);
    expect(forBorrower).toHaveLength(1);

    const asCam = await signIn(t, cam);
    await expect(asCam.query(api.automation.activityForLoan, { loanId })).rejects.toThrow(
      /not yours/i,
    );
  });

  it("only exposes the global activity feed to admins", async () => {
    const t = setup();
    const asAlice = await signIn(t, alice);

    // Non-admins get an empty list rather than an error, so the page degrades
    // quietly without leaking whether activity exists.
    expect(await asAlice.query(api.automation.recentActivity, {})).toEqual([]);
  });
});

describe("workflow failure reporting", () => {
  it("records a failure even when it does not belong to a specific loan", async () => {
    const t = setup();
    await signIn(t, alice);

    const result = await t.mutation(internal.automation.recordWorkflowFailure, {
      idempotencyKey: "workflow-failure:Overdue:123",
      workflow: "LendLoop — Overdue reminders",
      detail: "Fetch overdue loans: timeout",
    });

    expect(result.duplicate).toBe(false);

    const rows = await t.run(async (ctx) => ctx.db.query("loanActivity").collect());
    // Before this was fixed the row was silently skipped, so a broken workflow
    // left no trace anywhere in the app.
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("workflow.failed");
    expect(rows[0].loanId).toBeUndefined();
  });

  it("collapses a repeated failure report", async () => {
    const t = setup();
    const args = {
      idempotencyKey: "workflow-failure:Overdue:456",
      workflow: "LendLoop — Overdue reminders",
      detail: "same failure",
    };

    await t.mutation(internal.automation.recordWorkflowFailure, args);
    const second = await t.mutation(internal.automation.recordWorkflowFailure, args);

    expect(second.duplicate).toBe(true);
    expect(
      await t.run(async (ctx) => (await ctx.db.query("loanActivity").collect()).length),
    ).toBe(1);
  });
});

describe("idempotency-key reuse", () => {
  it("reports a conflict instead of success when a key is reused for another loan", async () => {
    const t = setup();
    const first = await makeLoan(t);

    // A second loan between the same two people.
    const asBob = t.withIdentity(bob);
    const secondLoanId = await asBob.mutation(api.loans.request, {
      toolId: first.toolId,
      startDate: todayUtc() + 40 * DAY,
      endDate: todayUtc() + 41 * DAY,
    });

    await t.mutation(internal.automation.recordReminder, {
      loanId: first.loanId as Id<"loans">,
      idempotencyKey: "reused-key",
      channel: "mock",
      detail: "first",
    });

    const reused = await t.mutation(internal.automation.recordReminder, {
      loanId: secondLoanId,
      idempotencyKey: "reused-key",
      channel: "mock",
      detail: "second",
    });

    expect(reused.conflict).toBe(true);
  });
});
