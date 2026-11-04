import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Shared plumbing for the browser suite.
 *
 * The tests run against the real Clerk instance and the real Convex dev
 * deployment, because the point is to exercise the parts `convex-test` cannot:
 * Clerk's session, the Next.js proxy, and the n8n hop.
 */

export type Role = "lender" | "borrower" | "admin";

export const E2E_PASSWORD = "LendLoop-E2E-2026!";
export const E2E_DOMAIN = "example.com";

export const USERS: Record<Role, { email: string; firstName: string }> = {
  lender: { email: `lendloop.e2e.lender@${E2E_DOMAIN}`, firstName: "E2E Lender" },
  borrower: { email: `lendloop.e2e.borrower@${E2E_DOMAIN}`, firstName: "E2E Borrower" },
  admin: { email: `lendloop.e2e.admin@${E2E_DOMAIN}`, firstName: "E2E Admin" },
};

export type E2EState = {
  runId: string;
  createdAt: string;
  clerkUserIds: Record<Role, string>;
  adminEmailsBefore: string | null;
  adminEmailAdded: string;
};

const STATE_PATH = path.join(process.cwd(), "e2e", ".state.json");
const CLERK_API = "https://api.clerk.com/v1";

export function readState(): E2EState {
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as E2EState;
}

export function writeState(state: E2EState): void {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function clerkSecret(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) throw new Error("CLERK_SECRET_KEY is missing from .env.local");
  return key;
}

async function clerkRequest<T>(
  apiPath: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${CLERK_API}${apiPath}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${clerkSecret()}`,
      "content-type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Clerk ${init.method ?? "GET"} ${apiPath} → ${response.status}: ${text}`,
    );
  }
  return JSON.parse(text) as T;
}

type ClerkEmailAddress = {
  id: string;
  email_address: string;
  verification: { status: string };
};

type ClerkUser = { id: string; email_addresses: ClerkEmailAddress[] };

/** Creates the identity if needed and makes sure the password is known. */
export async function ensureClerkUser(role: Role): Promise<string> {
  const { email, firstName } = USERS[role];
  const found = await clerkRequest<ClerkUser[]>(
    `/users?limit=100&email_address=${encodeURIComponent(email)}`,
  );
  let user = found.find((candidate) =>
    candidate.email_addresses.some((address) => address.email_address === email),
  );

  if (!user) {
    user = await clerkRequest<ClerkUser>("/users", {
      method: "POST",
      body: {
        email_address: [email],
        password: E2E_PASSWORD,
        first_name: firstName,
        last_name: "(LendLoop E2E)",
        skip_password_checks: true,
      },
    });
  }

  for (const address of user.email_addresses) {
    if (address.email_address === email && address.verification.status !== "verified") {
      await clerkRequest(`/email_addresses/${address.id}`, {
        method: "PATCH",
        body: { verified: true },
      });
    }
  }

  await clerkRequest(`/users/${user.id}`, {
    method: "PATCH",
    body: { password: E2E_PASSWORD, skip_password_checks: true },
  });

  return user.id;
}

export function convexEnv(name: string): string | null {
  try {
    return execFileSync("npx", ["convex", "env", "get", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function setConvexEnv(name: string, value: string): void {
  execFileSync("npx", ["convex", "env", "set", name, value], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let clerkReady: Promise<void> | null = null;

/** One testing token per worker; the setup call is cheap but not free. */
function setupClerk(): Promise<void> {
  clerkReady ??= clerkSetup();
  return clerkReady;
}

/**
 * Signs a page in as one of the throwaway users.
 *
 * `clerk.signIn` with `emailAddress` mints a one-time sign-in token through the
 * Backend API, so no password or inbox is involved and bot protection is bypassed
 * with Clerk's testing token.
 */
export async function signIn(page: Page, role: Role): Promise<void> {
  await setupClerk();
  await page.goto("/");

  const email = USERS[role].email;
  const lastError: unknown[] = [];

  // A fresh Clerk instance occasionally needs the client to finish booting before
  // `window.Clerk.client` exists; retrying the navigation once is enough.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await clerk.signIn({ page, emailAddress: email });
      await page.waitForFunction(() => Boolean(window.Clerk?.session));
      await waitForSyncedUser(page);
      return;
    } catch (error) {
      lastError.push(error);
      await page.goto("/sign-in");
      await page.waitForTimeout(500);
    }
  }

  throw new Error(`Could not sign in ${email}: ${String(lastError.at(-1))}`);
}

/** Signs out of a page so a test can switch identities in the same context. */
export async function signOut(page: Page): Promise<void> {
  await clerk.signOut({ page });
}

export type E2EConvexClient = {
  query: (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;
  mutation: (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * A Convex client authenticated with the page's real Clerk token.
 *
 * This is the same credential the browser uses, so it lets a test call functions
 * the UI does not expose — which is exactly how you prove authorization lives in
 * Convex rather than in a hidden button.
 */
export async function convexFor(page: Page): Promise<E2EConvexClient> {
  const token = await page.evaluate(async () => {
    const clerk = (
      window as unknown as {
        Clerk?: {
          session?: {
            getToken: (options: { template: string }) => Promise<string | null>;
          };
        };
      }
    ).Clerk;
    if (!clerk?.session) return null;
    return await clerk.session.getToken({ template: "convex" });
  });

  if (!token) throw new Error("The page has no Clerk session token.");

  // Imported lazily so the browser-side bundle is never involved.
  const { ConvexHttpClient } = await import("convex/browser");
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is missing from .env.local");

  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client as unknown as E2EConvexClient;
}

/**
 * Waits until `users.sync` has created the caller's row.
 *
 * It is a client-triggered mutation, so a brand-new identity has a short window
 * where Convex knows the token but not the user. Tests that write immediately
 * after sign-in need to wait for it, or they reproduce that race instead of the
 * flow they meant to test.
 */
export async function waitForSyncedUser(page: Page): Promise<void> {
  const { api } = await import("../convex/_generated/api");
  const client = await convexFor(page);

  await expect
    .poll(async () => (await client.query(api.users.me)) !== null, {
      timeout: 20_000,
      intervals: [200, 500, 1000],
    })
    .toBe(true);
}
