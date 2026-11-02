import { AdminPanel } from "@/components/admin-panel";

export const metadata = { title: "Admin" };

export default function AdminPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Moderate listings, audit loans, and manage trusted lenders. Every action here is
          recorded.
        </p>
      </div>
      <AdminPanel />
    </div>
  );
}
