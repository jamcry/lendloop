import { IncomingRequests } from "@/components/incoming-requests";

export const metadata = { title: "Incoming requests" };

export default function IncomingPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Incoming requests</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Approve or decline requests for your tools, and close loans when they come home.
        </p>
      </div>
      <IncomingRequests />
    </div>
  );
}
