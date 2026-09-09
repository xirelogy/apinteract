// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enUsMessages } from "@/app/i18n/messages";
import { useDateTimeFormatPreference } from "@/app/preferences/date-time-format";
import CookieJarPanel from "@/view/presentation/features/CookieJarPanel.vue";

let clipboardDescriptor: PropertyDescriptor | undefined;
let showModalDescriptor: PropertyDescriptor | undefined;
let closeDescriptor: PropertyDescriptor | undefined;
const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  showModalDescriptor = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  );
  closeDescriptor = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "close",
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    /** Simulates opening a native dialog in jsdom. */
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    /** Simulates closing a native dialog and publishing its lifecycle event. */
    value(this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  });
  writeText.mockClear();
  useDateTimeFormatPreference().setDateTimeFormat("ymd-24");
});

afterEach(() => {
  useDateTimeFormatPreference().setDateTimeFormat("locale");
  if (clipboardDescriptor === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  }
  if (showModalDescriptor === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  } else {
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      showModalDescriptor,
    );
  }
  if (closeDescriptor === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  } else {
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "close",
      closeDescriptor,
    );
  }
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("CookieJarPanel", () => {
  it("formats compact metadata and emits only supported management operations", async () => {
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(CookieJarPanel, {
      attachTo: document.body,
      props: {
        jar: {
          jarId: "019fb000-0000-7000-8000-000000000001",
          workspaceId: "019fb000-0000-7000-8000-000000000002",
          environmentId: null,
          revision: 3,
          cookies: [
            {
              cookieId: "019fb000-0000-7000-8000-000000000003",
              name: "session",
              value: "visible-value-that-is-intentionally-long",
              domain: "api.example.test",
              path: "/account",
              hostOnly: true,
              secure: true,
              httpOnly: true,
              sameSite: "lax",
              expiresAt: null,
              session: true,
              extensions: [],
              createdAt: "2026-09-09T00:00:00.000Z",
              updatedAt: "2026-09-09T00:00:00.000Z",
            },
            {
              cookieId: "019fb000-0000-7000-8000-000000000004",
              name: "persistent",
              value: "persistent-value",
              domain: "api.example.test",
              path: "/",
              hostOnly: true,
              secure: false,
              httpOnly: false,
              sameSite: null,
              expiresAt: "2026-09-10T08:09:10.000Z",
              session: false,
              extensions: [],
              createdAt: "2026-09-09T00:00:00.000Z",
              updatedAt: "2026-09-09T00:00:00.000Z",
            },
          ],
        },
        busy: false,
        canEdit: true,
      },
      global: { plugins: [i18n] },
    });

    expect(wrapper.attributes("aria-label")).toBe("Cookie jar content");
    expect(wrapper.get("h3").text()).toBe("Cookie jar content");
    expect(wrapper.text()).not.toContain("Workspace default");
    expect(wrapper.text()).not.toContain("Revision 3");
    expect(wrapper.find(".cookie-list-heading").text()).toContain(
      "NameValueDomain / pathExpiryProperties",
    );
    expect(wrapper.get(".cookie-value").classes()).toContain("cookie-value");
    expect(wrapper.text()).toContain("api.example.test/account");
    expect(wrapper.text()).toMatch(/2026-09-10 \d{2}:09:10/u);
    expect(
      wrapper
        .get(".cookie-list")
        .element.contains(wrapper.get(".cookie-jar-actions").element),
    ).toBe(false);

    await wrapper
      .get('button[aria-label="Copy value for cookie session"]')
      .trigger("click");
    expect(writeText).toHaveBeenCalledWith(
      "visible-value-that-is-intentionally-long",
    );

    const cookieRows = wrapper.findAll(".cookie-list-item");
    expect(
      cookieRows[0]?.findAll(".cookie-attribute-icons button"),
    ).toHaveLength(3);
    expect(
      cookieRows[1]?.findAll(".cookie-attribute-icons button"),
    ).toHaveLength(0);
    await wrapper.get('button[aria-label="Secure"]').trigger("click");
    expect(document.body.textContent).toContain("Secure");
    expect(document.body.textContent).toContain("Sent only to secure targets");
    await wrapper.get('button[aria-label="HTTP-Only"]').trigger("click");
    expect(document.body.textContent).toContain("HTTP-Only");
    expect(document.body.textContent).toContain(
      "Unavailable to browser scripts",
    );
    await wrapper.get('button[aria-label="SameSite: lax"]').trigger("click");
    expect(document.body.textContent).toContain("SameSite: lax");

    await wrapper
      .get('button[aria-label="Delete cookie session"]')
      .trigger("click");
    expect(wrapper.emitted("deleteCookie")).toEqual([
      ["019fb000-0000-7000-8000-000000000003"],
    ]);
    const clearSessionButton = wrapper
      .findAll("button")
      .find((button) => button.text() === "Clear session cookies")!;
    await clearSessionButton.trigger("click");
    expect(wrapper.emitted("clear")).toBeUndefined();
    const confirmation = wrapper.get(".cookie-clear-dialog");
    expect(confirmation.attributes("open")).toBe("");
    expect(confirmation.get("h2").text()).toBe("Clear session cookies?");
    expect(confirmation.text()).toContain("Persistent cookies will be kept");
    await confirmation
      .findAll("button")
      .find((button) => button.text() === "Clear session cookies")!
      .trigger("click");
    expect(wrapper.emitted("clear")).toEqual([["session"]]);

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Clear all cookies")!
      .trigger("click");
    expect(confirmation.attributes("open")).toBe("");
    expect(confirmation.get("h2").text()).toBe("Clear all cookies?");
    expect(confirmation.text()).toContain("including persistent cookies");
    await confirmation
      .findAll("button")
      .find((button) => button.text() === "Clear all cookies")!
      .trigger("click");
    expect(wrapper.emitted("clear")).toEqual([["session"], ["all"]]);
    wrapper.unmount();
  });
});
