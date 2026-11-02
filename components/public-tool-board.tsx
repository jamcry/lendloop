"use client";

import { useQuery } from "convex/react";
import { PackageOpen } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { CATEGORY_ORDER, categoryLabel } from "@/lib/labels";

/**
 * The public board. Reads `tools.listPublic`, which returns only a name and a
 * category — no owner, condition, or description — so nothing sensitive is in the
 * payload a signed-out visitor can inspect.
 */
export function PublicToolBoard() {
  const tools = useQuery(api.tools.listPublic);

  if (tools === undefined) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (tools.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-sm">
        <PackageOpen className="size-6" aria-hidden />
        <p>The shelf is empty right now. Be the first to share something.</p>
      </div>
    );
  }

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    tools: tools.filter((tool) => tool.category === category),
  })).filter((group) => group.tools.length > 0);

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((group) => (
        <section key={group.category} className="space-y-2">
          <h3 className="text-muted-foreground flex items-baseline justify-between font-mono text-[11px] tracking-wider uppercase">
            {categoryLabel(group.category)}
            <span className="text-muted-foreground/60">{group.tools.length}</span>
          </h3>
          <ul className="divide-y rounded-xl border">
            {group.tools.map((tool, index) => (
              <li
                key={`${tool.name}-${index}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <span className="truncate">{tool.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Small live counter for the hero. */
export function PublicToolCount() {
  const tools = useQuery(api.tools.listPublic);
  if (tools === undefined)
    return <span className="bg-muted inline-block h-4 w-10 animate-pulse rounded" />;
  return <>{tools.length}</>;
}
