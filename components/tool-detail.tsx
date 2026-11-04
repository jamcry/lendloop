"use client";

import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, CalendarDays, PackageOpen, UserRound } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LoanActivity } from "@/components/loan-activity";
import { AvailabilityPill, StatusPill, TrustedPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatRange, fromDateInput, toDateInput } from "@/lib/dates";
import { errorMessage } from "@/lib/errors";
import { categoryLabel, conditionLabel } from "@/lib/labels";

const DAY = 86_400_000;

export function ToolDetail({ toolId }: { toolId: Id<"tools"> }) {
  const tool = useQuery(api.tools.get, { id: toolId });
  const myLoan = useQuery(api.loans.forTool, { toolId });

  if (tool === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-52 w-full rounded-xl" />
      </div>
    );
  }

  if (tool === null) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <PackageOpen className="text-muted-foreground size-7" />
        <h1 className="font-medium">This listing does not exist</h1>
        <Button asChild variant="outline" size="sm">
          <Link href="/browse">Back to the board</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
          <Link href="/browse">
            <ArrowLeft className="size-4" />
            All tools
          </Link>
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
              {categoryLabel(tool.category)}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">{tool.name}</h1>
            <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
              <UserRound className="size-3.5" />
              <span>{tool.ownerName}</span>
              {tool.isMine ? (
                <span className="text-foreground font-medium">· Your listing</span>
              ) : null}
              {tool.ownerTrustedLender ? <TrustedPill /> : null}
              <span aria-hidden>·</span>
              <span>{conditionLabel(tool.condition)}</span>
            </div>
          </div>
          <AvailabilityPill
            state={tool.availability.state}
            until={tool.availability.until}
            overdue={tool.availability.overdue}
            formatDate={formatDate}
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card className="py-0">
          <CardContent className="p-6">
            <h2 className="text-sm font-medium">About this tool</h2>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed whitespace-pre-line">
              {tool.description}
            </p>

            {tool.upcomingLoans.length > 0 ? (
              <div className="mt-6 space-y-2">
                <h3 className="text-muted-foreground flex items-center gap-2 font-mono text-[11px] tracking-wider uppercase">
                  <CalendarDays className="size-3.5" />
                  Already booked
                </h3>
                <ul className="space-y-1 text-sm">
                  {tool.upcomingLoans.map((loan) => (
                    <li key={loan.startDate} className="text-muted-foreground">
                      {formatRange(loan.startDate, loan.endDate)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {tool.archivedAt ? (
            <Card className="py-0">
              <CardContent className="space-y-2 p-6">
                <h2 className="text-sm font-medium">This listing was removed</h2>
                <p className="text-muted-foreground text-sm">
                  It is no longer available to borrow. If you already have a request on
                  it, the lender can still decline it.
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href="/browse">Browse other tools</Link>
                </Button>
              </CardContent>
            </Card>
          ) : tool.isMine ? (
            <Card className="py-0">
              <CardContent className="space-y-3 p-6">
                <h2 className="text-sm font-medium">This is your tool</h2>
                <p className="text-muted-foreground text-sm">
                  Manage it, or review requests from neighbors.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href="/my-listings">My listings</Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href="/incoming">Incoming requests</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              {myLoan ? <MyRequestCard loan={myLoan} /> : null}

              {tool.availability.state === "lent" && tool.availability.overdue ? (
                <Card className="py-0">
                  <CardContent className="space-y-2 p-6">
                    <h2 className="text-sm font-medium">Still out on loan</h2>
                    <p className="text-muted-foreground text-sm">
                      This tool is past its return date. Requests reopen when the lender
                      marks it returned.
                    </p>
                  </CardContent>
                </Card>
              ) : !myLoan ||
                myLoan.status === "declined" ||
                myLoan.status === "returned" ||
                myLoan.status === "cancelled" ? (
                <RequestForm toolId={toolId} upcomingLoans={tool.upcomingLoans} />
              ) : null}
            </>
          )}

          <p className="text-muted-foreground px-1 text-xs leading-relaxed">
            LendLoop does not handle payment, deposits, or delivery. Arrange handover with
            your neighbor once a request is approved.
          </p>
        </div>
      </div>
    </div>
  );
}

type ToolLoan = {
  id: Id<"loans">;
  startDate: number;
  endDate: number;
  status: "pending" | "approved" | "declined" | "cancelled" | "returned";
  overdue: boolean;
  returnedAt: number | null;
};

/**
 * The borrower's loan on this tool.
 *
 * Kept visible for every status, not only pending/approved, so the automation
 * trail does not vanish the moment a loan is returned or declined.
 */
function MyRequestCard({ loan }: { loan: ToolLoan }) {
  const copy =
    loan.status === "returned"
      ? loan.returnedAt
        ? `Returned on ${formatDate(loan.returnedAt)}.`
        : "The lender marked this returned."
      : {
          pending: "Waiting for the lender to respond.",
          approved: "The lender approved this. Collect it on the start date.",
          declined: "The lender declined this request.",
          cancelled: "You withdrew this request.",
          returned: "",
        }[loan.status];

  return (
    <Card className="py-0">
      <CardHeader>
        <CardTitle className="text-sm">Your request</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {formatRange(loan.startDate, loan.endDate)}
          </span>
          <StatusPill status={loan.status} overdue={loan.overdue} />
        </div>
        <p className="text-muted-foreground text-xs">{copy}</p>
        {loan.status === "pending" ? <CancelButton loanId={loan.id} /> : null}

        <div className="space-y-2 border-t pt-3">
          <p className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
            Automation
          </p>
          <LoanActivity loanId={loan.id} compact />
        </div>
      </CardContent>
    </Card>
  );
}

function CancelButton({ loanId }: { loanId: Id<"loans"> }) {
  const cancel = useMutation(api.loans.cancel);
  const [busy, setBusy] = useState(false);

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await cancel({ loanId });
          toast.success("Request withdrawn.");
        } catch (error) {
          toast.error(errorMessage(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      Withdraw request
    </Button>
  );
}

function RequestForm({
  toolId,
  upcomingLoans,
}: {
  toolId: Id<"tools">;
  upcomingLoans: { startDate: number; endDate: number }[];
}) {
  const request = useMutation(api.loans.request);
  // Captured once at mount: `Date.now()` is impure and must not run on every render.
  const [today] = useState(() => Date.now());
  const [start, setStart] = useState(() => toDateInput(Date.now() + DAY));
  const [end, setEnd] = useState(() => toDateInput(Date.now() + 3 * DAY));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // Same inclusive overlap rule the mutation applies, so the obvious conflicts
  // are caught before a round-trip.
  const startDate = fromDateInput(start);
  const endDate = fromDateInput(end);
  const conflict =
    startDate !== null && endDate !== null && startDate <= endDate
      ? upcomingLoans.find(
          (loan) => startDate <= loan.endDate && loan.startDate <= endDate,
        )
      : undefined;

  return (
    <Card className="py-0">
      <CardHeader>
        <CardTitle className="text-sm">Request to borrow</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();

            if (startDate === null || endDate === null) {
              toast.error("Pick both dates.");
              return;
            }
            if (conflict) {
              toast.error("Those dates overlap an approved booking.");
              return;
            }

            setBusy(true);
            try {
              await request({
                toolId,
                startDate,
                endDate,
                message: message.trim() || undefined,
              });
              toast.success("Request sent to the lender.");
            } catch (error) {
              toast.error(errorMessage(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="start-date">From</Label>
              <Input
                id="start-date"
                type="date"
                value={start}
                min={toDateInput(today)}
                onChange={(event) => setStart(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="end-date">Until</Label>
              <Input
                id="end-date"
                type="date"
                value={end}
                min={start}
                onChange={(event) => setEnd(event.target.value)}
                required
              />
            </div>
          </div>

          {conflict ? (
            <p
              role="status"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
            >
              Those dates overlap an approved booking (
              {formatRange(conflict.startDate, conflict.endDate)}). Pick another range.
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="message">Note to the lender (optional)</Label>
            <Textarea
              id="message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="What are you working on?"
              rows={3}
              maxLength={300}
            />
          </div>

          <Button type="submit" className="w-full" disabled={busy || Boolean(conflict)}>
            {busy ? "Sending…" : conflict ? "Dates unavailable" : "Send request"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
