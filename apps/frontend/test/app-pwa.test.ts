// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "../src/App.vue";
import { enUsMessages } from "../src/app/i18n/messages";
import { useApplicationStore } from "../src/control/state/application-store";
import type { RequestTab } from "../src/model/domain/application";

const { activatePwaUpdate } = vi.hoisted(() => ({
  activatePwaUpdate: vi.fn(),
}));

vi.mock("@/app/pwa-registration", async () => {
  const { ref } = await import("vue");
  return {
    activatePwaUpdate,
    updateAvailable: ref(true),
  };
});

beforeEach(() => {
  activatePwaUpdate.mockReset();
});

describe("App PWA states", () => {
  it("hides routed authenticated content behind a neutral offline state", () => {
    const { pinia, i18n } = createApplicationPlugins();
    const store = useApplicationStore();
    store.session = {
      user: { userId: "user-id", username: "alice" },
    } as typeof store.session;
    store.connection = "offline";

    const wrapper = mount(App, {
      global: {
        plugins: [pinia, i18n],
        stubs: {
          RouterView: {
            template: '<div class="private-workspace">secret</div>',
          },
        },
      },
    });

    expect(wrapper.get(".pwa-connection-state").text()).toContain(
      "APInteract is offline",
    );
    expect(wrapper.text()).toContain("stay hidden");
    expect(wrapper.find(".private-workspace").exists()).toBe(false);
  });

  it("keeps a waiting update disabled while a draft is dirty", async () => {
    const { pinia, i18n } = createApplicationPlugins();
    const store = useApplicationStore();
    store.requestTabs = [
      { baseline: null, execution: null } as unknown as RequestTab,
    ];

    const wrapper = mount(App, {
      global: {
        plugins: [pinia, i18n],
        stubs: { RouterView: true },
      },
    });
    const updateButton = wrapper.get(".pwa-update-notice button");
    expect(updateButton.attributes("disabled")).toBeDefined();
    expect(wrapper.get(".pwa-update-notice").text()).toContain(
      "Save or discard unsaved changes",
    );

    store.requestTabs = [];
    await nextTick();
    await updateButton.trigger("click");
    expect(activatePwaUpdate).toHaveBeenCalledOnce();
  });
});

/** Creates isolated Pinia and English translation plugins for App tests. */
function createApplicationPlugins() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return {
    pinia,
    i18n: createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    }),
  };
}
