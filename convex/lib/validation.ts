import { ConvexError } from "convex/values";

/**
 * Pure input-validation helpers.
 *
 * Kept free of `ctx` so they can be unit-tested directly, and so every mutation
 * validates the same way instead of hand-rolling checks.
 */

export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_MESSAGE_LENGTH = 300;
export const MAX_LOAN_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ConvexError (rather than Error) so the message is forwarded to the client as
 * structured data. Plain Error text is redacted in production, which would turn
 * every bad-input rejection into an opaque "Server Error".
 */
export function invalidInput(message: string): never {
  throw new ConvexError(message);
}

/** Trim, reject empty, reject overlong. Returns the value to persist. */
export function cleanText(
  value: string,
  { field, max, required = true }: { field: string; max: number; required?: boolean },
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) invalidInput(`${field} is required.`);
    return "";
  }
  if (trimmed.length > max) {
    invalidInput(`${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

/** Midnight UTC for a given instant. Loan dates are whole days, not times. */
export function startOfUtcDay(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

export function todayUtc(now = Date.now()): number {
  return startOfUtcDay(now);
}

/**
 * Loan ranges are inclusive whole days in UTC.
 *
 * Rejected: missing/NaN values, reversed ranges, ranges longer than
 * MAX_LOAN_DAYS, and starts before today (a request cannot begin in the past).
 */
export function assertLoanRange(startDate: number, endDate: number, now = Date.now()): void {
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) {
    invalidInput("Start and end dates are required.");
  }

  const start = startOfUtcDay(startDate);
  const end = startOfUtcDay(endDate);
  const today = todayUtc(now);

  if (end < start) {
    invalidInput("The return date must be on or after the start date.");
  }
  if (start < today) {
    invalidInput("The start date cannot be in the past.");
  }

  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > MAX_LOAN_DAYS) {
    invalidInput(`A request can cover at most ${MAX_LOAN_DAYS} days.`);
  }
}

/** Inclusive overlap of two whole-day ranges. */
export function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
