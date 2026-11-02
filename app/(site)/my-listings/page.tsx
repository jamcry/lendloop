import { MyListings } from "@/components/my-listings";

export const metadata = { title: "My listings" };

export default function MyListingsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">My listings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Tools you&apos;re willing to lend. Removing a listing keeps its loan history
          intact.
        </p>
      </div>
      <MyListings />
    </div>
  );
}
