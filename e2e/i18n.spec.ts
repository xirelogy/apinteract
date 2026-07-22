import { expect, test } from "@playwright/test";

test("switches and persists official locales", async ({ page }) => {
  await page.goto("/web-ui/#/login");

  const language = page.locator(".locale-select");
  await language.selectOption("zh-Hans");
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  await page.reload();
  await expect(language).toHaveValue("zh-Hans");
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible();

  await language.selectOption("zh-Hant");
  await expect(page.getByRole("heading", { name: "登入" })).toBeVisible();

  await language.selectOption("en-GB");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-GB");
});

test("loads a partial deployment translation pack with English fallback", async ({
  page,
}) => {
  await page.route("**/web-ui/i18n/manifest.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            locale: "ar",
            name: "العربية",
            direction: "rtl",
            path: "ar.json",
          },
        ],
      }),
    });
  });
  await page.route("**/web-ui/i18n/ar.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        locale: "ar",
        name: "العربية",
        direction: "rtl",
        messages: {
          auth: {
            signIn: "تسجيل الدخول",
          },
        },
      }),
    });
  });

  await page.goto("/web-ui/#/login");
  await page.locator(".locale-select").selectOption("ar");

  await expect(
    page.getByRole("heading", { name: "تسجيل الدخول" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});
