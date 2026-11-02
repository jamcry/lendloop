"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useEffect } from "react";

import { Toaster } from "@/components/ui/sonner";
import { api } from "@/convex/_generated/api";
import { convexClient } from "@/lib/convex-client";

/**
 * Mirrors the Clerk identity into our own `users` table once per session.
 *
 * The mirror is what lets other queries join loans to people without trusting
 * anything the client says about itself: the row is built from verified JWT
 * claims inside the mutation.
 */
function UserSync() {
  const { isSignedIn } = useAuth();
  const syncUser = useMutation(api.users.sync);

  useEffect(() => {
    if (!isSignedIn) return;
    // A failed sync self-heals on the next navigation; surfacing it as a toast
    // here would just be noise on every page load.
    void syncUser({}).catch(() => undefined);
  }, [isSignedIn, syncUser]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  if (!convexClient) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-3 p-8">
        <h1 className="text-lg font-semibold">Convex is not configured</h1>
        <p className="text-muted-foreground text-sm">
          Set <code className="font-mono text-xs">NEXT_PUBLIC_CONVEX_URL</code> in{" "}
          <code className="font-mono text-xs">.env.local</code>. Running{" "}
          <code className="font-mono text-xs">npx convex dev</code> writes it for you.
        </p>
      </div>
    );
  }

  return (
    <ClerkProvider
      appearance={{
        variables: { colorPrimary: "var(--primary)", borderRadius: "0.625rem" },
      }}
    >
      <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
        <UserSync />
        {children}
        <Toaster position="bottom-right" />
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
