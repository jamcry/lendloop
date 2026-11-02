"use client";

import { Show, SignInButton, SignUpButton } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Clerk's `<Show>` must run on the client, so the CTA is its own component. */
export function AuthCta({ size = "lg" }: { size?: "default" | "lg" }) {
  const height = size === "lg" ? "h-11 px-6 text-sm" : undefined;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Show when="signed-out">
        <SignUpButton mode="modal">
          <Button className={height}>Sign in to lend or borrow</Button>
        </SignUpButton>
        <SignInButton mode="modal">
          <Button variant="outline" className={height}>
            I already have an account
          </Button>
        </SignInButton>
      </Show>
      <Show when="signed-in">
        <Button asChild className={height}>
          <Link href="/browse">
            Open the board
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </Show>
    </div>
  );
}
