import { expect, test } from "@playwright/test";
import { signInAs, watchErrors } from "./helpers";

/**
 * The v0.1 definition of done, end to end with mocks:
 * funder creates & funds a campaign → clipper joins & submits → jobs snapshot, score, lock,
 * hold and clear the post (via dev time travel) → admin approves a payout batch → the clipper
 * sees the payout marked paid with TDS.
 */
test.describe.configure({ mode: "serial" });

const title = `E2E campaign ${Date.now().toString(36)}`;
const videoId = `E2E${Date.now().toString(36)}`.padEnd(11, "x").slice(0, 11);
const CLIPPER = "siddharth@clipper.local"; // seeded clipper with a YouTube account and no payout profile

test("full loop", async ({ page }) => {
  const check = watchErrors(page);

  // 1. Funder creates a campaign with the wizard and funds it through the mock checkout.
  await signInAs(page, "host@desifounders.local");
  await page.goto("/funder/campaigns/new");
  await page.locator("input[name=title]").fill(title);
  await page
    .locator("textarea[name=description]")
    .fill("Clip the best founder moments from our latest episode.");
  await page.locator("textarea[name=sourceContentUrls]").fill("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  await page.getByRole("button", { name: "Next →" }).click();
  await page.getByRole("button", { name: "Next →" }).click();
  await page.locator("input[name=budget]").fill("50000");
  await page.locator("input[name=rate]").fill("40");
  await expect(page.getByText("≈ 12.5 lakh views")).toBeVisible(); // live estimate
  await page.getByRole("button", { name: "Next →" }).click();
  await page.getByRole("button", { name: "Create draft campaign" }).click();
  await page.waitForURL(/\/funder\/campaigns\/c[^/]+\?created=1/);
  const campaignUrl = new URL(page.url()).pathname;
  const campaignId = campaignUrl.split("/").pop()!;
  await page.getByRole("button", { name: /^Pay ₹55,900$/ }).click(); // ₹50,000 + 10% fee + 18% GST on fee
  await page.getByTestId("mock-pay").click();
  await page.waitForURL(/funded=1/);
  await expect(page.getByText("Payment confirmed")).toBeVisible();

  // 2. Clipper joins, adds payout details and submits a YouTube Short.
  await signInAs(page, CLIPPER);
  await page.goto("/clipper/accounts");
  await page.locator("input[name=legalName]").fill("Siddharth Gupta");
  await page.locator("input[name=upiId]").fill("siddharth.gupta@okaxis");
  await page.locator("input[name=pan]").fill("ABCDE1234F");
  await page.getByRole("button", { name: /payout details/ }).click();
  await expect(page.getByText("Your UPI ID and PAN are encrypted")).toBeVisible();

  await page.goto(`/campaigns/${campaignId}`);
  await page.getByRole("button", { name: "Join campaign" }).click();
  await expect(page.getByTestId("post-url")).toBeVisible();
  await page.getByTestId("post-url").fill(`https://www.youtube.com/shorts/${videoId}?mock=clean_viral`);
  await page.getByRole("button", { name: "Submit post" }).click();
  await expect(page.getByText("Approved — we're tracking your views now.")).toBeVisible();
  await page.getByRole("link", { name: "View submission →" }).click();
  await page.waitForURL(/\/clipper\/submissions\/c/);
  const submissionId = new URL(page.url()).pathname.split("/").pop()!;

  // 3. "Jobs run": admin fast-forwards 15 days; the same lifecycle code the worker runs
  //    snapshots, scores, locks, holds and clears the post.
  await signInAs(page, "admin@reelpay.local");
  await page.goto(`/admin/review/${submissionId}`);
  await page.locator("input[name=hours]").fill("360");
  await page.getByRole("button", { name: "Fast-forward" }).click();
  await expect(page.getByText(/Fast-forwarded 360h/)).toBeVisible();
  await page.reload();
  await expect(page.getByText("Payable", { exact: true }).first()).toBeVisible();

  // 4. Clipper withdraws.
  await signInAs(page, CLIPPER);
  await page.goto("/clipper/wallet");
  await page.getByRole("button", { name: /^Withdraw ₹/ }).click();
  await expect(page.getByText("You have a withdrawal in progress.")).toBeVisible();

  // 5. Admin batches, approves and syncs the payout.
  await signInAs(page, "admin@reelpay.local");
  await page.goto("/admin/payouts");
  const drafts = await page.getByTestId("approve-batch").count();
  await page.getByRole("button", { name: /^Create batch/ }).click();
  // Success re-renders the page with our new draft batch listed first (newest).
  await expect(page.getByTestId("approve-batch")).toHaveCount(drafts + 1);
  await page.getByTestId("approve-batch").first().click();
  await expect(page.getByRole("button", { name: /^Sync \d+ processing/ })).toBeVisible();
  await page.getByRole("button", { name: /^Sync \d+ processing/ }).click();
  await expect(page.getByRole("button", { name: /^Sync \d+ processing/ })).toHaveCount(0);

  // 6. The clipper sees the payout marked paid, with TDS shown.
  await signInAs(page, CLIPPER);
  await page.goto("/clipper/wallet");
  const row = page.locator("tr", { hasText: "Paid" }).first();
  await expect(row).toBeVisible();
  await expect(page.getByText("TDS", { exact: true }).first()).toBeVisible();
  await page.goto(`/clipper/submissions/${submissionId}`);
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();

  // Funder dashboard reflects the spend.
  await signInAs(page, "host@desifounders.local");
  await page.goto(campaignUrl);
  await expect(page.getByRole("heading", { name: "Fraud blocked" })).toBeVisible();
  check();
});
