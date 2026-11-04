/**
 * Loan dates are whole days in UTC, so all formatting here is pinned to UTC.
 * Keeping it explicit avoids the classic off-by-one where a date shifts for a
 * user in a negative-offset timezone.
 */

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD` for an `<input type="date">`. */
export function toDateInput(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Parses `YYYY-MM-DD` into UTC midnight. Returns null for incomplete input. */
export function fromDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateWithYear(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Mar 4" or "Mar 4 – Mar 6" when the range spans days. */
export function formatRange(startDate: number, endDate: number): string {
  if (startDate === endDate) return formatDate(startDate);
  return `${formatDate(startDate)} – ${formatDate(endDate)}`;
}

/** "2 days ago", "just now" — for the audit trail. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;

  return formatDateWithYear(timestamp);
}

/** "in 30 min" for a scheduled retry. `relativeTime` would say "just now". */
export function relativeFuture(timestamp: number, now = Date.now()): string {
  const minutes = Math.round((timestamp - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;

  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}
