"use client";

import { useQuery } from "convex/react";
import { PackageSearch, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { api } from "@/convex/_generated/api";
import { ToolCard } from "@/components/tool-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CATEGORY_LABELS, CATEGORY_ORDER, type Category } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function BrowseBoard() {
  const [category, setCategory] = useState<Category | null>(null);
  const [query, setQuery] = useState("");

  // The category filter is applied server-side via the Convex index, so the
  // payload stays small as the board grows.
  const tools = useQuery(api.tools.browse, category ? { category } : {});

  const visible = useMemo(() => {
    if (!tools) return tools;
    const needle = query.trim().toLowerCase();
    if (!needle) return tools;
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(needle) ||
        tool.description.toLowerCase().includes(needle),
    );
  }, [tools, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Filter by category"
        >
          <FilterChip active={category === null} onClick={() => setCategory(null)}>
            All
          </FilterChip>
          {CATEGORY_ORDER.map((value) => (
            <FilterChip
              key={value}
              active={category === value}
              onClick={() => setCategory(value)}
            >
              {CATEGORY_LABELS[value]}
            </FilterChip>
          ))}
        </div>

        <div className="relative w-full lg:max-w-xs">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tools"
            className="pl-9"
            aria-label="Search tools"
          />
        </div>
      </div>

      {visible === undefined ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-48 w-full rounded-xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-sm">
          <PackageSearch className="size-6" aria-hidden />
          <p>
            {query ? `Nothing matches “${query}”.` : "No tools in this category yet."}
          </p>
          {category ? (
            <Button variant="link" size="sm" onClick={() => setCategory(null)}>
              Show all categories
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-foreground text-background border-transparent"
          : "text-muted-foreground hover:text-foreground hover:border-foreground/30",
      )}
    >
      {children}
    </button>
  );
}
