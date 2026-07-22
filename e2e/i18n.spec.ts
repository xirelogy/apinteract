import { expect, test, type Locator, type Page } from "@playwright/test";

test("switches and persists official locales", async ({ page }, testInfo) => {
  await page.goto("/web-ui/#/login");

  const language = page.locator(".locale-selector .select-menu-trigger");
  await language.click();
  await expectSelectPresentation(page, language, testInfo.project.name);
  await page.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  await page.reload();
  await expect(language).toHaveAttribute("data-value", "zh-Hans");
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible();

  await selectOption(page, language, "繁體中文");
  await expect(page.getByRole("heading", { name: "登入" })).toBeVisible();

  await selectOption(page, language, "English (United Kingdom)");
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
  await selectOption(
    page,
    page.locator(".locale-selector .select-menu-trigger"),
    "العربية",
  );

  await expect(
    page.getByRole("heading", { name: "تسجيل الدخول" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

/** Selects one visible option from an already rendered select-menu trigger. */
async function selectOption(
  page: Page,
  trigger: Locator,
  option: string,
): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Verifies desktop anchoring or the intentional mobile full-screen surface. */
async function expectSelectPresentation(
  page: Page,
  trigger: Locator,
  projectName: string,
): Promise<void> {
  const popup = page.locator(".select-menu-popup");
  await expect(popup).toBeVisible();
  const viewport = page.viewportSize();
  const triggerBox = await trigger.boundingBox();
  const popupBox = await popup.boundingBox();
  expect(viewport).not.toBeNull();
  expect(triggerBox).not.toBeNull();
  expect(popupBox).not.toBeNull();
  if (projectName === "mobile-chromium") {
    expect(Math.abs(popupBox?.x ?? 0)).toBeLessThanOrEqual(1);
    expect(Math.abs(popupBox?.y ?? 0)).toBeLessThanOrEqual(1);
    expect(
      Math.abs((popupBox?.width ?? 0) - (viewport?.width ?? 0)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((popupBox?.height ?? 0) - (viewport?.height ?? 0)),
    ).toBeLessThanOrEqual(1);
    return;
  }
  expect(popupBox?.y ?? 0).toBeGreaterThanOrEqual(
    (triggerBox?.y ?? 0) + (triggerBox?.height ?? 0),
  );
  expect(popupBox?.x ?? 0).toBeLessThan(
    (triggerBox?.x ?? 0) + (triggerBox?.width ?? 0),
  );
  expect((popupBox?.x ?? 0) + (popupBox?.width ?? 0)).toBeGreaterThan(
    triggerBox?.x ?? 0,
  );
}
