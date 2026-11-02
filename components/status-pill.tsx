import { Badge } from "@/components/ui/badge";
import { LOAN_STATUS_LABELS, type LoanStatus } from "@/lib/labels";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<LoanStatus, string> = {
  pending:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  approved:
    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  declined: "border-border bg-muted text-muted-foreground",
  cancelled: "border-border bg-muted text-muted-foreground",
  returned:
    "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
};

export function StatusPill({
  status,
  overdue = false,
}: {
  status: LoanStatus;
  overdue?: boolean;
}) {
  if (overdue) {
    return (
      <Badge
        variant="outline"
        className="border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
      >
        Overdue
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={cn(STATUS_STYLES[status])}>
      {LOAN_STATUS_LABELS[status]}
    </Badge>
  );
}

export function AvailabilityPill({
  state,
  until,
  formatDate,
}: {
  state: "available" | "lent";
  until: number | null;
  formatDate: (timestamp: number) => string;
}) {
  if (state === "available") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
      >
        Available
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
    >
      {until ? `Lent until ${formatDate(until)}` : "Lent"}
    </Badge>
  );
}

export function TrustedPill() {
  return (
    <Badge
      variant="outline"
      className="border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300"
    >
      Trusted lender
    </Badge>
  );
}
