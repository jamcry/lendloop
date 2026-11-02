"use client";

import { useMutation, useQuery } from "convex/react";
import { Inbox } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusPill, TrustedPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRange } from "@/lib/dates";
import { errorMessage } from "@/lib/errors";

export function MyRequests() {
  const requests = useQuery(api.loans.myRequests);
  const cancel = useMutation(api.loans.cancel);

  if (requests === undefined) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (requests.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-sm">
        <Inbox className="size-6" aria-hidden />
        <p>You haven&apos;t asked to borrow anything yet.</p>
        <Button asChild size="sm" variant="outline">
          <Link href="/browse">Browse the board</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tool</TableHead>
            <TableHead>Dates</TableHead>
            <TableHead>Lender</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.map((request) => (
            <TableRow key={request.id}>
              <TableCell className="max-w-[16rem]">
                <Link
                  href={`/tools/${request.toolId}`}
                  className="truncate font-medium hover:underline"
                >
                  {request.toolName}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">
                {formatRange(request.startDate, request.endDate)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                <span className="flex items-center gap-2 whitespace-nowrap">
                  {request.ownerName}
                  {request.ownerTrustedLender ? <TrustedPill /> : null}
                </span>
              </TableCell>
              <TableCell>
                <StatusPill status={request.status} overdue={request.overdue} />
              </TableCell>
              <TableCell className="text-right">
                {request.status === "pending" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await cancel({ loanId: request.id as Id<"loans"> });
                        toast.success("Request withdrawn.");
                      } catch (error) {
                        toast.error(errorMessage(error));
                      }
                    }}
                  >
                    Withdraw
                  </Button>
                ) : (
                  <span className="text-muted-foreground/60 text-xs">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
