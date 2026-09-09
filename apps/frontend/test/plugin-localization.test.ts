import { describe, expect, it } from "vitest";

import {
  localize,
  localizePluginLabel,
} from "../../../packages/plugin-sdk/src/frontend/localization";

describe("plugin locale matching", () => {
  it("matches likely Chinese script and region equivalents", () => {
    expect(
      localizePluginLabel(
        { default: "Preview", translations: { "zh-CN": "预览" } },
        "zh-Hans",
      ),
    ).toBe("预览");
    expect(
      localizePluginLabel(
        { default: "Preview", translations: { "zh-TW": "預覽" } },
        "zh-Hant",
      ),
    ).toBe("預覽");
  });

  it("prefers exact and compatible regional translations", () => {
    expect(
      localize("fallback", { "en-GB": "colour", "en-US": "color" }, "en-US"),
    ).toBe("color");
    expect(localize("fallback", { "en-GB": "colour" }, "en-AU")).toBe("colour");
  });

  it("does not cross an incompatible script family", () => {
    expect(localize("fallback", { "sr-RS": "ћирилица" }, "sr-Latn")).toBe(
      "fallback",
    );
  });

  it("retains fallback behavior for unsupported locales", () => {
    expect(localize("fallback", { "zh-CN": "预览" }, "fr-FR")).toBe("fallback");
  });
});
