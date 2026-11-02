import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";

export const metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      {/* Clerk reads the request, so it must be inside a boundary. */}
      <Suspense fallback={null}>
        <SignIn />
      </Suspense>
    </div>
  );
}
