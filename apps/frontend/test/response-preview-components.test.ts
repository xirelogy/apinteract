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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HTML response preview", () => {
  it("isolates inline scripts while sanitizing every network sink", () => {
    const wrapper = mount(HtmlResponsePreview, {
      props: {
        title: "Response preview",
        source: `<base href="https://attacker.test/">
          <meta http-equiv="refresh" content="0;url=https://attacker.test/">
          <script>document.documentElement.classList.add("initialized")</script>
          <script src="https://attacker.test/external.js">window.externalFallback = true</script>
          <form action="http://127.0.0.1/private"><input></form>
          <a href="https://attacker.test/" ping="https://attacker.test/ping">link</a>
          <a href="#safe-section">local link</a>
          <img src="https://attacker.test/tracker.png" onerror="alert(1)">
          <iframe src="https://attacker.test/"></iframe>
          <svg><animate attributeName="x" dur="1ms" repeatCount="indefinite"></animate></svg>
          <p id="safe-section" style="color: green">safe text</p>`,
      },
    });

    const iframe = wrapper.get("iframe");
    const sourceDocument = iframe.attributes("srcdoc") ?? "";
    expect(iframe.attributes("sandbox")).toBe("allow-scripts");
    expect(iframe.attributes("referrerpolicy")).toBe("no-referrer");
    expect(sourceDocument).toContain("default-src 'none'");
    expect(sourceDocument).toContain("connect-src 'none'");
    expect(sourceDocument).toContain("form-action 'none'");
    expect(sourceDocument).toContain("script-src 'unsafe-inline'");
    expect(sourceDocument).toContain("safe text");
    expect(sourceDocument).toContain('href="#safe-section"');
    expect(sourceDocument).toContain(
      '<script>document.documentElement.classList.add("initialized")</script>',
    );
    expect(sourceDocument).not.toMatch(
      /<iframe|<form|<base|<svg|http:\/\/|https:\/\//u,
    );
    expect(sourceDocument).not.toContain("externalFallback");
    expect(sourceDocument).not.toMatch(/\s(?:src|ping|onerror)=/u);
  });

  it("retains a Symfony VarDumper-style initializer after sanitized dump markup", () => {
    const stylesheet = `.sf-js-enabled .sf-dump-compact { display: none; }
      pre.sf-dump { background: #18171b; color: #ff8400; }`;
    const definition = `window.Sfdump = function (id) {
            document.documentElement.classList.add("sf-js-enabled");
            const root = document.getElementById(id);
            root.querySelector("samp").className = "sf-dump-compact";
          };`;
    const invocation = `Sfdump("sf-dump-123")`;
    const wrapper = mount(HtmlResponsePreview, {
      props: {
        title: "Response preview",
        source: `<script>${definition}</script><style>${stylesheet}</style>
        <pre class="sf-dump" id="sf-dump-123" data-indent-pad="  ">
          <a class="sf-dump-ref" href="#sf-dump-123-ref1">#1</a>
          <samp id="sf-dump-123-ref1" class="sf-dump-expanded">value</samp>
        </pre>
        <script>${invocation}</script>`,
      },
    });

    const sourceDocument = wrapper.get("iframe").attributes("srcdoc") ?? "";
    const markupIndex = sourceDocument.indexOf('id="sf-dump-123"');
    const definitionIndex = sourceDocument.indexOf(definition);
    const invocationIndex = sourceDocument.indexOf(invocation);
    expect(markupIndex).toBeGreaterThan(-1);
    expect(definitionIndex).toBeGreaterThan(markupIndex);
    expect(invocationIndex).toBeGreaterThan(definitionIndex);
    expect(sourceDocument).toContain('href="#sf-dump-123-ref1"');
    expect(sourceDocument).toContain(`<style>${stylesheet}</style>`);
  });
});

describe("image response preview", () => {
  it("loads lazily supplied bytes, validates decode dimensions, and revokes its URL", async () => {
    const body = new Blob([new Uint8Array(24)]);
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
        inspect: () => ({ width: 640, height: 480 }),
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
        inspect: () => null,
      },
      global: { plugins: [i18n()] },
    });
    await flushPromises();
    expect(loadOversizedBody).not.toHaveBeenCalled();
    expect(oversized.text()).toContain("safe preview limits");
    oversized.unmount();

    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    const largeDimensions = new Blob([new Uint8Array(24)]);
    const large = mount(ImageResponsePreview, {
      props: {
        executionId: "019fa8be-a510-76b9-b73b-69f4c7af7912",
        mediaType: "image/png",
        byteLength: largeDimensions.size,
        loadBody: vi.fn().mockResolvedValue(largeDimensions),
        inspect: () => ({ width: 10_000, height: 10_000 }),
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
