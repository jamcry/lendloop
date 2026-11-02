/**
 * Display labels for the enums in `convex/schema.ts`.
 *
 * Convex can only bundle files inside `convex/`, so these can't be imported from
 * the schema module. `convex/lendloop.test.ts` asserts the two lists stay in
 * sync, so adding a category without a label fails a test rather than rendering
 * a raw slug in the UI.
 */

export const CATEGORY_LABELS = {
  "power-tools": "Power tools",
  garden: "Garden",
  kitchen: "Kitchen",
  camping: "Camping",
  cleaning: "Cleaning",
  automotive: "Automotive",
  other: "Other",
} as const;

export const CATEGORY_ORDER = [
  "power-tools",
  "garden",
  "kitchen",
  "camping",
  "cleaning",
  "automotive",
  "other",
] as const;

export const CONDITION_LABELS = {
  new: "Like new",
  good: "Good",
  fair: "Fair",
  worn: "Well used",
} as const;

export const LOAN_STATUS_LABELS = {
  pending: "Pending",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
  returned: "Returned",
} as const;

export type Category = keyof typeof CATEGORY_LABELS;
export type Condition = keyof typeof CONDITION_LABELS;
export type LoanStatus = keyof typeof LOAN_STATUS_LABELS;

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as Category] ?? category;
}

export function conditionLabel(condition: string): string {
  return CONDITION_LABELS[condition as Condition] ?? condition;
}
