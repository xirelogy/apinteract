// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { enUsMessages } from "@/app/i18n/messages";
import DocumentationEditor from "@/view/presentation/features/DocumentationEditor.vue";

Object.defineProperty(Range.prototype, "getClientRects", {
  configurable: true,
  value: () => [],
});

describe("DocumentationEditor", () => {
  it("presents an empty preview as muted supporting text", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(DocumentationEditor, {
      props: { description: "", notes: "", disabled: false },
      global: { plugins: [i18n] },
    });

    await wrapper.get('button[aria-label="Preview"]').trigger("click");

    expect(wrapper.get(".documentation-empty-preview").text()).toBe(
      "Nothing to preview.",
    );
    expect(wrapper.find(".markdown-preview").exists()).toBe(false);
  });

  it("renders Markdown without HTML, unsafe links, or remote images", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(DocumentationEditor, {
      props: {
        description: "Safe summary",
        notes:
          '<script>alert("unsafe")</script>\n\n[unsafe](javascript:alert(1))\n\n[external](https://example.test)\n\n![tracker](https://tracker.test/pixel.png)',
        disabled: false,
      },
      global: { plugins: [i18n] },
    });

    const edit = wrapper.get('button[aria-label="Edit"]');
    const previewTrigger = wrapper.get('button[aria-label="Preview"]');
    expect(edit.attributes("data-state")).toBe("active");
    expect(edit.find("svg").exists()).toBe(true);
    expect(edit.text()).toBe("");
    expect(previewTrigger.find("svg").exists()).toBe(true);
    expect(previewTrigger.text()).toBe("");
    expect(wrapper.get(".documentation-source-input").classes()).toContain(
      "code-editor-control",
    );
    await previewTrigger.trigger("click");
    expect(previewTrigger.attributes("data-state")).toBe("active");

    const preview = wrapper.get(".markdown-preview");
    expect(preview.find("script").exists()).toBe(false);
    expect(preview.find("img").exists()).toBe(false);
    expect(preview.html()).not.toContain('href="javascript:');
    const externalLink = preview.get('a[href="https://example.test"]');
    expect(externalLink.attributes("target")).toBe("_blank");
    expect(externalLink.attributes("rel")).toBe("noopener noreferrer");
    expect(preview.text()).toContain('<script>alert("unsafe")</script>');
    expect(preview.text()).toContain("tracker");
  });
});
