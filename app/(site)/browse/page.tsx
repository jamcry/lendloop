import { BrowseBoard } from "@/components/browse-board";

export const metadata = { title: "Browse tools" };

export default function BrowsePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Browse the board</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Everything neighbors are willing to lend. Availability reflects approved loans,
          not optimistic listings.
        </p>
      </div>
      <BrowseBoard />
    </div>
  );
}
