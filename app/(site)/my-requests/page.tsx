import { MyRequests } from "@/components/my-requests";

export const metadata = { title: "My requests" };

export default function MyRequestsPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">My requests</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Everything you&apos;ve asked to borrow, and where it stands.
        </p>
      </div>
      <MyRequests />
    </div>
  );
}
