import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyRequestSignature,
} from "./lib/signing";

/**
 * Inbound automation endpoints.
 *
 * n8n is an external system with its own credentials and its own bugs, so
 * everything it sends is treated as untrusted input: the signature is verified
 * over the raw body *before* parsing, and no endpoint can do anything except
 * append activity for a loan that already exists.
 *
 * The integration fails closed when `LENDLOOP_SHARED_SECRET` is unset — an
 * unsigned endpoint is worse than an unavailable one.
 */

const http = httpRouter();

const JSON_HEADERS = { "content-type": "application/json" };

/** Nothing n8n sends is large; refuse anything bigger before parsing it. */
const MAX_BODY_BYTES = 32 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

type Verification = { ok: true } | { ok: false; response: Response };

async function verifySignature(request: Request, body: string): Promise<Verification> {
  const secret = process.env.LENDLOOP_SHARED_SECRET;

  if (!secret) {
    return {
      ok: false,
      response: json(
        { error: "LENDLOOP_SHARED_SECRET is not configured on this deployment." },
        503,
      ),
    };
  }

  const result = await verifyRequestSignature({
    secret,
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_HEADER),
    body,
  });

  if (!result.ok) {
    return { ok: false, response: json({ error: `Signature ${result.reason}.` }, 401) };
  }

  return { ok: true };
}

/** Returns the idempotency key, or a 400 response. */
function requireIdempotencyKey(
  request: Request,
): { key: string } | { response: Response } {
  const key = request.headers.get(IDEMPOTENCY_HEADER)?.trim();
  if (!key) {
    return {
      response: json({ error: `An ${IDEMPOTENCY_HEADER} header is required.` }, 400),
    };
  }
  if (key.length > 200) {
    return {
      response: json(
        { error: `${IDEMPOTENCY_HEADER} must be 200 characters or fewer.` },
        400,
      ),
    };
  }
  return { key };
}

/**
 * GET /automation/overdue
 *
 * Consumed by the scheduled reminder workflow. GET has no body, so the empty
 * string is what gets signed.
 */
http.route({
  path: "/automation/overdue",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const verification = await verifySignature(request, "");
    if (!verification.ok) return verification.response;

    const loans = await ctx.runQuery(internal.automation.overdueLoans, {});
    return json({ loans, count: loans.length });
  }),
});

/**
 * POST /automation/reminders
 *
 * Idempotent write-back. A replayed delivery returns `{ duplicate: true }` with
 * 200 rather than an error, because for n8n a retry that already succeeded is a
 * success, not a conflict.
 */
http.route({
  path: "/automation/reminders",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return json({ error: "Body too large." }, 413);
    }

    const verification = await verifySignature(request, body);
    if (!verification.ok) return verification.response;

    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;

    let parsed: { loanId?: unknown; channel?: unknown; detail?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }

    if (typeof parsed.loanId !== "string" || !parsed.loanId) {
      return json({ error: "loanId is required." }, 400);
    }

    const channel = typeof parsed.channel === "string" ? parsed.channel : "email";
    const detail =
      typeof parsed.detail === "string" && parsed.detail.trim()
        ? parsed.detail
        : "Overdue reminder sent";

    try {
      const result = await ctx.runMutation(internal.automation.recordReminder, {
        loanId: parsed.loanId as never,
        idempotencyKey: key.key,
        channel,
        detail,
      });

      if ("conflict" in result && result.conflict) {
        return json(
          { error: "This Idempotency-Key was already used for a different loan." },
          409,
        );
      }

      return json({ ok: true, duplicate: result.duplicate });
    } catch {
      // Covers an unknown or malformed loan id. The signature already proved the
      // caller is n8n, so this is data quality, not an auth failure.
      return json({ error: "Unknown loan." }, 404);
    }
  }),
});

/**
 * POST /automation/failures
 *
 * Called by the n8n error workflow. Keeps failures visible in the app instead of
 * only inside n8n's execution history.
 */
http.route({
  path: "/automation/failures",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return json({ error: "Body too large." }, 413);
    }

    const verification = await verifySignature(request, body);
    if (!verification.ok) return verification.response;

    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;

    let parsed: { workflow?: unknown; detail?: unknown; loanId?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }

    try {
      const result = await ctx.runMutation(internal.automation.recordWorkflowFailure, {
        idempotencyKey: key.key,
        workflow: typeof parsed.workflow === "string" ? parsed.workflow : "unknown",
        detail: typeof parsed.detail === "string" ? parsed.detail : "Workflow failed",
        loanId: typeof parsed.loanId === "string" ? (parsed.loanId as never) : undefined,
      });

      return json({ ok: true, duplicate: result.duplicate });
    } catch {
      // A loan id that does not exist is a caller error, not a server fault.
      return json({ error: "Unknown loan." }, 404);
    }
  }),
});

export default http;
