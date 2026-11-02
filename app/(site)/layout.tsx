import { Suspense } from "react";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * The header reads the current path and auth state, which are per-request values.
 * Under Cache Components it has to sit behind a Suspense boundary so the static
 * shell can prerender and the header stream in.
 */
function HeaderFallback() {
  return <div className="bg-background h-16 border-b" aria-hidden />;
}

export default function SiteLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <Suspense fallback={<HeaderFallback />}>
        <SiteHeader />
      </Suspense>
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </>
  );
}
