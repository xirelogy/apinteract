import { expect, test } from "@playwright/test";

const ACCESS_TOKEN_KEY = "apinteract.access-token";

test("completes the browser login and session lifecycle", async ({
  context,
  page,
}) => {
  await page.goto("/web-ui/#/login");

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("incorrect-password");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "The supplied credentials could not be accepted",
  );

  await page.getByLabel("Password").fill("Browser-test-password-1!");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/#\/main$/u);
  await expect(
    page.getByRole("button", { name: "Account menu for admin" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((key) => sessionStorage.getItem(key), ACCESS_TOKEN_KEY),
    )
    .not.toBeNull();

  await page.evaluate(
    (key) => sessionStorage.removeItem(key),
    ACCESS_TOKEN_KEY,
  );
  await page.reload();

  await expect(page).toHaveURL(/#\/main$/u);
  await expect(
    page.getByRole("button", { name: "Account menu for admin" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Account menu for admin" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page
    .getByRole("dialog", { name: "Log out" })
    .getByRole("button", { name: "Log out" })
    .click();
  await expect(page).toHaveURL(/#\/login$/u);

  await page.goto("/web-ui/#/main");
  await expect(page).toHaveURL(/#\/login$/u);
  await expect
    .poll(async () => {
      const cookies = await context.cookies();
      return cookies.some((cookie) => cookie.name === "apinteract_refresh");
    })
    .toBe(false);
});
