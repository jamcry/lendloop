"use client";

import { useMutation, useQuery } from "convex/react";
import { Check, Inbox, Undo2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRange } from "@/lib/dates";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "pending", label: "Pending" },
  { key: "active", label: "On loan" },
  { key: "history", label: "History" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function IncomingRequests() {
  const loans = useQuery(api.loans.incoming);
  const decide = useMutation(api.loans.decide);
  const markReturned = useMutation(api.loans.markReturned);
  const [tab, setTab] = useState<TabKey>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);

  if (loans === undefined) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  const filtered = loans.filter((loan) => {
    if (tab === "pending") return loan.status === "pending";
    if (tab === "active") return loan.status === "approved";
    return ["declined", "cancelled", "returned"].includes(loan.status);
  });

  const counts = {
    pending: loans.filter((loan) => loan.status === "pending").length,
    active: loans.filter((loan) => loan.status === "approved").length,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            aria-pressed={tab === item.key}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm transition-colors",
              tab === item.key
                ? "bg-foreground text-background border-transparent"
                : "text-muted-foreground hover:text-foreground hover:border-foreground/30",
            )}
          >
            {item.label}
            {item.key !== "history" && counts[item.key] > 0 ? (
              <span className="ml-1.5 font-mono text-xs opacity-70">
                {counts[item.key]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-sm">
          <Inbox className="size-6" aria-hidden />
          <p>
            {tab === "pending"
              ? "No requests waiting on you."
              : tab === "active"
                ? "Nothing of yours is out on loan."
                : "No past requests yet."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((loan) => (
            <Card key={loan.id} className="py-0">
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/tools/${loan.toolId}`}
                      className="font-medium hover:underline"
                    >
                      {loan.toolName}
                    </Link>
                    <StatusPill status={loan.status} overdue={loan.overdue} />
                  </div>
                  <p className="text-muted-foreground text-sm">
                    {loan.borrowerName} · {formatRange(loan.startDate, loan.endDate)}
                  </p>
                  {loan.message ? (
                    <p className="text-muted-foreground border-l-2 pl-3 text-xs italic">
                      “{loan.message}”
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center gap-1">
                  {loan.status === "pending" ? (
                    <>
                      <Button
                        size="sm"
                        disabled={busyId === loan.id}
                        onClick={async () => {
                          setBusyId(loan.id);
                          try {
                            await decide({
                              loanId: loan.id as Id<"loans">,
                              decision: "approved",
                            });
                            toast.success("Approved. The tool is reserved.");
                          } catch (error) {
                            toast.error(errorMessage(error));
                          } finally {
                            setBusyId(null);
                          }
                        }}
                      >
                        <Check className="size-3.5" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === loan.id}
                        onClick={async () => {
                          setBusyId(loan.id);
                          try {
                            await decide({
                              loanId: loan.id as Id<"loans">,
                              decision: "declined",
                            });
                            toast.success("Request declined.");
                          } catch (error) {
                            toast.error(errorMessage(error));
                          } finally {
                            setBusyId(null);
                          }
                        }}
                      >
                        <X className="size-3.5" />
                        Decline
                      </Button>
                    </>
                  ) : null}

                  {loan.status === "approved" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === loan.id}
                      onClick={async () => {
                        setBusyId(loan.id);
                        try {
                          await markReturned({ loanId: loan.id as Id<"loans"> });
                          toast.success("Marked as returned.");
                        } catch (error) {
                          toast.error(errorMessage(error));
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      <Undo2 className="size-3.5" />
                      Mark returned
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
