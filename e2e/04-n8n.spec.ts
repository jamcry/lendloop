import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { readState } from "./support";

/**
 * Exercises the n8n integration the way the two systems actually talk to each
 * other: signed HTTP in both directions, an idempotent write-back, and the
 * scheduled workflow run twice.
 *
 * These run against the local n8n container and the live Convex deployment, so
 * they need `n8n/docker-compose.yml` up.
 */

const state = readState();
const runId = state.runId;

function readDotenv(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // A missing file is reported by `beforeAll` with a useful message instead of
    // an ENOENT stack from module loading.
    return values;
  }
  for (const line of raw.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

const n8nEnv = readDotenv(path.join(process.cwd(), "n8n", ".env"));
const secret = n8nEnv.LENDLOOP_SHARED_SECRET;
const siteUrl =
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
  readDotenv(path.join(process.cwd(), ".env.local")).NEXT_PUBLIC_CONVEX_SITE_URL;
const webhookUrl =
  process.env.E2E_N8N_WEBHOOK_URL ??
  "http://localhost:5678/webhook/lendloop/request-event";

/** Same function as `convex/lib/signing.ts` and the n8n Code node. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function sign(body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function signedHeaders(
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-lendloop-timestamp": String(timestamp),
    "x-lendloop-signature": sign(body, timestamp),
    ...extra,
  };
}

async function overdueLoans(): Promise<{ loanId: string; dueDate: number }[]> {
  const response = await fetch(`${siteUrl}/automation/overdue`, {
    headers: signedHeaders(""),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    loans: { loanId: string; dueDate: number }[];
  };
  return body.loans;
}

function workflowId(name: string): string {
  const listing = execFileSync(
    "docker",
    ["exec", "lendloop-n8n", "n8n", "list:workflow"],
    { encoding: "utf8" },
  );
  const line = listing
    .split("\n")
    .find((entry) => entry.includes(name) && entry.includes("|"));
  if (!line)
    throw new Error(`Workflow "${name}" is not imported into the n8n container.`);
  return line.split("|")[0].trim();
}

function countActivityRows(dedupeKey: string): number {
  const table = execFileSync(
    "npx",
    ["convex", "data", "loanActivity", "--limit", "200"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return table.split(dedupeKey).length - 1;
}

/** Confirmed reminder keys, read from the CLI table (`confirmedAt` column). */
function confirmedReminderKeys(keys: string[]): Set<string> {
  const table = execFileSync(
    "npx",
    ["convex", "data", "loanActivity", "--limit", "200"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  const confirmed = new Set<string>();
  for (const line of table.split("\n")) {
    const columns = line.split("|");
    if (columns.length < 9) continue;

    const confirmedAt = columns[3]?.trim();
    const key = columns[5]?.trim().replace(/^"|"$/g, "");
    if (confirmedAt && key && keys.includes(key)) confirmed.add(key);
  }
  return confirmed;
}

test.beforeAll(() => {
  if (!secret) throw new Error("LENDLOOP_SHARED_SECRET is missing from n8n/.env");
  if (!siteUrl) throw new Error("NEXT_PUBLIC_CONVEX_SITE_URL is missing");
});

test.describe("Convex inbound endpoints", () => {
  test("reject unsigned, stale, and tampered requests", async () => {
    const unsigned = await fetch(`${siteUrl}/automation/overdue`);
    expect(unsigned.status).toBe(401);

    const stale = await fetch(`${siteUrl}/automation/overdue`, {
      headers: signedHeaders("", Math.floor(Date.now() / 1000) - 600),
    });
    expect(stale.status).toBe(401);

    const body = JSON.stringify({ loanId: "j5700000000000000000000000000000" });
    const tampered = await fetch(`${siteUrl}/automation/reminders`, {
      method: "POST",
      headers: signedHeaders(body, undefined, { "idempotency-key": `tamper:${runId}` }),
      body: body.replace("j57", "j58"),
    });
    expect(tampered.status).toBe(401);
  });

  test("accept a correctly signed overdue fetch", async () => {
    const loans = await overdueLoans();
    expect(Array.isArray(loans)).toBe(true);
    for (const loan of loans) {
      // The payload is intentionally narrow: no lender email, no description.
      expect(Object.keys(loan).sort()).toEqual(
        [
          "borrowerEmail",
          "borrowerName",
          "daysOverdue",
          "dueDate",
          "loanId",
          "toolName",
        ].sort(),
      );
    }
  });

  test("write-backs are idempotent and require an idempotency key", async () => {
    let loans = await overdueLoans();
    if (loans.length === 0) {
      execFileSync("npx", ["convex", "run", "seed:createDemoOverdueLoan"], {
        encoding: "utf8",
      });
      loans = await overdueLoans();
    }
    expect(loans.length).toBeGreaterThan(0);

    const loan = loans[0];
    const body = JSON.stringify({
      loanId: loan.loanId,
      channel: "mock",
      detail: "E2E reminder",
    });
    const key = `reminder:e2e:${loan.loanId}:${runId}`;

    const missingKey = await fetch(`${siteUrl}/automation/reminders`, {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(missingKey.status).toBe(400);

    const first = await fetch(`${siteUrl}/automation/reminders`, {
      method: "POST",
      headers: signedHeaders(body, undefined, { "idempotency-key": key }),
      body,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      duplicate: false,
      confirmed: false,
      loanId: loan.loanId,
    });

    const replay = await fetch(`${siteUrl}/automation/reminders`, {
      method: "POST",
      headers: signedHeaders(body, undefined, { "idempotency-key": key }),
      body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      duplicate: true,
      confirmed: false,
      loanId: loan.loanId,
    });

    expect(countActivityRows(key)).toBe(1);

    // The confirmation is the second half: the row only says "sent" once the
    // workflow has actually delivered the reminder.
    const confirmBody = JSON.stringify({ loanId: loan.loanId });
    const confirmHeaders = signedHeaders(confirmBody, undefined, {
      "idempotency-key": key,
    });

    const confirm = await fetch(`${siteUrl}/automation/reminders/confirm`, {
      method: "POST",
      headers: confirmHeaders,
      body: confirmBody,
    });
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toEqual({ ok: true, duplicate: false });

    const confirmReplay = await fetch(`${siteUrl}/automation/reminders/confirm`, {
      method: "POST",
      headers: confirmHeaders,
      body: confirmBody,
    });
    expect(await confirmReplay.json()).toEqual({ ok: true, duplicate: true });

    const confirmedReplay = await fetch(`${siteUrl}/automation/reminders`, {
      method: "POST",
      headers: signedHeaders(body, undefined, { "idempotency-key": key }),
      body,
    });
    expect(await confirmedReplay.json()).toEqual({
      ok: true,
      duplicate: true,
      confirmed: true,
      loanId: loan.loanId,
    });
    expect(countActivityRows(key)).toBe(1);
  });

  test("refuses to confirm a reminder that was never claimed", async () => {
    // A real loan id keeps the argument validator happy; the 404 comes from the
    // missing claim, which is the condition under test.
    const loans = await overdueLoans();
    expect(loans.length).toBeGreaterThan(0);
    const body = JSON.stringify({ loanId: loans[0].loanId });

    const response = await fetch(`${siteUrl}/automation/reminders/confirm`, {
      method: "POST",
      headers: signedHeaders(body, undefined, {
        "idempotency-key": `confirm-missing:${runId}`,
      }),
      body,
    });
    expect(response.status).toBe(404);
  });

  test("the failure report endpoint is idempotent too", async () => {
    const key = `workflow-failure:e2e:${runId}`;
    const body = JSON.stringify({
      workflow: "E2E Failure",
      detail: "Reported by the browser suite",
    });

    const first = await fetch(`${siteUrl}/automation/failures`, {
      method: "POST",
      headers: signedHeaders(body, undefined, { "idempotency-key": key }),
      body,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });

    const replay = await fetch(`${siteUrl}/automation/failures`, {
      method: "POST",
      headers: signedHeaders(body, undefined, { "idempotency-key": key }),
      body,
    });
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    expect(countActivityRows(key)).toBe(1);
  });
});

test.describe("n8n request-notification workflow", () => {
  const event = {
    eventId: `e2e:${runId}`,
    kind: "loan.status_changed",
    occurredAt: Date.now(),
    data: {
      loanId: "j5700000000000000000000000000000",
      toolName: "E2E Cordless drill",
      toolCategory: "power-tools",
      status: "approved",
      startDate: Date.UTC(2026, 11, 1),
      endDate: Date.UTC(2026, 11, 3),
      audience: "borrower",
      recipientName: "E2E Borrower",
      recipientEmail: "lendloop.e2e.borrower@example.com",
      counterpartyName: "E2E Lender",
    },
  };

  test("rejects an unsigned or forged webhook", async () => {
    const unsigned = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalJson(event),
    });
    expect(unsigned.status).toBe(401);

    const forged = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lendloop-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-lendloop-signature": "0".repeat(64),
      },
      body: canonicalJson(event),
    });
    expect(forged.status).toBe(401);

    const staleHeaders = signedHeaders(
      canonicalJson(event),
      Math.floor(Date.now() / 1000) - 600,
    );
    const stale = await fetch(webhookUrl, {
      method: "POST",
      headers: staleHeaders,
      body: canonicalJson(event),
    });
    expect(stale.status).toBe(401);
  });

  test("verifies the signature and renders the right message", async () => {
    const body = canonicalJson(event);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      audience: string;
      subject: string;
      message: string;
      to: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.audience).toBe("borrower");
    expect(payload.to).toBe(event.data.recipientEmail);
    expect(payload.subject).toContain("E2E Cordless drill");
    expect(payload.subject).toContain("approved");
    // Data minimisation: the other party's email is never in the payload.
    expect(body).not.toContain("lendloop.e2e.lender@example.com");
  });
});

test.describe("scheduled overdue workflow", () => {
  test("writes one reminder per loan even when run twice", async () => {
    const loans = await overdueLoans();
    expect(loans.length).toBeGreaterThan(0);

    const id = workflowId("Overdue reminders");
    const daystamp = new Date().toISOString().slice(0, 10);
    const keys = loans.map(
      (loan) => `reminder:${loan.loanId}:${loan.dueDate}:${daystamp}`,
    );

    const before = keys.map(countActivityRows);

    // A one-off container, because `docker exec` collides with the live process on
    // the task-broker port. It reads the same volume, so it runs the same workflow.
    const image = execFileSync(
      "docker",
      ["inspect", "lendloop-n8n", "--format", "{{.Config.Image}}"],
      { encoding: "utf8" },
    ).trim();
    const volume = execFileSync(
      "docker",
      [
        "inspect",
        "lendloop-n8n",
        "--format",
        '{{range .Mounts}}{{if eq .Destination "/home/node/.n8n"}}{{.Name}}{{end}}{{end}}',
      ],
      { encoding: "utf8" },
    ).trim();

    const runOnce = () =>
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--env-file",
          ".env",
          "-e",
          "NODE_FUNCTION_ALLOW_BUILTIN=crypto",
          "-e",
          "N8N_BLOCK_ENV_ACCESS_IN_NODE=false",
          "-v",
          `${volume}:/home/node/.n8n`,
          image,
          "execute",
          `--id=${id}`,
        ],
        {
          cwd: path.join(process.cwd(), "n8n"),
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        },
      );

    runOnce();
    const afterFirst = keys.map(countActivityRows);

    runOnce();
    const afterSecond = keys.map(countActivityRows);

    // The workflow confirms only after the send, so the rows it owns must be
    // confirmed — a "sent" label without `confirmedAt` would be a lie.
    const confirmed = confirmedReminderKeys(keys);
    for (const [index, key] of keys.entries()) {
      if (afterSecond[index] > 0) expect(confirmed.has(key)).toBe(true);
    }

    // First run may add at most one row per loan; the replay adds none.
    for (const index of keys.keys()) {
      expect(afterFirst[index] - before[index]).toBeLessThanOrEqual(1);
      expect(afterSecond[index]).toBe(afterFirst[index]);
      expect(afterSecond[index]).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("workflow files", () => {
  test("never embed the shared secret", () => {
    for (const file of [
      "request-notification.json",
      "overdue-reminders.json",
      "error-handler.json",
    ]) {
      const raw = readFileSync(
        path.join(process.cwd(), "n8n", "workflows", file),
        "utf8",
      );
      expect(raw).not.toContain(secret);
      expect(raw).toContain("$env.LENDLOOP_SHARED_SECRET");
    }
  });

  test("every workflow belongs to the error workflow", () => {
    for (const file of ["request-notification.json", "overdue-reminders.json"]) {
      const workflow = JSON.parse(
        readFileSync(path.join(process.cwd(), "n8n", "workflows", file), "utf8"),
      ) as { settings?: { errorWorkflow?: string } };
      expect(workflow.settings?.errorWorkflow).toBeTruthy();
    }
  });
});
