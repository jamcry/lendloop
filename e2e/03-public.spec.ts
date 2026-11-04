import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";

/**
 * The signed-out surface: the brand, the read-only board (name + category, no
 * owner or condition), and the redirects protecting the app routes.
 */

function anonymousClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is missing");
  return new ConvexHttpClient(url);
}

test.describe("public page", () => {
  test("shows the LendLoop brand, tagline, and sign-in call to action", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: /LendLoop/ }).first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Borrow what you need\./ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in to lend or borrow" }).first(),
    ).toBeVisible();
  });

  test("the board is read-only and exposes no owner details", async ({ page }) => {
    await page.goto("/");

    // Seeded data, grouped by category. The drill is intentionally excluded here:
    // it carries the seeded overdue loan, so the availability rules hide it.
    await expect(page.getByRole("heading", { name: "On the shelf" })).toBeVisible();
    await expect(page.getByText("Stand mixer", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();

    // Names only: no owner, no condition, no description, no links into the app.
    await expect(page.getByText("LendLoop Demo")).toHaveCount(0);
    await expect(page.getByText("Like new")).toHaveCount(0);
    await expect(page.getByText(/18V hammer drill/)).toHaveCount(0);
    await expect(page.locator('a[href^="/tools/"]')).toHaveCount(0);
  });

  test("signed-out visitors are redirected away from app routes", async ({ page }) => {
    for (const route of [
      "/browse",
      "/my-listings",
      "/my-requests",
      "/incoming",
      "/admin",
    ]) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/sign-in/);
    }
  });

  test("the public page renders without JavaScript errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "On the shelf" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("Convex data minimization", () => {
  test("the public query returns only a name and a category", async () => {
    const tools = await anonymousClient().query(api.tools.listPublic, {});
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(Object.keys(tool).sort()).toEqual(["category", "name"]);
    }
  });

  test("signed-in queries return nothing without a token", async () => {
    const client = anonymousClient();
    expect(await client.query(api.tools.browse, {})).toEqual([]);
    expect(await client.query(api.loans.myRequests, {})).toEqual([]);
    expect(await client.query(api.loans.incoming, {})).toEqual([]);
    expect(await client.query(api.users.me, {})).toBeNull();
  });
});
