import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";

export const metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <Suspense fallback={null}>
        <SignUp />
      </Suspense>
    </div>
  );
}
