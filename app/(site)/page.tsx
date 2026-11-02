import { ArrowLeftRight, BellRing, ShieldCheck } from "lucide-react";

import { AuthCta } from "@/components/auth-cta";
import { PublicToolBoard, PublicToolCount } from "@/components/public-tool-board";
import { Badge } from "@/components/ui/badge";

const STEPS = [
  {
    icon: ArrowLeftRight,
    title: "List what you have",
    body: "A drill you use twice a year. A tent that lives in the hall cupboard. Post it in under a minute.",
  },
  {
    icon: ShieldCheck,
    title: "Decide who borrows",
    body: "Every request is yours to approve or decline. Nobody takes anything without your say-so.",
  },
  {
    icon: BellRing,
    title: "Get it back",
    body: "Loans carry a return date. Mark them returned when the tool is home, and the shelf frees up again.",
  },
];

export default function HomePage() {
  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,var(--color-muted),transparent)]"
        />
        <div className="relative mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="max-w-2xl">
            <Badge
              variant="outline"
              className="mb-5 font-mono text-[11px] tracking-wider uppercase"
            >
              Neighborhood tool library
            </Badge>
            <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
              Borrow what you need.
              <br />
              Lend what you don&apos;t.
            </h1>
            <p className="text-muted-foreground mt-5 max-w-xl text-lg text-pretty">
              Most of us own a garage full of things we use a few times a year. LendLoop
              is a shared shelf for your street — list a tool, approve a neighbor, get it
              back on time.
            </p>

            <div className="mt-8">
              <AuthCta />
            </div>

            <p className="text-muted-foreground mt-4 text-sm">
              <PublicToolCount /> tools on the shelf right now. No fees, no delivery vans
              — just the people next door.
            </p>
          </div>
        </div>
      </section>

      {/* The public board */}
      <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">On the shelf</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              A read-only look at what neighbors are lending. Sign in to see owners,
              conditions, and availability.
            </p>
          </div>
        </div>
        <PublicToolBoard />
      </section>

      {/* How it works */}
      <section id="how-it-works" className="bg-muted/40 border-y">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <div key={step.title} className="bg-background rounded-xl border p-6">
                <div className="mb-4 flex items-center justify-between">
                  <span className="bg-muted flex size-9 items-center justify-center rounded-lg">
                    <step.icon className="size-4" aria-hidden />
                  </span>
                  <span className="text-muted-foreground font-mono text-xs">
                    0{index + 1}
                  </span>
                </div>
                <h3 className="font-medium">{step.title}</h3>
                <p className="text-muted-foreground mt-1.5 text-sm">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-6 rounded-2xl border p-8 sm:flex-row sm:items-center sm:p-10">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">
              Someone nearby needs your tile cutter.
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Sign in, list one thing, and see what happens.
            </p>
          </div>
          <AuthCta size="default" />
        </div>
      </section>
    </div>
  );
}
