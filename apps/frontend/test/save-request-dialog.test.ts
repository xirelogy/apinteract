// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import type { RequestTab } from "../src/model/domain/application";
import SaveRequestDialog from "../src/view/presentation/features/SaveRequestDialog.vue";

const workspaceId = "019facab-1eee-765f-bd9f-ac2449151db0";
const collectionId = "019facab-1eee-765f-bd9f-ac2449151db1";
const rootNodes = [
  {
    nodeId: collectionId,
    kind: "collection" as const,
    name: "Users",
    position: 0,
    orderRevision: 0,
  },
];
let showModalDescriptor: PropertyDescriptor | undefined;
let closeDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
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
    /** Simulates native top-layer opening for the save dialog test. */
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    /** Simulates native closure and its lifecycle event for the save dialog test. */
    value(this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  });
});

afterEach(() => {
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
});

/** Creates an unsaved request tab with an optional fixed destination. */
function createTab(parentCollectionId: string | null): RequestTab {
  return {
    tabId: "temporary-request",
    workspaceId,
    request: null,
    draft: {
      name: "",
      description: "",
      notes: "",
      method: "GET",
      targetMode: parentCollectionId === null ? "absolute" : "composed",
      targetUrl: "",
      query: [],
      headers: [],
      requestBody: { kind: "none" },
      body: "",
      preRequestScript: "",
      postResponseScript: "",
    },
    baseline: null,
    variableProfile: null,
    variableDraft: [],
    variableBaseline: [],
    pendingParentCollectionId: parentCollectionId,
    inheritedTarget: "",
    inheritedHeaders: [],
    execution: null,
    exchangeSummaries: [],
    selectedExchangeId: null,
    selectedExchange: null,
    revisions: [],
    viewingRevision: null,
    busy: false,
  };
}

/** Mounts the request save dialog with the English product messages. */
function mountDialog(tab: RequestTab) {
  const i18n = createI18n({
    legacy: false,
    locale: "en-US",
    messages: { "en-US": enUsMessages },
  });
  return mount(SaveRequestDialog, {
    attachTo: document.body,
    global: { plugins: [i18n] },
    props: {
      tab,
      rootNodes,
      collectionChildren: {},
      busy: false,
    },
  });
}

describe("SaveRequestDialog", () => {
  it("keeps a collection-bound destination fixed while requesting a name", async () => {
    const wrapper = mountDialog(createTab(collectionId));

    expect(wrapper.find(".collection-picker-field").exists()).toBe(false);
    expect(wrapper.get(".request-save-destination").text()).toContain(
      "Destination collection",
    );
    expect(wrapper.get(".request-save-destination").text()).toContain("Users");

    await wrapper
      .get('input[aria-label="Saved request name"]')
      .setValue("List users");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("save")).toEqual([["List users", collectionId]]);
    wrapper.unmount();
  });

  it("retains destination selection for an anonymous draft", async () => {
    const wrapper = mountDialog(createTab(null));

    expect(wrapper.find(".collection-picker-field").exists()).toBe(true);
    expect(wrapper.find(".request-save-destination").exists()).toBe(false);

    await wrapper
      .get('input[aria-label="Saved request name"]')
      .setValue("List users");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("save")).toEqual([["List users", collectionId]]);
    wrapper.unmount();
  });
});
