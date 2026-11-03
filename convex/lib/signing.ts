/**
 * HMAC signing for the n8n integration, in both directions.
 *
 * Scheme: `signature = HMAC_SHA256(secret, timestamp + "." + canonicalJson(body))`, hex
 * encoded. The timestamp is inside the signed string, so a captured body cannot
 * be replayed with a fresh timestamp. Receivers reject anything outside a
 * five-minute window.
 *
 * Uses Web Crypto, which is what the Convex runtime provides, so the same code
 * runs for outbound signing (action) and inbound verification (httpAction).
 */

const encoder = new TextEncoder();

export const TIMESTAMP_HEADER = "x-lendloop-timestamp";
export const SIGNATURE_HEADER = "x-lendloop-signature";
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** How long a signed request stays valid. */
export const REPLAY_WINDOW_MS = 5 * 60_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deterministic JSON: object keys sorted, no whitespace.
 *
 * The receiver of a webhook gets parsed JSON, not our original bytes, so the two
 * sides cannot agree on a raw string. Canonical form makes the signature
 * independent of key order and spacing. n8n implements the same function in the
 * workflow's Code node.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(signature);
}

/** Length-independent comparison, so a wrong digit doesn't leak through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export type VerificationResult =
  { ok: true } | { ok: false; reason: "missing" | "stale" | "invalid" };

/**
 * Verifies an inbound request. Returns a reason rather than throwing so the HTTP
 * handler can answer 401 with a short explanation — useful in n8n's execution
 * log when a signature is misconfigured.
 */
export async function verifyRequestSignature({
  secret,
  timestamp,
  signature,
  body,
  now = Date.now(),
  windowMs = REPLAY_WINDOW_MS,
}: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number;
  windowMs?: number;
}): Promise<VerificationResult> {
  if (!timestamp || !signature) return { ok: false, reason: "missing" };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "invalid" };

  if (Math.abs(now - seconds * 1000) > windowMs) return { ok: false, reason: "stale" };

  const expected = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return constantTimeEqual(expected, signature)
    ? { ok: true }
    : { ok: false, reason: "invalid" };
}

/** Headers for an outbound signed request. */
export async function signedHeaders(
  secret: string,
  body: string,
  now = Date.now(),
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(now / 1000));
  const signature = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signature,
  };
}
