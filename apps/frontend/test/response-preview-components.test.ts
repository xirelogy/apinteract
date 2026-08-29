// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import { RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES } from "../src/model/domain/response-content";
import HtmlResponsePreview from "../src/view/presentation/features/HtmlResponsePreview.vue";
import ImageResponsePreview from "../src/view/presentation/features/ImageResponsePreview.vue";

/** Creates the locale plugin used by response preview components. */
function i18n() {
  return createI18n({
    legacy: false,
    locale: "en-US",
    messages: { "en-US": enUsMessages },
  });
}

/** Creates minimal PNG header bytes with declared dimensions. */
function png(width: number, height: number): Blob {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: "application/octet-stream" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HTML response preview", () => {
  it("sanitizes active markup inside a network-inert empty sandbox", () => {
    const wrapper = mount(HtmlResponsePreview, {
      props: {
        title: "Response preview",
        source: `<base href="https://attacker.test/">
          <meta http-equiv="refresh" content="0;url=https://attacker.test/">
          <script>window.parent.pwned = true</script>
          <form action="http://127.0.0.1/private"><input></form>
          <a href="https://attacker.test/" ping="https://attacker.test/ping">link</a>
          <img src="https://attacker.test/tracker.png" onerror="alert(1)">
          <iframe src="https://attacker.test/"></iframe>
          <svg><animate attributeName="x" dur="1ms" repeatCount="indefinite"></animate></svg>
          <p style="color: green">safe text</p>`,
      },
    });

    const iframe = wrapper.get("iframe");
    const sourceDocument = iframe.attributes("srcdoc") ?? "";
    expect(iframe.attributes("sandbox")).toBe("");
    expect(iframe.attributes("referrerpolicy")).toBe("no-referrer");
    expect(sourceDocument).toContain("default-src 'none'");
    expect(sourceDocument).toContain("form-action 'none'");
    expect(sourceDocument).toContain("safe text");
    expect(sourceDocument).not.toMatch(
      /<script|<iframe|<form|<base|<svg|http:\/\/|https:\/\//u,
    );
    expect(sourceDocument).not.toMatch(/\s(?:href|src|ping|onerror)=/u);
  });
});

describe("image response preview", () => {
  it("loads lazily supplied bytes, validates decode dimensions, and revokes its URL", async () => {
    const body = png(640, 480);
    const loadBody = vi.fn().mockResolvedValue(body);
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:response-image");
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const wrapper = mount(ImageResponsePreview, {
      props: {
        executionId: "019fa8be-a510-76b9-b73b-69f4c7af7910",
        mediaType: "image/png",
        byteLength: body.size,
        loadBody,
      },
      global: { plugins: [i18n()] },
    });

    await flushPromises();
    expect(loadBody).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledOnce());
    const image = wrapper.get("img");
    Object.defineProperties(image.element, {
      naturalWidth: { configurable: true, value: 640 },
      naturalHeight: { configurable: true, value: 480 },
    });
    await image.trigger("load");
    expect(
      wrapper.get(".image-response-preview").attributes("data-state"),
    ).toBe("ready");
    expect(wrapper.text()).toContain("640 × 480 pixels");

    wrapper.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:response-image");
  });

  it("rejects encoded and decoded-size violations before creating a URL", async () => {
    const loadOversizedBody = vi.fn();
    const oversized = mount(ImageResponsePreview, {
      props: {
        executionId: "019fa8be-a510-76b9-b73b-69f4c7af7911",
        mediaType: "image/png",
        byteLength: RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES + 1,
        loadBody: loadOversizedBody,
      },
      global: { plugins: [i18n()] },
    });
    await flushPromises();
    expect(loadOversizedBody).not.toHaveBeenCalled();
    expect(oversized.text()).toContain("safe preview limits");
    oversized.unmount();

    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    const largeDimensions = png(10_000, 10_000);
    const large = mount(ImageResponsePreview, {
      props: {
        executionId: "019fa8be-a510-76b9-b73b-69f4c7af7912",
        mediaType: "image/png",
        byteLength: largeDimensions.size,
        loadBody: vi.fn().mockResolvedValue(largeDimensions),
      },
      global: { plugins: [i18n()] },
    });
    await vi.waitFor(() =>
      expect(
        large.get(".image-response-preview").attributes("data-state"),
      ).toBe("too-large"),
    );
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(large.text()).toContain("safe preview limits");
  });
});
