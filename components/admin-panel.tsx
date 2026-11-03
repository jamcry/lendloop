"use client";

import { useMutation, useQuery } from "convex/react";
import { Archive, ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRange, relativeTime } from "@/lib/dates";
import { errorMessage } from "@/lib/errors";
import { categoryLabel } from "@/lib/labels";

export function AdminPanel() {
  const viewer = useQuery(api.users.me);

  if (viewer === undefined) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }

  if (viewer?.role !== "admin") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center">
        <ShieldAlert className="text-muted-foreground size-6" />
        <h2 className="font-medium">Administrator access required</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          This area is restricted. The server enforces the same rule, so this page is not
          the only thing standing in the way.
        </p>
      </div>
    );
  }

  return (
    <Tabs defaultValue="overview" className="space-y-6">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="listings">Listings</TabsTrigger>
        <TabsTrigger value="loans">Loans</TabsTrigger>
        <TabsTrigger value="users">Users</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="automation">Automation</TabsTrigger>
      </TabsList>

      <TabsContent value="overview">
        <Overview />
      </TabsContent>
      <TabsContent value="listings">
        <ListingsTable />
      </TabsContent>
      <TabsContent value="loans">
        <LoansTable />
      </TabsContent>
      <TabsContent value="users">
        <UsersTable />
      </TabsContent>
      <TabsContent value="activity">
        <ActivityFeed />
      </TabsContent>
      <TabsContent value="automation">
        <AutomationFeed />
      </TabsContent>
    </Tabs>
  );
}

function Overview() {
  const stats = useQuery(api.admin.overview);
  if (stats === undefined) return <Skeleton className="h-32 w-full rounded-xl" />;

  const items = [
    { label: "Active listings", value: stats.listings },
    { label: "Removed listings", value: stats.archived },
    { label: "Pending requests", value: stats.pendingRequests },
    { label: "Active loans", value: stats.activeLoans },
    { label: "Members", value: stats.users },
    { label: "Trusted lenders", value: stats.trustedLenders },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <Card key={item.label} className="py-0">
          <CardContent className="p-5">
            <p className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
              {item.label}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{item.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ListingsTable() {
  const tools = useQuery(api.admin.allTools);
  const archiveTool = useMutation(api.admin.archiveTool);

  if (tools === undefined) return <Skeleton className="h-48 w-full rounded-xl" />;

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tool</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tools.map((tool) => (
            <TableRow key={tool.id}>
              <TableCell className="font-medium">{tool.name}</TableCell>
              <TableCell className="text-muted-foreground">
                {categoryLabel(tool.category)}
              </TableCell>
              <TableCell className="text-muted-foreground">{tool.ownerName}</TableCell>
              <TableCell>
                {tool.archivedAt ? (
                  <span className="text-muted-foreground font-mono text-[11px] uppercase">
                    Removed
                  </span>
                ) : (
                  <span className="text-xs text-emerald-700 dark:text-emerald-400">
                    Live
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right">
                {tool.archivedAt ? (
                  <span className="text-muted-foreground/60 text-xs">—</span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await archiveTool({ toolId: tool.id });
                        toast.success("Listing removed.");
                      } catch (error) {
                        toast.error(errorMessage(error));
                      }
                    }}
                  >
                    <Archive className="size-3.5" />
                    Remove
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LoansTable() {
  const loans = useQuery(api.admin.allLoans);
  if (loans === undefined) return <Skeleton className="h-48 w-full rounded-xl" />;

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tool</TableHead>
            <TableHead>Borrower</TableHead>
            <TableHead>Lender</TableHead>
            <TableHead>Dates</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loans.map((loan) => (
            <TableRow key={loan.id}>
              <TableCell>
                <Link
                  href={`/tools/${loan.toolId}`}
                  className="font-medium hover:underline"
                >
                  {loan.toolName}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{loan.borrowerName}</TableCell>
              <TableCell className="text-muted-foreground">{loan.ownerName}</TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">
                {formatRange(loan.startDate, loan.endDate)}
              </TableCell>
              <TableCell>
                <StatusPill status={loan.status} overdue={loan.overdue} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function UsersTable() {
  const users = useQuery(api.admin.allUsers);
  const setTrustedLender = useMutation(api.admin.setTrustedLender);
  const setRole = useMutation(api.admin.setRole);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (users === undefined) return <Skeleton className="h-48 w-full rounded-xl" />;

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Trusted lender</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell>
                <div className="font-medium">
                  {user.name}
                  {user.isSelf ? (
                    <span className="text-muted-foreground ml-2 text-xs">you</span>
                  ) : null}
                </div>
                <div className="text-muted-foreground text-xs">{user.email}</div>
              </TableCell>
              <TableCell>
                <Select
                  value={user.role}
                  disabled={user.isSelf || busyId === user.id}
                  onValueChange={async (role) => {
                    setBusyId(user.id);
                    try {
                      await setRole({
                        userId: user.id as Id<"users">,
                        role: role as "user" | "admin",
                      });
                      toast.success("Role updated.");
                    } catch (error) {
                      toast.error(errorMessage(error));
                    } finally {
                      setBusyId(null);
                    }
                  }}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                <Button
                  variant={user.trustedLender ? "secondary" : "outline"}
                  size="sm"
                  disabled={busyId === user.id}
                  onClick={async () => {
                    setBusyId(user.id);
                    try {
                      await setTrustedLender({
                        userId: user.id as Id<"users">,
                        trusted: !user.trustedLender,
                      });
                      toast.success(
                        user.trustedLender
                          ? "Trusted lender status revoked."
                          : "Marked as trusted lender.",
                      );
                    } catch (error) {
                      toast.error(errorMessage(error));
                    } finally {
                      setBusyId(null);
                    }
                  }}
                >
                  {user.trustedLender ? (
                    <>
                      <ShieldCheck className="size-3.5" />
                      Trusted
                    </>
                  ) : (
                    "Mark trusted"
                  )}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ActivityFeed() {
  const events = useQuery(api.admin.auditLog);
  if (events === undefined) return <Skeleton className="h-32 w-full rounded-xl" />;

  if (events.length === 0) {
    return (
      <div className="text-muted-foreground rounded-xl border border-dashed py-16 text-center text-sm">
        No administrative actions yet.
      </div>
    );
  }

  return (
    <ol className="divide-y rounded-xl border">
      {events.map((event) => (
        <li key={event.id} className="flex items-start justify-between gap-4 p-4">
          <div>
            <p className="text-sm">{event.summary}</p>
            <p className="text-muted-foreground mt-0.5 font-mono text-[11px] uppercase">
              {event.action}
            </p>
          </div>
          <div className="text-muted-foreground shrink-0 text-right text-xs">
            <div>{event.actorName}</div>
            <div>{relativeTime(event.createdAt)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Everything the workflow layer did recently. Failed notifications are the reason
 * this exists: an integration that breaks quietly is worse than one that fails.
 */
function AutomationFeed() {
  const rows = useQuery(api.automation.recentActivity);
  if (rows === undefined) return <Skeleton className="h-32 w-full rounded-xl" />;

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground rounded-xl border border-dashed py-16 text-center text-sm">
        No automation activity yet. Notifications appear here once n8n calls back.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Event</TableHead>
            <TableHead>Detail</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row._id}>
              <TableCell className="font-mono text-xs whitespace-nowrap">
                <span
                  className={
                    row.kind === "notification.failed" || row.kind === "workflow.failed"
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground"
                  }
                >
                  {row.kind}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground max-w-md truncate text-sm">
                {row.detail}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {row.channel}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                {relativeTime(row.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
