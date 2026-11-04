import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { hmacSha256Hex } from "./lib/signing";
import { todayUtc } from "./lib/validation";

/**
 * HTTP-action tests.
 *
 * These exercise the real router through `t.fetch`, so signature verification,
 * status codes and idempotency are covered by the suite instead of only by the
 * manual curl pass described in the README.
 */

const SECRET = "test-shared-secret";
const DAY = 86_400_000;

beforeEach(() => {
  process.env.LENDLOOP_SHARED_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.LENDLOOP_SHARED_SECRET;
});

function setup() {
  return convexTest(schema);
}

type Test = ReturnType<typeof setup>;

async function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const ts = String(timestamp);
  return {
    "content-type": "application/json",
    "x-lendloop-timestamp": ts,
    "x-lendloop-signature": await hmacSha256Hex(SECRET, `${ts}.${body}`),
  };
}

/** Creates a loan and returns its id, so write-backs have a real target. */
async function seedLoan(t: Test) {
  const alice = t.withIdentity({
    tokenIdentifier: "clerk|a",
    subject: "a",
    email: "alice@example.com",
    name: "Alice",
  });
  const bob = t.withIdentity({
    tokenIdentifier: "clerk|b",
    subject: "b",
    email: "bob@example.com",
    name: "Bob",
  });

  await alice.mutation(api.users.sync, {});
  await bob.mutation(api.users.sync, {});

  const toolId = await alice.mutation(api.tools.create, {
    name: "Cordless drill",
    category: "power-tools",
    condition: "good",
    description: "Battery included.",
  });

  const loanId = await bob.mutation(api.loans.request, {
    toolId,
    startDate: todayUtc() + DAY,
    endDate: todayUtc() + 2 * DAY,
  });

  return { loanId: loanId as Id<"loans">, toolId };
}

describe("GET /automation/overdue", () => {
  it("rejects an unsigned request", async () => {
    const t = setup();
    const response = await t.fetch("/automation/overdue");
    expect(response.status).toBe(401);
  });

  it("rejects a stale timestamp", async () => {
    const t = setup();
    const stale = Math.floor(Date.now() / 1000) - 600;
    const response = await t.fetch("/automation/overdue", {
      headers: await signedHeaders("", stale),
    });
    expect(response.status).toBe(401);
  });

  it("returns overdue loans for a signed request", async () => {
    const t = setup();
    const { loanId } = await seedLoan(t);

    // Age the loan past its return date; the mutation layer refuses past dates.
    await t.run(async (ctx) => {
      await ctx.db.patch(loanId, {
        status: "approved",
        startDate: todayUtc() - 5 * DAY,
        endDate: todayUtc() - 2 * DAY,
      });
    });

    const response = await t.fetch("/automation/overdue", {
      headers: await signedHeaders(""),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { loans: unknown[]; count: number };
    expect(payload.count).toBe(1);
  });

  it("fails closed when the secret is not configured", async () => {
    const t = setup();
    delete process.env.LENDLOOP_SHARED_SECRET;

    const response = await t.fetch("/automation/overdue");
    expect(response.status).toBe(503);
  });
});

describe("POST /automation/reminders", () => {
  it("records a reminder, then reports the replay as a duplicate", async () => {
    const t = setup();
    const { loanId } = await seedLoan(t);

    const body = JSON.stringify({ loanId, channel: "mock", detail: "Overdue reminder" });
    const headers = { ...(await signedHeaders(body)), "idempotency-key": "reminder:1" };

    const first = await t.fetch("/automation/reminders", {
      method: "POST",
      body,
      headers,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      duplicate: false,
      confirmed: false,
      loanId,
    });

    const replay = await t.fetch("/automation/reminders", {
      method: "POST",
      body,
      headers,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      duplicate: true,
      confirmed: false,
      loanId,
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("loanActivity")
        .withIndex("by_dedupe", (q) => q.eq("dedupeKey", "reminder:1"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  it("requires an idempotency key", async () => {
    const t = setup();
    const { loanId } = await seedLoan(t);
    const body = JSON.stringify({ loanId });

    const response = await t.fetch("/automation/reminders", {
      method: "POST",
      body,
      headers: await signedHeaders(body),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a body that does not match its signature", async () => {
    const t = setup();
    const { loanId } = await seedLoan(t);

    const signed = JSON.stringify({ loanId, detail: "a" });
    const sent = JSON.stringify({ loanId, detail: "b" });

    const response = await t.fetch("/automation/reminders", {
      method: "POST",
      body: sent,
      headers: { ...(await signedHeaders(signed)), "idempotency-key": "tampered" },
    });
    expect(response.status).toBe(401);
  });

  it("returns 400 for a malformed loan id", async () => {
    const t = setup();
    const body = JSON.stringify({ loanId: "junk" });

    const response = await t.fetch("/automation/reminders", {
      method: "POST",
      body,
      headers: { ...(await signedHeaders(body)), "idempotency-key": "bad-id" },
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /automation/reminders/confirm", () => {
  const key = "reminder:confirm:1";

  async function claim(t: Test, loanId: Id<"loans">) {
    const body = JSON.stringify({
      loanId,
      channel: "mock",
      detail: "Overdue reminder",
    });
    const response = await t.fetch("/automation/reminders", {
      method: "POST",
      body,
      headers: { ...(await signedHeaders(body)), "idempotency-key": key },
    });
    expect(response.status).toBe(200);
    return body;
  }

  it("marks a claimed reminder confirmed, once", async () => {
    const t = setup();
    const { loanId } = await seedLoan(t);
    await claim(t, loanId);

    const body = JSON.stringify({ loanId });
    const headers = { ...(await signedHeaders(body)), "idempotency-key": key };

    const first = await t.fetch("/automation/reminders/confirm", {
      method: "POST",
      body,
      headers,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });

    const replay = await t.fetch("/automation/reminders/confirm", {
      method: "POST",
      body,
      headers,
    });
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });

    // A rerun of the workflow now sees the claim as confirmed and must not resend.
    const claimBody = await claim(t, loanId);
    const claimReplay = await t.fetch("/automation/reminders", {
      method: "POST",
      body: claimBody,
      headers: { ...(await signedHeaders(claimBody)), "idempotency-key": key },
    });
    expect(await claimReplay.json()).toEqual({
      ok: true,
      duplicate: true,
      confirmed: true,
      loanId,
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("loanActivity")
        .withIndex("by_dedupe", (q) => q.eq("dedupeKey", key))
        .unique(),
    );
    expect(row?.confirmedAt).toBeTypeOf("number");
  });

  it("refuses to confirm a reminder that was never claimed", async () => {
    const t = setup();
    const { loanId } = await seedLoan(t);
    const body = JSON.stringify({ loanId });

    const response = await t.fetch("/automation/reminders/confirm", {
      method: "POST",
      body,
      headers: { ...(await signedHeaders(body)), "idempotency-key": "never-claimed" },
    });
    expect(response.status).toBe(404);
  });

  it("requires an idempotency key and a signature", async () => {
    const t = setup();
    const { loanId } = await seedLoan(t);
    const body = JSON.stringify({ loanId });

    const noKey = await t.fetch("/automation/reminders/confirm", {
      method: "POST",
      body,
      headers: await signedHeaders(body),
    });
    expect(noKey.status).toBe(400);

    const unsigned = await t.fetch("/automation/reminders/confirm", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "idempotency-key": "unsigned" },
    });
    expect(unsigned.status).toBe(401);
  });
});

describe("POST /automation/failures", () => {
  it("records a workflow failure with no loan attached", async () => {
    const t = setup();
    const body = JSON.stringify({ workflow: "Overdue reminders", detail: "timeout" });

    const response = await t.fetch("/automation/failures", {
      method: "POST",
      body,
      headers: { ...(await signedHeaders(body)), "idempotency-key": "failure:1" },
    });

    expect(response.status).toBe(200);

    const rows = await t.run(async (ctx) => ctx.db.query("loanActivity").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("workflow.failed");
    // Absent, not null: the row is not tied to any loan.
    expect(rows[0].loanId).toBeUndefined();
  });

  it("collapses a repeated failure report", async () => {
    const t = setup();
    const body = JSON.stringify({ workflow: "Overdue reminders", detail: "timeout" });
    const headers = { ...(await signedHeaders(body)), "idempotency-key": "failure:2" };

    await t.fetch("/automation/failures", { method: "POST", body, headers });
    const second = await t.fetch("/automation/failures", {
      method: "POST",
      body,
      headers,
    });

    expect(await second.json()).toEqual({ ok: true, duplicate: true });
  });

  it("is not reachable without a signature", async () => {
    const t = setup();
    const body = JSON.stringify({ workflow: "x", detail: "y" });

    const response = await t.fetch("/automation/failures", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "idempotency-key": "failure:3" },
    });
    expect(response.status).toBe(401);
  });
});

describe("outbox delivery", () => {
  it("marks a job sent when n8n accepts it", async () => {
    const t = setup();
    const { loanId } = await seedLoan(t);

    const job = await t.run(async (ctx) =>
      ctx.db
        .query("automationJobs")
        .withIndex("by_loan", (q) => q.eq("loanId", loanId))
        .first(),
    );
    if (!job) throw new Error("no job queued");

    process.env.N8N_WEBHOOK_URL = "https://n8n.invalid/webhook/test";
    const originalFetch = globalThis.fetch;
    let signed = false;

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      signed = Boolean(
        init?.headers &&
        "x-lendloop-signature" in (init.headers as Record<string, string>),
      );
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await t.action(internal.automation.deliver, { jobId: job._id });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.N8N_WEBHOOK_URL;
    }

    const after = await t.run(async (ctx) => ctx.db.get(job._id));
    expect(after?.status).toBe("sent");
    // The outbound request must be signed, not just the inbound ones.
    expect(signed).toBe(true);
  });
});
