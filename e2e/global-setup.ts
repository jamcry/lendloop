import { execFileSync } from "node:child_process";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { ensureClerkUser, setConvexEnv, convexEnv, USERS, writeState } from "./support";

/**
 * Prepares the identities the suite needs.
 *
 * Three throwaway Clerk users (lender, borrower, admin) are created through the
 * Backend API. The admin address is appended to the deployment's ADMIN_EMAILS
 * rather than hard-coding a role in the database, so the test exercises the same
 * bootstrap path a real operator uses.
 */
export default async function globalSetup(): Promise<void> {
  const runId = Date.now().toString(36).slice(-6);
  const [lender, borrower, admin] = await Promise.all([
    ensureClerkUser("lender"),
    ensureClerkUser("borrower"),
    ensureClerkUser("admin"),
  ]);

  const adminEmail = USERS.admin.email;
  const before = convexEnv("ADMIN_EMAILS");
  const existing = (before ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (!existing.includes(adminEmail)) {
    setConvexEnv("ADMIN_EMAILS", [...existing, adminEmail].join(","));
  }

  writeState({
    runId,
    createdAt: new Date().toISOString(),
    clerkUserIds: { lender, borrower, admin },
    adminEmailsBefore: before,
    adminEmailAdded: adminEmail,
  });

  // Make sure there is something to browse on a fresh deployment. Skip when the
  // board already has tools, so running the suite against an adopted demo
  // deployment does not seed a second copy. The mutation is itself idempotent per
  // owner and refuses to run unless SEED_ENABLED=true.
  try {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (url) {
      const tools = await new ConvexHttpClient(url).query(api.tools.listPublic, {});
      if (tools.length === 0) {
        execFileSync("npx", ["convex", "run", "seed:populate"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      }
    }
  } catch {
    // Seeding is optional; the suite creates its own listings.
  }

  console.log(`[e2e] run ${runId} ready (admin bootstrap: ${adminEmail})`);
}
