import { expect, test } from "@playwright/test";

const ACCESS_TOKEN_KEY = "apinteract.access-token";

test("creates the first administrator through responsive web onboarding", async ({
  context,
  page,
}) => {
  await page.goto("/web-ui/#/login");
  await expect(
    page.getByRole("heading", { name: "Set up APInteract" }),
  ).toBeVisible();
  await expect(
    page.getByText("Create the first administrator account"),
  ).toBeVisible();

  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Display name").fill("Administrator");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Browser-test-password-1!");
  await page.getByLabel("Confirm password").fill("different-password");
  await expect(page.getByText("The passwords do not match.")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Create administrator" }),
  ).toBeVisible();
  await page.getByLabel("Confirm password").fill("Browser-test-password-1!");
  await page.getByRole("button", { name: "Create administrator" }).click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(
    page.getByText(
      "Administrator account created. Sign in with the username and password you just chose.",
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/login$/u);
  await expect(
    page.evaluate((key) => sessionStorage.getItem(key), ACCESS_TOKEN_KEY),
  ).resolves.toBeNull();

  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("Browser-test-password-1!");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/#\/main$/u);
  await expect(
    page.getByRole("button", { name: "Account menu for admin" }),
  ).toBeVisible({ timeout: 15_000 });

  await context.clearCookies();
  const revisit = await context.newPage();
  await revisit.goto("/web-ui/#/login");
  await expect(revisit.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(
    revisit.getByRole("heading", { name: "Set up APInteract" }),
  ).toHaveCount(0);
  await revisit.close();
});
