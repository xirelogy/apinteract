// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import RequestEditor from "../src/view/presentation/features/RequestEditor.vue";

describe("RequestEditor temporary saving", () => {
  it("allows an unnamed temporary request to open the naming dialog", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(RequestEditor, {
      props: {
        request: null,
        draft: {
          name: "",
          method: "GET",
          targetUrl: "https://example.test/temporary",
          query: [],
          headers: [],
          body: "",
        },
        execution: null,
        tabId: "019facab-1eee-765f-bd9f-ac2449151be1",
        temporary: true,
        busy: false,
      },
      global: { plugins: [i18n] },
    });

    const save = wrapper.get(".command-bar .secondary-button");
    expect(save.attributes("disabled")).toBeUndefined();
    await save.trigger("click");
    expect(wrapper.emitted("save")).toEqual([
      [
        {
          name: "",
          method: "GET",
          targetUrl: "https://example.test/temporary",
          query: [],
          headers: [],
          body: "",
        },
      ],
    ]);
  });
});
