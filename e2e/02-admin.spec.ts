import { expect, test } from "@playwright/test";

import { readState, signIn } from "./support";

/**
 * The administrator surface: moderation, trusted-lender management, the all-loans
 * view, and the audit trail. A separate borrower session creates a listing the
 * admin has no ownership of, so "remove any listing" is genuinely cross-account.
 */

const state = readState();
const stamp = state.runId;

test.describe.serial("admin", () => {
  test("admin sees the panel and can mark a lender trusted", async ({ browser }) => {
    const context = await browser.newContext();
    const admin = await context.newPage();
    await signIn(admin, "admin");

    await admin.goto("/admin");
    await expect(admin.getByRole("heading", { name: "Admin" })).toBeVisible();
    await expect(admin.getByRole("tab", { name: "Overview" })).toBeVisible();
    await expect(admin.getByRole("tab", { name: "Automation" })).toBeVisible();

    await admin.getByRole("tab", { name: "Users" }).click();
    const lenderRow = admin.getByRole("row", { name: /E2E Lender/ }).first();
    await expect(lenderRow).toBeVisible();

    // Start from a known state: a previous run may have left this row trusted.
    const trustedButton = lenderRow.getByRole("button", { name: "Trusted" });
    if (await trustedButton.isVisible()) {
      await trustedButton.click();
      await expect(admin.getByText("Trusted lender status revoked.")).toBeVisible();
    }

    await lenderRow.getByRole("button", { name: "Mark trusted" }).click();
    await expect(admin.getByText("Marked as trusted lender.")).toBeVisible();
    await expect(lenderRow.getByRole("button", { name: "Trusted" })).toBeVisible();

    // Self-demotion is disabled in the UI and refused by the mutation. Scope to
    // the row marked "you", because old E2E identities can share the name.
    const selfRow = admin
      .getByRole("row")
      .filter({ hasText: "E2E Admin" })
      .filter({ hasText: "you" });
    await expect(selfRow.getByRole("combobox")).toBeDisabled();

    await context.close();
  });

  test("admin can remove a listing they do not own", async ({ browser }) => {
    const borrowerContext = await browser.newContext();
    const adminContext = await browser.newContext();
    const borrower = await borrowerContext.newPage();
    const admin = await adminContext.newPage();

    const toolName = `E2E ${stamp} Admin target`;

    await signIn(borrower, "borrower");
    await borrower.goto("/my-listings");
    await borrower.getByRole("button", { name: "New listing" }).click();
    await borrower.getByLabel("Name").fill(toolName);
    await borrower.getByLabel("Category").click();
    await borrower.getByRole("option", { name: "Camping" }).click();
    await borrower.getByLabel("Condition").click();
    await borrower.getByRole("option", { name: "Fair" }).click();
    await borrower.getByLabel("Description").fill("Created to be moderated by an admin.");
    await borrower.getByRole("button", { name: "List tool" }).click();
    await expect(borrower.getByText("Tool listed.")).toBeVisible();

    await signIn(admin, "admin");
    await admin.goto("/admin");
    await admin.getByRole("tab", { name: "Listings" }).click();

    const row = admin.getByRole("row", { name: new RegExp(toolName) });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Remove" }).click();
    await admin.getByRole("button", { name: "Remove listing" }).click();
    await expect(admin.getByText("Listing removed.")).toBeVisible();
    await expect(row.getByText("Removed")).toBeVisible();

    await admin.getByRole("tab", { name: "Activity" }).click();
    await expect(
      admin.getByText(new RegExp(`Removed listing "${toolName}"`)),
    ).toBeVisible();

    await adminContext.close();
    await borrowerContext.close();
  });

  test("admin can see every loan, including other people's", async ({ browser }) => {
    const context = await browser.newContext();
    const admin = await context.newPage();
    await signIn(admin, "admin");

    await admin.goto("/admin");
    await admin.getByRole("tab", { name: "Loans" }).click();

    const loanRow = admin.getByRole("row", { name: /Tile cutter/ }).first();
    await expect(loanRow).toBeVisible();
    await expect(loanRow.getByText("Returned")).toBeVisible();

    await context.close();
  });

  test("admin cannot approve a loan on someone else's behalf", async ({ browser }) => {
    // Covered server-side by convex/lendloop.test.ts; here we prove the UI offers
    // no such control to an administrator either.
    const context = await browser.newContext();
    const admin = await context.newPage();
    await signIn(admin, "admin");

    await admin.goto("/incoming");
    await expect(admin.getByRole("button", { name: "Approve" })).toHaveCount(0);

    await context.close();
  });
});
