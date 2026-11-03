"use client";

import { useQuery } from "convex/react";
import { BellRing, CircleAlert, CircleCheck, MailCheck } from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";

/**
 * Automation trail for one loan, e.g. "Reminder sent 2 days ago".
 *
 * Rendered from `loanActivity`, which n8n writes back through a signed, idempotent
 * endpoint — so this is real delivery history, not a guess derived from dates.
 */
const KIND_META = {
  "reminder.sent": { label: "Reminder sent", icon: BellRing, tone: "text-sky-600" },
  "notification.sent": {
    label: "Notification delivered",
    icon: MailCheck,
    tone: "text-emerald-600",
  },
  "notification.failed": {
    label: "Notification failed",
    icon: CircleAlert,
    tone: "text-red-600",
  },
  "workflow.failed": {
    label: "Workflow failed",
    icon: CircleAlert,
    tone: "text-red-600",
  },
} as const;

type ActivityKind = keyof typeof KIND_META;

export function LoanActivity({
  loanId,
  compact = false,
}: {
  loanId: Id<"loans">;
  compact?: boolean;
}) {
  const rows = useQuery(api.automation.activityForLoan, { loanId });

  if (rows === undefined) {
    return <Skeleton className="h-10 w-full rounded-md" />;
  }

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No automation activity yet. Notifications appear here once n8n runs.
      </p>
    );
  }

  return (
    <ul className={cn("space-y-2", compact && "space-y-1")}>
      {rows.map((row) => {
        const meta = KIND_META[row.kind as ActivityKind] ?? {
          label: row.kind,
          icon: CircleCheck,
          tone: "text-muted-foreground",
        };
        const Icon = meta.icon;

        return (
          <li key={row._id} className="flex items-start gap-2 text-xs">
            <Icon className={cn("mt-0.5 size-3.5 shrink-0", meta.tone)} aria-hidden />
            <div className="min-w-0">
              <p className="text-foreground">
                {meta.label}
                <span className="text-muted-foreground">
                  {" "}
                  · {relativeTime(row.createdAt)}
                </span>
              </p>
              {compact ? null : (
                <p className="text-muted-foreground truncate">{row.detail}</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
