// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import SelectMenu from "../src/view/presentation/controls/SelectMenu.vue";
import TextInput from "../src/view/presentation/controls/TextInput.vue";
import ImportDialog from "../src/view/presentation/features/ImportDialog.vue";

describe("ImportDialog", () => {
  it("previews a provider plan and opens one selected temporary request", async () => {
    const plan = {
      schemaVersion: 1 as const,
      providerId: "har" as const,
      providerVersion: "1.0.0",
      sourceName: "capture.har",
      sourceFingerprint: "a".repeat(64),
      suggestedName: "Capture",
      description: "",
      notes: "",
      pathPrefix: "",
      variables: [],
      collections: [],
      requests: [
        {
          itemId: "entry:0",
          sourceLocation: "#/log/entries/0",
          collectionKey: null,
          name: "GET /items",
          description: "",
          notes: "Common request notes",
          method: "GET" as const,
          targetMode: "absolute" as const,
          targetUrl: "https://example.test/items",
          query: [],
          headers: [],
          requestBody: {
            kind: "text" as const,
            contentType: "application/json",
            text: "{}",
          },
          requestBodyOptions: [
            {
              optionId: "body:json",
              label: "application/json",
              requestBody: {
                kind: "text" as const,
                contentType: "application/json",
                text: "{}",
              },
              documentation: "JSON request schema",
            },
            {
              optionId: "body:text",
              label: "text/plain",
              requestBody: {
                kind: "text" as const,
                contentType: "text/plain",
                text: "example",
              },
              documentation: "Text request schema",
            },
          ],
          defaultRequestBodyOptionId: "body:json",
          body: "",
          preRequestScript: "",
          postResponseScript: "",
          variables: [],
          capturedExchange: {
            source: "har" as const,
            status: 200,
            statusText: "OK",
            headers: [],
            contentType: "text/plain",
            body: "done",
            bodyEncoding: "text" as const,
            bodyComplete: true,
            bodyBytes: 4,
            recordedAt: null,
          },
        },
      ],
      diagnostics: [
        {
          code: "har_other_entry_invalid",
          severity: "error" as const,
          message: "Another request cannot be imported.",
          itemIds: ["entry:other"],
        },
        {
          code: "har_response_unavailable",
          severity: "info" as const,
          message: "The HAR entry did not contain a completed HTTP response.",
        },
        {
          code: "har_cookie_metadata_omitted",
          severity: "warning" as const,
          message: "Cookie metadata is not represented in the request.",
        },
        {
          code: "har_cookie_metadata_omitted_again",
          severity: "warning" as const,
          message: "Cookie metadata is not represented in the request.",
        },
      ],
    };
    const previewImport = vi.fn().mockResolvedValue(plan);
    const openTemporary = vi.fn();
    const i18n = createI18n({
      legacy: false,
      locale: "en-US",
      messages: { "en-US": enUsMessages },
    });
    const wrapper = mount(ImportDialog, {
      props: {
        selectedCollectionId: null,
        selectedCollectionName: null,
        busy: false,
        listProviders: vi.fn().mockResolvedValue({
          providers: [
            {
              id: "openapi-json",
              version: "1.0.0",
              label: "OpenAPI JSON",
              acceptedExtensions: [".json"],
              acceptedMediaTypes: ["application/json"],
              inputKinds: ["file"],
              capabilities: {
                multipleRequests: true,
                hierarchy: true,
                attachments: false,
                capturedResponses: false,
                responseExamples: true,
                variables: true,
              },
            },
            {
              id: "har",
              version: "1.0.0",
              label: "HAR",
              acceptedExtensions: [".har"],
              acceptedMediaTypes: ["application/json"],
              inputKinds: ["file"],
              capabilities: {
                multipleRequests: true,
                hierarchy: false,
                attachments: false,
                capturedResponses: true,
                responseExamples: false,
                variables: true,
              },
            },
          ],
        }),
        previewImport,
        applyImport: vi.fn(),
        openTemporary,
      },
      global: {
        plugins: [i18n],
        stubs: {
          DialogControl: {
            template: "<div><slot /></div>",
          },
        },
      },
    });
    await flushPromises();
    expect(
      wrapper.find(".resource-dialog-header .resource-dialog-context").exists(),
    ).toBe(false);
    expect(wrapper.find(".import-dialog-description").exists()).toBe(false);
    const providerSelect = wrapper.findComponent(SelectMenu);
    expect(providerSelect.props("modelValue")).toBe("");
    expect(providerSelect.props("placeholder")).toBe("Select import type");
    expect(wrapper.text()).toContain("Choose an import type first");
    expect(wrapper.get('input[type="file"]').attributes()).toHaveProperty(
      "disabled",
    );
    providerSelect.vm.$emit("update:modelValue", "har");
    await flushPromises();

    const fileInput = wrapper.get('input[type="file"]');
    expect(fileInput.attributes("accept")).toBe(".har");
    expect(wrapper.text()).toContain("Choose HAR file");
    expect(wrapper.text()).not.toContain("Detect automatically");
    const source = {
      name: "capture.har",
      text: vi.fn().mockResolvedValue('{"log":{"entries":[]}}'),
    };
    Object.defineProperty(fileInput.element, "files", {
      configurable: true,
      value: [source],
    });
    await fileInput.trigger("change");
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "Preview")
      ?.trigger("click");
    await flushPromises();

    expect(previewImport).toHaveBeenCalledWith(
      "har",
      "capture.har",
      '{"log":{"entries":[]}}',
    );
    expect(wrapper.text()).toContain("GET /items");
    expect(wrapper.text()).toContain("1 sample response");
    expect(wrapper.find(".import-preview-summary").exists()).toBe(false);
    expect(wrapper.find(".import-request-items").exists()).toBe(true);
    const metadata = wrapper.get(".import-preview-metadata");
    expect(metadata.attributes("open")).toBeUndefined();
    expect(metadata.findAll("dt").map((entry) => entry.text())).toEqual([
      "Title",
      "Import type",
      "Source file",
      "Captured responses",
    ]);
    expect(metadata.findAll("dd").map((entry) => entry.text())).toEqual([
      "Capture",
      "HAR",
      "capture.har",
      "1",
    ]);
    expect(wrapper.get(".import-selected-count").text()).toBe(
      "1 of 1 selected",
    );
    expect(wrapper.get(".import-diagnostics legend").text()).toBe(
      "Import notes",
    );
    expect(
      wrapper
        .findAll(".import-diagnostics li")
        .map((note) => note.attributes("data-severity")),
    ).toEqual(["error", "warning", "info"]);
    expect(wrapper.findAll(".import-diagnostics li")).toHaveLength(3);
    expect(wrapper.get('[data-severity="warning"] strong').text()).toBe(
      "Warning",
    );
    const destinationSelect = wrapper
      .findAllComponents(SelectMenu)
      .find((select) => select.props("label") === "Destination");
    expect(destinationSelect?.props("modelValue")).toBe("temporary");
    const bodySelect = wrapper
      .findAllComponents(SelectMenu)
      .find(
        (select) => select.props("label") === "Request body for GET /items",
      );
    bodySelect?.vm.$emit("update:modelValue", "body:text");
    await flushPromises();

    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "Import")
      ?.trigger("click");
    await flushPromises();

    expect(openTemporary).toHaveBeenCalledWith(
      plan,
      expect.objectContaining({
        requestBody: {
          kind: "text",
          contentType: "text/plain",
          text: "example",
        },
        notes: "Common request notes\n\nText request schema",
      }),
    );
  });

  it("defaults multiple requests to a named workspace collection", async () => {
    const requests = ["one", "two"].map((name, index) => ({
      itemId: `entry:${index}`,
      sourceLocation: `#/log/entries/${index}`,
      name: `GET /${name}`,
      description: "",
      notes: "",
      method: "GET" as const,
      targetMode: "absolute" as const,
      targetUrl: `https://example.test/${name}`,
      query: [],
      headers: [],
      requestBody:
        index === 0
          ? {
              kind: "text" as const,
              contentType: "application/json",
              text: "{}",
            }
          : { kind: "none" as const },
      ...(index === 0
        ? {
            requestBodyOptions: [
              {
                optionId: "body:json",
                label: "application/json",
                requestBody: {
                  kind: "text" as const,
                  contentType: "application/json",
                  text: "{}",
                },
              },
              {
                optionId: "body:text",
                label: "text/plain",
                requestBody: {
                  kind: "text" as const,
                  contentType: "text/plain",
                  text: "example",
                },
              },
            ],
            defaultRequestBodyOptionId: "body:json",
          }
        : {}),
      body: "",
      preRequestScript: "",
      postResponseScript: "",
      collectionKey: null,
      variables: [],
    }));
    const plan = {
      schemaVersion: 1 as const,
      providerId: "openapi-json" as const,
      providerVersion: "1.0.0",
      sourceName: "spec.json",
      sourceFingerprint: "b".repeat(64),
      suggestedName: "Example API",
      description: "",
      notes: "",
      pathPrefix: "https://api.example.test/v1",
      variables: [],
      collections: [],
      requests,
      diagnostics: [],
    };
    const importedCollectionId = "019facab-1eee-765f-bd9f-ac2449151de1";
    const applyImport = vi.fn().mockResolvedValue({
      collectionId: importedCollectionId,
      collections: [
        { collectionId: importedCollectionId, parentCollectionId: null },
      ],
      requests: [],
    });
    const wrapper = mount(ImportDialog, {
      props: {
        selectedCollectionId: "019facab-1eee-765f-bd9f-ac2449151de2",
        selectedCollectionName: "Selected collection",
        busy: false,
        listProviders: vi.fn().mockResolvedValue({
          providers: [
            {
              id: "openapi-json",
              version: "1.0.0",
              label: "OpenAPI JSON",
              acceptedExtensions: [".json"],
              acceptedMediaTypes: ["application/json"],
              inputKinds: ["file"],
              capabilities: {
                multipleRequests: true,
                hierarchy: true,
                attachments: false,
                capturedResponses: false,
                responseExamples: true,
                variables: true,
              },
            },
          ],
        }),
        previewImport: vi.fn().mockResolvedValue(plan),
        applyImport,
        openTemporary: vi.fn(),
      },
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: "en-US",
            messages: { "en-US": enUsMessages },
          }),
        ],
        stubs: { DialogControl: { template: "<div><slot /></div>" } },
      },
    });
    await flushPromises();
    wrapper
      .findComponent(SelectMenu)
      .vm.$emit("update:modelValue", "openapi-json");
    await flushPromises();
    const fileInput = wrapper.get('input[type="file"]');
    Object.defineProperty(fileInput.element, "files", {
      configurable: true,
      value: [
        {
          name: "spec.json",
          text: vi.fn().mockResolvedValue('{"openapi":"3.1.0"}'),
        },
      ],
    });
    await fileInput.trigger("change");
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "Preview")
      ?.trigger("click");
    await flushPromises();

    const destinationSelect = wrapper
      .findAllComponents(SelectMenu)
      .find((select) => select.props("label") === "Destination");
    expect(destinationSelect?.props("modelValue")).toBe("workspace");
    const destinationOptions = destinationSelect?.props("options") as
      | readonly { readonly value: string; readonly disabled?: boolean }[]
      | undefined;
    expect(
      destinationOptions?.find((option) => option.value === "temporary"),
    ).toMatchObject({ disabled: true });
    const nameInput = wrapper.findComponent(TextInput);
    expect(nameInput.props("modelValue")).toBe("Example API");
    expect(wrapper.get(".import-selected-count").text()).toBe(
      "2 of 2 selected",
    );
    const bodySelect = wrapper
      .findAllComponents(SelectMenu)
      .find((select) => select.props("label") === "Request body for GET /one");
    expect(bodySelect?.props("modelValue")).toBe("body:json");
    bodySelect?.vm.$emit("update:modelValue", "body:text");
    await flushPromises();
    const metadata = wrapper.get(".import-preview-metadata");
    expect(metadata.findAll("dt").map((entry) => entry.text())).toEqual([
      "Title",
      "Import type",
      "Source file",
      "Server URL",
    ]);
    expect(metadata.findAll("dd").map((entry) => entry.text())).toEqual([
      "Example API",
      "OpenAPI JSON",
      "spec.json",
      "https://api.example.test/v1",
    ]);
    await nameInput.setValue("My imported API");
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "Import")
      ?.trigger("click");
    await flushPromises();

    expect(applyImport).toHaveBeenCalledWith({
      providerId: "openapi-json",
      sourceName: "spec.json",
      sourceText: '{"openapi":"3.1.0"}',
      plan,
      selectedItemIds: ["entry:0", "entry:1"],
      requestBodySelections: [{ itemId: "entry:0", optionId: "body:text" }],
      collectionName: "My imported API",
      parentCollectionId: null,
    });
  });
});
