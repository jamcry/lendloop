import { ConvexError } from "convex/values";

/**
 * Convex sends `ConvexError` payloads verbatim to the client, which is how the
 * friendly validation messages written in `convex/` reach the UI. Anything else
 * is an unexpected failure and gets a neutral message.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    return typeof error.data === "string" ? error.data : error.message;
  }
  if (error instanceof Error && error.message) {
    // Strip Convex's transport noise, e.g. `[CONVEX M(loans:request)] ...`.
    return error.message
      .replace(/^\[CONVEX [^\]]+\]\s*/, "")
      .replace(/^\[Request ID: [^\]]+\]\s*/, "");
  }
  return "Something went wrong. Please try again.";
}
