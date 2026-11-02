import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t">
      <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>LendLoop — a neighborhood tool-lending board.</p>
        <p className="text-xs">
          A fictional product built as a take-home exercise.{" "}
          <Link
            href="/browse"
            className="hover:text-foreground underline underline-offset-4"
          >
            Browse the board
          </Link>
        </p>
      </div>
    </footer>
  );
}
