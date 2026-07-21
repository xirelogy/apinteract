import { expect, test } from "@playwright/test";

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

  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(body).toHaveCSS("background-color", "rgb(17, 23, 24)");
  await expect(body).toHaveCSS("color", "rgb(230, 237, 238)");
});
