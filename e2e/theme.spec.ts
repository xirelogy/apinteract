import { expect, test, type Locator, type Page } from "@playwright/test";

test("follows the system color scheme and accepts explicit overrides", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/web-ui/#/login");

  const body = page.locator("body");
  await expect
    .poll(() =>
      page.evaluate(
        () => window.matchMedia("(prefers-color-scheme: dark)").matches,
      ),
    )
    .toBe(true);
  await expect(body).toHaveCSS("background-color", "rgb(17, 23, 24)");
  await expect(body).toHaveCSS("color", "rgb(230, 237, 238)");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect(body).toHaveCSS("background-color", "rgb(244, 246, 247)");
  await expect(body).toHaveCSS("color", "rgb(23, 33, 36)");
  await login(page);
  await expectLocaleSelectorStates(page, {
    color: "rgb(255, 255, 255)",
    background: "rgb(42, 54, 56)",
    border: "rgb(80, 96, 100)",
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(body).toHaveCSS("background-color", "rgb(17, 23, 24)");
  await expect(body).toHaveCSS("color", "rgb(230, 237, 238)");
  await expectLocaleSelectorStates(page, {
    color: "rgb(245, 247, 247)",
    background: "rgb(24, 32, 34)",
    border: "rgb(70, 86, 90)",
  });
});

interface ExpectedTriggerColors {
  readonly color: string;
  readonly background: string;
  readonly border: string;
}

/** Authenticates the isolated browser-test administrator. */
async function login(page: Page): Promise<void> {
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("Browser-test-password-1!");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/#\/main$/u);
}

/** Verifies that pointer, keyboard, and expanded select states stay legible. */
async function expectLocaleSelectorStates(
  page: Page,
  expected: ExpectedTriggerColors,
): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    return;
  }

  const trigger = page.locator(".locale-selector .select-menu-trigger");
  await trigger.hover();
  await expectTriggerColors(trigger, expected);

  const viewport = page.viewportSize();
  await page.mouse.move(
    Math.max((viewport?.width ?? 1) - 1, 0),
    Math.max((viewport?.height ?? 1) - 1, 0),
  );
  await page.keyboard.press("Tab");
  await trigger.focus();
  await expectTriggerColors(trigger, expected);

  await trigger.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expectTriggerColors(trigger, expected);
  await page.keyboard.press("Escape");
}

/** Asserts the complete foreground, background, and border state together. */
async function expectTriggerColors(
  trigger: Locator,
  expected: ExpectedTriggerColors,
): Promise<void> {
  await expect(trigger).toHaveCSS("color", expected.color);
  await expect(trigger).toHaveCSS("background-color", expected.background);
  await expect(trigger).toHaveCSS("border-color", expected.border);
}
