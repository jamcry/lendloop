import { Skeleton } from "@/components/ui/skeleton";

/**
 * Provides the Suspense boundary the dynamic `[id]` param needs under Cache
 * Components, and doubles as the loading state.
 */
export default function ToolLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-4 py-10 sm:px-6">
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Skeleton className="h-52 w-full rounded-xl" />
        <Skeleton className="h-52 w-full rounded-xl" />
      </div>
    </div>
  );
}
