import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { AvailabilityPill, TrustedPill } from "@/components/status-pill";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { formatDate, formatRange } from "@/lib/dates";
import { categoryLabel, conditionLabel } from "@/lib/labels";

type ToolCardProps = {
  id: string;
  name: string;
  category: string;
  condition: string;
  description: string;
  ownerName: string;
  ownerTrustedLender: boolean;
  isMine: boolean;
  availability: { state: "available" | "lent"; until: number | null; overdue: boolean };
  nextBooking: { startDate: number; endDate: number } | null;
};

export function ToolCard({ tool }: { tool: ToolCardProps }) {
  return (
    <Card className="group hover:border-foreground/20 flex h-full flex-col gap-0 py-0 transition-colors">
      <CardContent className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
              {categoryLabel(tool.category)}
            </p>
            <h3 className="leading-tight font-medium">{tool.name}</h3>
          </div>
          <AvailabilityPill
            state={tool.availability.state}
            until={tool.availability.until}
            overdue={tool.availability.overdue}
            formatDate={formatDate}
          />
        </div>

        <p className="text-muted-foreground line-clamp-3 text-sm">{tool.description}</p>

        <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-2 text-xs">
          <span>{tool.ownerName}</span>
          {tool.isMine ? <span className="text-foreground">· You</span> : null}
          <span aria-hidden>·</span>
          <span>{conditionLabel(tool.condition)}</span>
          {tool.ownerTrustedLender ? <TrustedPill /> : null}
        </div>

        {tool.nextBooking ? (
          <p className="text-muted-foreground border-t pt-2 text-xs">
            Next booking{" "}
            {formatRange(tool.nextBooking.startDate, tool.nextBooking.endDate)}
          </p>
        ) : null}
      </CardContent>

      <CardFooter className="border-t px-5 py-3">
        <Link
          href={`/tools/${tool.id}`}
          className="text-muted-foreground group-hover:text-foreground inline-flex items-center gap-1 text-sm font-medium transition-colors"
        >
          View details
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </CardFooter>
    </Card>
  );
}
