import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { convexFor, readState, signIn } from "./support";

/**
 * The whole borrow lifecycle, driven through the browser as two different
 * neighbors. Runs serially because each step depends on the row the previous one
 * created, and because both actors share one Convex deployment.
 */

const state = readState();
const stamp = state.runId;
const DAY = 86_400_000;

function dayFromNow(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
}

/** The innermost container that holds both the label and the action button. */
function cardWith(page: Page, text: string, buttonName: string) {
  return page
    .locator("div")
    .filter({ has: page.getByText(text, { exact: false }) })
    .filter({ has: page.getByRole("button", { name: buttonName }) })
    .last();
}

async function createListing(
  page: Page,
  name: string,
  options: { category?: string; condition?: string; description?: string } = {},
) {
  await page.goto("/my-listings");
  await page.getByRole("button", { name: "New listing" }).click();

  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Category").click();
  await page.getByRole("option", { name: options.category ?? "Power tools" }).click();
  await page.getByLabel("Condition").click();
  await page.getByRole("option", { name: options.condition ?? "Good" }).click();
  await page
    .getByLabel("Description")
    .fill(options.description ?? `Browser test listing ${name}.`);

  await page.getByRole("button", { name: "List tool" }).click();
  await expect(page.getByText("Tool listed.")).toBeVisible();
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
}

async function requestToBorrow(page: Page, toolName: string, start: string, end: string) {
  await page.goto("/browse");

  // The browse card uses "View details" as its link; the tool name is a heading.
  const card = page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: toolName, exact: true }) })
    .filter({ has: page.getByRole("link", { name: "View details" }) })
    .last();
  await card.getByRole("link", { name: "View details" }).click();

  await expect(page.getByRole("heading", { name: toolName })).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill(start);
  await page.getByLabel("Until", { exact: true }).fill(end);
  await page
    .getByLabel("Note to the lender (optional)")
    .fill("E2E: borrowing for a job.");
  await page.getByRole("button", { name: "Send request" }).click();

  await expect(page.getByText("Request sent to the lender.")).toBeVisible();
  await expect(page.getByText("Waiting for the lender to respond.")).toBeVisible();
}

test.describe.serial("borrow lifecycle", () => {
  test("lender can create and edit a listing", async ({ browser }) => {
    const context = await browser.newContext();
    const lender = await context.newPage();
    await signIn(lender, "lender");

    const toolName = `E2E ${stamp} Tile cutter`;
    await createListing(lender, toolName, {
      category: "Power tools",
      description: "Wet tile cutter, 600mm, with the blade guard.",
    });

    const row = cardWith(lender, toolName, "Edit");
    await row.getByRole("button", { name: "Edit" }).click();

    const edited = `${toolName} (edited)`;
    await lender.getByLabel("Name").fill(edited);
    await lender.getByRole("button", { name: "Save changes" }).click();
    await expect(lender.getByText("Listing updated.")).toBeVisible();
    await expect(lender.getByRole("link", { name: edited, exact: true })).toBeVisible();

    await lender.context().close();
  });

  test("borrower requests, lender approves, lender marks returned", async ({
    browser,
  }) => {
    const lenderContext = await browser.newContext();
    const borrowerContext = await browser.newContext();
    const lender = await lenderContext.newPage();
    const borrower = await borrowerContext.newPage();

    await signIn(lender, "lender");
    await signIn(borrower, "borrower");

    const toolName = `E2E ${stamp} Tile cutter (edited)`;
    const start = dayFromNow(30);
    const end = dayFromNow(32);

    await requestToBorrow(borrower, toolName, start, end);

    // Tracked in the borrower's own view.
    await borrower.goto("/my-requests");
    await expect(
      borrower.getByRole("link", { name: toolName, exact: true }),
    ).toBeVisible();
    const pendingRow = borrower
      .getByRole("row")
      .filter({ has: borrower.getByRole("link", { name: toolName, exact: true }) });
    await expect(pendingRow.getByText("Pending")).toBeVisible();

    // The lender sees it in Incoming requests and approves.
    await lender.goto("/incoming");
    const pendingCard = cardWith(lender, toolName, "Approve");
    await expect(pendingCard.getByText("E2E Borrower")).toBeVisible();
    await pendingCard.getByRole("button", { name: "Approve" }).click();
    await expect(lender.getByText("Approved. The tool is reserved.")).toBeVisible();

    // Bonus requirement: the automation trail is visible on the loan itself. The
    // outbox delivers to n8n within seconds, so the row shows up without a reload.
    if (process.env.E2E_EXPECT_N8N_DELIVERY === "1") {
      await borrower.goto("/browse");
      const card = borrower
        .locator("div")
        .filter({ has: borrower.getByRole("heading", { name: toolName, exact: true }) })
        .filter({ has: borrower.getByRole("link", { name: "View details" }) })
        .last();
      await card.getByRole("link", { name: "View details" }).click();
      await expect(borrower.getByRole("heading", { name: toolName })).toBeVisible();
      await expect(borrower.getByText("Automation")).toBeVisible();
      await expect(borrower.getByText("Notification delivered").first()).toBeVisible({
        timeout: 45_000,
      });
    }

    // The loan moves to the "On loan" tab, then comes home.
    await lender.getByRole("button", { name: /On loan/ }).click();
    const activeCard = cardWith(lender, toolName, "Mark returned");
    await activeCard.getByRole("button", { name: "Mark returned" }).click();
    await expect(lender.getByText("Marked as returned.")).toBeVisible();

    await borrower.goto("/my-requests");
    const returnedRow = borrower
      .getByRole("row")
      .filter({ has: borrower.getByRole("link", { name: toolName, exact: true }) });
    await expect(returnedRow.getByText("Returned")).toBeVisible();

    await borrowerContext.close();
    await lenderContext.close();
  });

  test("lender can decline a request, and the borrower can withdraw one", async ({
    browser,
  }) => {
    const lenderContext = await browser.newContext();
    const borrowerContext = await browser.newContext();
    const lender = await lenderContext.newPage();
    const borrower = await borrowerContext.newPage();

    await signIn(lender, "lender");
    await signIn(borrower, "borrower");

    await createListing(lender, `E2E ${stamp} Extension ladder`, {
      category: "Other",
      condition: "Fair",
    });

    const toolName = `E2E ${stamp} Extension ladder`;
    await requestToBorrow(borrower, toolName, dayFromNow(40), dayFromNow(41));

    await lender.goto("/incoming");
    const pendingCard = cardWith(lender, toolName, "Decline");
    await pendingCard.getByRole("button", { name: "Decline" }).click();
    await expect(lender.getByText("Request declined.")).toBeVisible();

    await borrower.goto("/my-requests");
    await expect(borrower.getByText("Declined").first()).toBeVisible();

    // A declined request does not block a new one on the same tool.
    await requestToBorrow(borrower, toolName, dayFromNow(45), dayFromNow(46));
    await borrower.goto("/my-requests");
    const withdrawRow = borrower
      .getByRole("row")
      .filter({ has: borrower.getByRole("link", { name: toolName, exact: true }) })
      .filter({ has: borrower.getByRole("button", { name: "Withdraw" }) });
    await withdrawRow.getByRole("button", { name: "Withdraw" }).click();
    await expect(borrower.getByText("Request withdrawn.")).toBeVisible();
    await expect(borrower.getByText("Cancelled").first()).toBeVisible();

    await borrowerContext.close();
    await lenderContext.close();
  });

  test("removing a listing takes it off the public board", async ({ browser }) => {
    const context = await browser.newContext();
    const lender = await context.newPage();
    await signIn(lender, "lender");

    const toolName = `E2E ${stamp} Tile cutter (edited)`;

    // Visible publicly while live (it was returned, so it is available again).
    await lender.goto("/");
    await expect(lender.getByText(toolName, { exact: true })).toBeVisible();

    await lender.goto("/my-listings");
    const row = cardWith(lender, toolName, "Remove");
    await row.getByRole("button", { name: "Remove" }).click();
    await lender.getByRole("button", { name: "Remove listing" }).click();
    await expect(lender.getByText("Listing removed.")).toBeVisible();
    await expect(row.getByText("Removed")).toBeVisible();

    await lender.goto("/");
    await expect(lender.getByText(toolName, { exact: true })).toHaveCount(0);

    await context.close();
  });
});

test.describe("role gates in the UI", () => {
  test("a regular user is refused the admin area", async ({ browser }) => {
    const context = await browser.newContext();
    const borrower = await context.newPage();
    await signIn(borrower, "borrower");

    await borrower.goto("/admin");
    await expect(borrower.getByText("Administrator access required")).toBeVisible();

    await context.close();
  });

  test("the nav only shows Admin to an admin", async ({ browser }) => {
    const borrowerContext = await browser.newContext();
    const adminContext = await browser.newContext();
    const borrower = await borrowerContext.newPage();
    const admin = await adminContext.newPage();

    await signIn(borrower, "borrower");
    await borrower.goto("/browse");
    await expect(
      borrower.getByRole("navigation").getByRole("link", { name: "Admin" }),
    ).toHaveCount(0);

    await signIn(admin, "admin");
    await admin.goto("/browse");
    await expect(
      admin.getByRole("navigation").getByRole("link", { name: "Admin" }),
    ).toBeVisible();

    await borrowerContext.close();
    await adminContext.close();
  });

  test("a borrower browsing someone else's tool gets no owner controls", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const borrower = await context.newPage();
    await signIn(borrower, "borrower");

    await borrower.goto("/browse");
    const card = borrower
      .locator("div")
      .filter({ has: borrower.getByRole("heading", { name: /Extension ladder/ }) })
      .filter({ has: borrower.getByRole("link", { name: "View details" }) })
      .last();
    await card.getByRole("link", { name: "View details" }).click();
    await expect(borrower.getByText("This is your tool")).toHaveCount(0);

    await context.close();
  });
});

test.describe("authorization in the Convex layer", () => {
  test("a regular user cannot call admin functions directly", async ({ browser }) => {
    const context = await browser.newContext();
    const borrower = await context.newPage();
    await signIn(borrower, "borrower");
    const client = await convexFor(borrower);

    await expect(client.query(api.admin.allUsers, {})).rejects.toThrow(/Administrator/);

    const me = (await client.query(api.users.me, {})) as { id: string };
    await expect(
      client.mutation(api.admin.setRole, { userId: me.id, role: "admin" }),
    ).rejects.toThrow(/Administrator/);

    await context.close();
  });

  test("a user cannot edit or remove someone else's listing", async ({ browser }) => {
    const context = await browser.newContext();
    const borrower = await context.newPage();
    await signIn(borrower, "borrower");
    const client = await convexFor(borrower);

    type BrowseTool = {
      id: string;
      name: string;
      category: string;
      condition: string;
      isMine: boolean;
    };
    const tools = (await client.query(api.tools.browse, {})) as BrowseTool[];
    const someoneElses = tools.find((tool) => !tool.isMine);
    expect(someoneElses).toBeTruthy();
    if (!someoneElses) throw new Error("No foreign listing to test against.");

    await expect(
      client.mutation(api.tools.update, {
        id: someoneElses.id,
        name: "Hijacked",
        category: someoneElses.category,
        condition: someoneElses.condition,
        description: "Should not be allowed",
      }),
    ).rejects.toThrow(/only edit your own/i);

    await expect(
      client.mutation(api.tools.archive, { id: someoneElses.id }),
    ).rejects.toThrow(/only remove your own/i);

    await context.close();
  });
});
