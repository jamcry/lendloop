"use client";

import { SignInButton, SignUpButton, Show, UserButton } from "@clerk/nextjs";
import { useAuth } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { Menu, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/browse", label: "Browse" },
  { href: "/my-listings", label: "My listings" },
  { href: "/my-requests", label: "My requests" },
  { href: "/incoming", label: "Incoming" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();
  const { isSignedIn } = useAuth();
  const viewer = useQuery(api.users.me);
  const [open, setOpen] = useState(false);

  const links =
    viewer?.role === "admin" ? [...NAV, { href: "/admin", label: "Admin" }] : NAV;

  return (
    <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
            <Wrench className="size-4" aria-hidden />
          </span>
          LendLoop
        </Link>

        {isSignedIn ? (
          <nav className="hidden items-center gap-1 md:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "rounded-md px-3 py-2 text-sm transition-colors",
                  pathname === link.href
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        ) : (
          <nav className="hidden items-center gap-1 md:flex">
            <Link
              href="/#how-it-works"
              className="text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm transition-colors"
            >
              How it works
            </Link>
          </nav>
        )}

        <div className="flex items-center gap-2">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button variant="ghost" size="sm">
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button size="sm">Get started</Button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <UserButton
              appearance={{ elements: { avatarBox: "size-8" } }}
              showName={false}
            />
          </Show>

          {isSignedIn ? (
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open navigation"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              <Menu className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      {open && isSignedIn ? (
        <nav className="border-t px-4 py-2 md:hidden">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={cn(
                "block rounded-md px-3 py-2 text-sm",
                pathname === link.href ? "bg-muted font-medium" : "text-muted-foreground",
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
