import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";

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
const encoder = new TextEncoder();

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

/**
 * Maps a failed write-back to the right status.
 *
 * Both cases are caller errors, but they surface differently: a malformed id is
 * rejected by the validator before the handler runs, while a well-formed id that
 * points at nothing reaches the handler. Anything else is a real fault and must
 * stay a 500 so n8n retries instead of dropping it.
 */
function writeBackErrorResponse(error: unknown): Response | null {
  if (
    error instanceof ConvexError &&
    (error.data === "Unknown loan." || error.data === "Unknown reminder.")
  ) {
    return json({ error: error.data }, 404);
  }
  // The runtime phrases this differently in tests ("Validator error") than in a
  // deployment ("ArgumentValidationError"), so match on the family, not one string.
  if (
    error instanceof Error &&
    /argumentvalidation|validator error/i.test(error.message)
  ) {
    return json({ error: "Invalid loanId." }, 400);
  }
  return null;
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

type SignedJson =
  | { ok: true; key: string; parsed: Record<string, unknown> }
  | { ok: false; response: Response };

/**
 * Size cap → signature → idempotency key → parse, in that order.
 *
 * Shared by every POST endpoint so a new write-back cannot accidentally skip the
 * signature check or parse a body before verifying it.
 */
async function readSignedJson(request: Request): Promise<SignedJson> {
  const body = await request.text();
  if (encoder.encode(body).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: "Body too large." }, 413) };
  }

  const verification = await verifySignature(request, body);
  if (!verification.ok) return { ok: false, response: verification.response };

  const key = requireIdempotencyKey(request);
  if ("response" in key) return { ok: false, response: key.response };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, response: json({ error: "Body must be JSON." }, 400) };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: json({ error: "Body must be a JSON object." }, 400),
    };
  }

  return { ok: true, key: key.key, parsed: parsed as Record<string, unknown> };
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
 * The claim half of the reminder protocol. The row is written before the send so
 * a retry cannot create a second reminder; it stays unconfirmed until the
 * workflow calls `/automation/reminders/confirm`. A replay returns
 * `{ duplicate: true }` with 200 rather than an error, because for n8n a retry
 * that already succeeded is a success, not a conflict.
 */
http.route({
  path: "/automation/reminders",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const read = await readSignedJson(request);
    if (!read.ok) return read.response;

    const { parsed, key } = read;
    if (typeof parsed.loanId !== "string" || !parsed.loanId) {
      return json({ error: "loanId is required." }, 400);
    }

    const channel = typeof parsed.channel === "string" ? parsed.channel : "email";
    const detail =
      typeof parsed.detail === "string" && parsed.detail.trim()
        ? parsed.detail
        : "Overdue reminder";

    try {
      const result = await ctx.runMutation(internal.automation.recordReminder, {
        loanId: parsed.loanId as never,
        idempotencyKey: key,
        channel,
        detail,
      });

      if (result.conflict) {
        return json(
          { error: "This Idempotency-Key was already used for a different loan." },
          409,
        );
      }

      return json({
        ok: true,
        duplicate: result.duplicate,
        confirmed: result.confirmed,
        loanId: parsed.loanId,
      });
    } catch (error) {
      const response = writeBackErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }),
});

/**
 * POST /automation/reminders/confirm
 *
 * The second half: called after the workflow has actually sent the reminder.
 * Same idempotency key as the claim, so a retried confirmation patches the same
 * row. Confirming a reminder that was never claimed is a 404 — n8n must not be
 * able to invent activity for arbitrary loans.
 */
http.route({
  path: "/automation/reminders/confirm",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const read = await readSignedJson(request);
    if (!read.ok) return read.response;

    const { parsed, key } = read;
    if (typeof parsed.loanId !== "string" || !parsed.loanId) {
      return json({ error: "loanId is required." }, 400);
    }

    try {
      const result = await ctx.runMutation(internal.automation.confirmReminder, {
        loanId: parsed.loanId as never,
        idempotencyKey: key,
      });

      if (result.conflict) {
        return json(
          { error: "This Idempotency-Key was already used for a different loan." },
          409,
        );
      }

      return json({ ok: true, duplicate: result.duplicate });
    } catch (error) {
      const response = writeBackErrorResponse(error);
      if (response) return response;
      throw error;
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
    const read = await readSignedJson(request);
    if (!read.ok) return read.response;

    const { parsed, key } = read;

    try {
      const result = await ctx.runMutation(internal.automation.recordWorkflowFailure, {
        idempotencyKey: key,
        workflow: typeof parsed.workflow === "string" ? parsed.workflow : "unknown",
        detail: typeof parsed.detail === "string" ? parsed.detail : "Workflow failed",
        loanId: typeof parsed.loanId === "string" ? (parsed.loanId as never) : undefined,
      });

      return json({ ok: true, duplicate: result.duplicate });
    } catch (error) {
      const response = writeBackErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }),
});

export default http;
