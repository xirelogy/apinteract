// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { applicationControllerKey } from "../src/app/dependencies";
import { enUsMessages } from "../src/app/i18n/messages";
import { HttpProblemError } from "../src/control/transport/http-client";
import FirstUserSetup from "../src/view/presentation/features/FirstUserSetup.vue";

/** Mounts first-user setup with its narrow application dependency. */
function mountSetup(initializeFirstAdministrator: ReturnType<typeof vi.fn>) {
  const i18n = createI18n({
    legacy: false,
    locale: "en-US",
    messages: { "en-US": enUsMessages },
  });
  return mount(FirstUserSetup, {
    props: {
      providers: [{ id: "local-password", label: "Username and password" }],
    },
    global: {
      plugins: [i18n],
      provide: {
        [applicationControllerKey as symbol]: {
          session: { initializeFirstAdministrator },
        },
      },
    },
  });
}

describe("FirstUserSetup", () => {
  it("validates confirmation and clears secrets after creating the account", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountSetup(initialize);
    const passwordInputs = wrapper.findAll('input[type="password"]');
    await passwordInputs[0]!.setValue("first password");
    await passwordInputs[1]!.setValue("different password");
    await wrapper.get("form").trigger("submit");
    expect(initialize).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "passwords do not match",
    );

    await passwordInputs[1]!.setValue("first password");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(initialize).toHaveBeenCalledWith({
      providerId: "local-password",
      username: "admin",
      displayName: "Administrator",
      password: "first password",
    });
    expect(wrapper.emitted("completed")).toHaveLength(1);
    expect((passwordInputs[0]!.element as HTMLInputElement).value).toBe("");
    expect((passwordInputs[1]!.element as HTMLInputElement).value).toBe("");
    wrapper.unmount();
  });

  it("returns to ordinary login when another initializer wins", async () => {
    const initialize = vi.fn().mockRejectedValue(
      new HttpProblemError({
        type: "/problems/web_bootstrap_already_completed",
        title: "First-user setup already completed",
        status: 409,
        code: "web_bootstrap_already_completed",
        detail: "This APInteract instance has already been initialized.",
        correlationId: "00000000-0000-7000-8000-000000000000",
        errors: [],
      }),
    );
    const wrapper = mountSetup(initialize);
    const passwords = wrapper.findAll('input[type="password"]');
    await passwords[0]!.setValue("first password");
    await passwords[1]!.setValue("first password");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.emitted("stale")).toHaveLength(1);
    wrapper.unmount();
  });
});
