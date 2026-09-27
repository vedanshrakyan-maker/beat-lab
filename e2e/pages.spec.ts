import { expect, test } from "@playwright/test";
import { signInAs, watchErrors } from "./helpers";

/** Every surface renders for its role with seeded data. */
const ROLES: { email: string; pages: string[] }[] = [
  {
    email: "aarav@clipper.local",
    pages: [
      "/clipper",
      "/clipper/accounts",
      "/clipper/submissions",
      "/clipper/wallet",
      "/notifications",
      "/campaigns",
    ],
  },
  { email: "host@desifounders.local", pages: ["/funder", "/funder/campaigns/new"] },
  {
    email: "admin@reelpay.local",
    pages: [
      "/admin",
      "/admin/review",
      "/admin/payouts",
      "/admin/campaigns",
      "/admin/campaigns/new",
      "/admin/settings",
      "/admin/audit",
    ],
  },
];

test("public pages", async ({ page }) => {
  const check = watchErrors(page);
  for (const path of ["/", "/campaigns", "/signin"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
  }
  await page.goto("/campaigns");
  await page.locator("a[href^='/campaigns/c']").first().click();
  await expect(page.getByText("per 1,000 verified views")).toBeVisible();
  check();
});

for (const role of ROLES) {
  test(`pages render for ${role.email}`, async ({ page }) => {
    const check = watchErrors(page);
    await signInAs(page, role.email);
    for (const path of role.pages) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.locator("h1").first()).toBeVisible();
    }
    check();
  });
}

test("detail pages render (admin)", async ({ page }) => {
  const check = watchErrors(page);
  await signInAs(page, "admin@reelpay.local");
  await page.goto("/admin/review");
  await page.locator("a[href^='/admin/review/']").first().click();
  await expect(page.getByRole("heading", { name: "Fraud signals" })).toBeVisible();
  await page.goto("/admin/campaigns");
  await page.locator("a[href^='/funder/campaigns/']").first().click();
  await expect(page.getByRole("heading", { name: "Fraud blocked" })).toBeVisible();
  check();
});

test("clipper sees a submission detail", async ({ page }) => {
  const check = watchErrors(page);
  await signInAs(page, "aarav@clipper.local");
  await page.goto("/clipper/submissions");
  const link = page.locator("a[href^='/clipper/submissions/']:visible").first();
  if (await link.count()) {
    await link.click();
    await expect(page.getByRole("heading", { name: "Views" })).toBeVisible();
  }
  check();
});
