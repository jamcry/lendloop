"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * Catches unexpected render and query failures in the signed-in area, so a bad
 * id or a transient Convex error shows something usable instead of Next's
 * default error page.
 */
export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground text-sm">
        That page couldn&apos;t be loaded. It may have been removed, or the connection
        dropped.
      </p>
      <Button onClick={reset} size="sm">
        Try again
      </Button>
    </div>
  );
}
