import { expect, type Page } from "@playwright/test";

export async function signInAs(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/signin");
  await page.getByTestId(`dev-login-${email}`).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}

/** Fail the test on any uncaught page error. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return () => expect(errors).toEqual([]);
}
