// @vitest-environment jsdom

import { createI18n } from "vue-i18n";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enUsMessages } from "../src/app/i18n/messages";
import type { TreeNode } from "../src/model/contracts/backend";
import type { CollectionChildrenState } from "../src/model/domain/application";
import WorkspaceNavigator from "../src/view/presentation/features/WorkspaceNavigator.vue";

const workspaceId = "019fa8be-a510-76b9-b73b-69f4c7af7870";
const firstNodeId = "019fa8be-a510-76b9-b73b-69f4c7af7871";
const secondNodeId = "019fa8be-a510-76b9-b73b-69f4c7af7872";
const thirdNodeId = "019fa8be-a510-76b9-b73b-69f4c7af7873";

/** Creates a request tree node with an explicit sibling-order revision. */
function requestNode(
  nodeId: string,
  name: string,
  position: number,
  orderRevision = 4,
): TreeNode {
  return {
    nodeId,
    kind: "request",
    name,
    position,
    orderRevision,
    method: "GET",
  };
}

/** Mounts the navigator with the requested tree and interaction state. */
function mountNavigator(options?: {
  selectedWorkspaceId?: string | null;
  rootNodes?: readonly TreeNode[];
  collectionChildren?: Readonly<Record<string, readonly TreeNode[]>>;
  collectionChildStates?: Readonly<Record<string, CollectionChildrenState>>;
  expandedCollectionIds?: readonly string[];
  busy?: boolean;
  canEdit?: boolean;
}) {
  const i18n = createI18n({
    legacy: false,
    locale: "en-US",
    messages: { "en-US": enUsMessages },
  });
  return mount(WorkspaceNavigator, {
    attachTo: document.body,
    props: {
      workspaces: [{ workspaceId, name: "Workspace", role: "owner" }],
      selectedWorkspaceId:
        options?.selectedWorkspaceId === undefined
          ? workspaceId
          : options.selectedWorkspaceId,
      rootNodes: options?.rootNodes ?? [
        requestNode(firstNodeId, "First", 0),
        requestNode(secondNodeId, "Second", 1),
        requestNode(thirdNodeId, "Third", 2),
      ],
      selectedCollectionId: null,
      collectionChildren:
        options?.collectionChildStates ??
        Object.fromEntries(
          Object.entries(options?.collectionChildren ?? {}).map(
            ([collectionId, children]) => [
              collectionId,
              { status: "ready" as const, children },
            ],
          ),
        ),
      expandedCollectionIds: options?.expandedCollectionIds ?? [],
      selectedRequestId: null,
      busy: options?.busy ?? false,
      canEdit: options?.canEdit ?? true,
      mobileOpen: false,
    },
    global: { plugins: [i18n] },
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("WorkspaceNavigator selection", () => {
  it("mutes the placeholder and preserves a disabled properties control", () => {
    const wrapper = mountNavigator({
      selectedWorkspaceId: null,
      rootNodes: [],
    });

    expect(wrapper.get(".select-menu-selected").classes()).toContain(
      "is-placeholder",
    );
    expect(wrapper.get(".select-menu-selected").text()).toBe(
      "Select a workspace",
    );
    expect(
      wrapper
        .get<HTMLButtonElement>('button[aria-label="Workspace properties"]')
        .attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.find(".navigator-grow").exists()).toBe(false);
    wrapper.unmount();
  });

  it("offers an explicit option to deselect the current workspace", async () => {
    const wrapper = mountNavigator();

    await wrapper.get(".select-menu-trigger").trigger("click");
    await flushPromises();
    const noWorkspaceOption = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ].find((option) => option.textContent?.includes("No workspace"));
    expect(noWorkspaceOption).toBeDefined();
    noWorkspaceOption?.click();
    await flushPromises();

    expect(wrapper.emitted("selectWorkspace")).toEqual([[null]]);
    wrapper.unmount();
  });

  it("opens a collection from its main row without hijacking row controls", async () => {
    const collection: TreeNode = {
      nodeId: firstNodeId,
      kind: "collection",
      name: "Examples",
      position: 0,
      orderRevision: 1,
    };
    const wrapper = mountNavigator({ rootNodes: [collection] });

    await wrapper.get(`[data-tree-node-id="${firstNodeId}"]`).trigger("click");
    expect(wrapper.emitted("editCollectionProperties")).toEqual([
      [firstNodeId],
    ]);
    expect(wrapper.emitted("toggleCollection")).toBeUndefined();

    await wrapper.get('button[aria-label="Expand Examples"]').trigger("click");
    await wrapper
      .get('button[aria-label="More actions for Examples"]')
      .trigger("click");
    expect(wrapper.emitted("editCollectionProperties")).toHaveLength(1);
    expect(wrapper.emitted("toggleCollection")).toEqual([[firstNodeId]]);
    wrapper.unmount();
  });

  it("shows loading and failure states without claiming an unloaded branch is empty", async () => {
    const collection: TreeNode = {
      nodeId: firstNodeId,
      kind: "collection",
      name: "Examples",
      position: 0,
      orderRevision: 1,
    };
    const wrapper = mountNavigator({
      rootNodes: [collection],
      expandedCollectionIds: [firstNodeId],
      collectionChildStates: {
        [firstNodeId]: { status: "loading", children: [] },
      },
    });

    expect(wrapper.text()).toContain("Loading collection");
    expect(wrapper.text()).not.toContain("This collection is empty");

    await wrapper.setProps({
      collectionChildren: {
        [firstNodeId]: { status: "error", children: [] },
      },
    });
    expect(wrapper.text()).toContain("Could not load this collection");
    await wrapper.get(".tree-branch-retry").trigger("click");
    expect(wrapper.emitted("retryCollection")).toEqual([[firstNodeId]]);

    await wrapper.setProps({
      collectionChildren: {
        [firstNodeId]: { status: "ready", children: [] },
      },
    });
    expect(wrapper.text()).toContain("This collection is empty");
    wrapper.unmount();
  });
});

describe("WorkspaceNavigator tree reordering", () => {
  it("offers duplicate and delete actions for requests without selecting them", async () => {
    const wrapper = mountNavigator({
      rootNodes: [requestNode(firstNodeId, "First", 0)],
    });
    const trigger = wrapper.get<HTMLButtonElement>(
      'button[aria-label="More actions for First"]',
    );

    await trigger.trigger("click");
    await flushPromises();
    const duplicate = [
      ...document.body.querySelectorAll("[role=menuitem]"),
    ].find((item) => item.textContent?.includes("Duplicate request"));
    duplicate?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("duplicateRequest")).toEqual([
      [firstNodeId, "First"],
    ]);
    expect(wrapper.emitted("selectRequest")).toBeUndefined();

    await trigger.trigger("click");
    await flushPromises();
    const remove = [...document.body.querySelectorAll("[role=menuitem]")].find(
      (item) => item.textContent?.includes("Delete request"),
    );
    remove?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("deleteRequest")).toEqual([[firstNodeId]]);
    expect(wrapper.emitted("selectRequest")).toBeUndefined();
    wrapper.unmount();
  });

  it("keeps requests selectable while disabling mutations for viewers", () => {
    const wrapper = mountNavigator({
      rootNodes: [requestNode(firstNodeId, "First", 0)],
      canEdit: false,
    });

    expect(
      wrapper
        .get<HTMLButtonElement>(`[data-tree-node-id="${firstNodeId}"]`)
        .attributes("disabled"),
    ).toBeUndefined();
    expect(
      wrapper
        .get<HTMLButtonElement>('button[aria-label="More actions for First"]')
        .attributes("disabled"),
    ).toBeDefined();
    wrapper.unmount();
  });

  it("moves a sibling with Alt+Arrow and emits the complete current order", async () => {
    const wrapper = mountNavigator();

    await wrapper
      .get(`[data-tree-node-id="${firstNodeId}"]`)
      .trigger("keydown", { key: "ArrowDown", altKey: true });

    expect(wrapper.emitted("reorderTree")).toEqual([
      [null, [secondNodeId, firstNodeId, thirdNodeId], 4],
    ]);
    expect(wrapper.get('[aria-live="polite"]').text()).toBe(
      "Moved First to position 2.",
    );
    wrapper.unmount();
  });

  it("drops a dragged sibling before or after another sibling", async () => {
    const wrapper = mountNavigator();
    const first = wrapper.get<HTMLElement>(
      `[data-tree-node-id="${firstNodeId}"]`,
    );
    const third = wrapper.get<HTMLElement>(
      `[data-tree-node-id="${thirdNodeId}"]`,
    );
    vi.spyOn(third.element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 200,
      bottom: 40,
      left: 0,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "uninitialized",
      setData: vi.fn(),
    };

    await first.trigger("dragstart", { dataTransfer });
    await third.trigger("dragover", { clientY: 30, dataTransfer });
    await third.trigger("drop", { clientY: 30, dataTransfer });

    expect(wrapper.emitted("reorderTree")).toEqual([
      [null, [secondNodeId, thirdNodeId, firstNodeId], 4],
    ]);
    wrapper.unmount();
  });

  it("moves across parents and blocks moves while busy", async () => {
    const collectionId = "019fa8be-a510-76b9-b73b-69f4c7af7874";
    const childNodeId = "019fa8be-a510-76b9-b73b-69f4c7af7875";
    const collection: TreeNode = {
      nodeId: collectionId,
      kind: "collection",
      name: "Nested",
      position: 0,
      orderRevision: 7,
    };
    const wrapper = mountNavigator({
      rootNodes: [collection, requestNode(firstNodeId, "Root request", 1, 7)],
      collectionChildren: {
        [collectionId]: [requestNode(childNodeId, "Child request", 0, 2)],
      },
      expandedCollectionIds: [collectionId],
    });
    const rootRequest = wrapper.get<HTMLElement>(
      `[data-tree-node-id="${firstNodeId}"]`,
    );
    const childRequest = wrapper.get<HTMLElement>(
      `[data-tree-node-id="${childNodeId}"]`,
    );
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "uninitialized",
      setData: vi.fn(),
    };

    await rootRequest.trigger("dragstart", { dataTransfer });
    await childRequest.trigger("dragover", { clientY: 0, dataTransfer });
    await childRequest.trigger("drop", { clientY: 0, dataTransfer });
    expect(wrapper.emitted("moveTree")).toEqual([
      [firstNodeId, childNodeId, "after", 7],
    ]);
    wrapper.unmount();

    const busyWrapper = mountNavigator({ busy: true });
    const disabledFirst = busyWrapper.get(
      `[data-tree-node-id="${firstNodeId}"]`,
    );
    expect(disabledFirst.attributes("draggable")).toBe("false");
    await disabledFirst.trigger("keydown", {
      key: "ArrowDown",
      altKey: true,
    });
    expect(busyWrapper.emitted("reorderTree")).toBeUndefined();
    expect(busyWrapper.emitted("moveTree")).toBeUndefined();
    busyWrapper.unmount();
  });

  it("drops into collections and supports keyboard indent and outdent", async () => {
    const collectionId = "019fa8be-a510-76b9-b73b-69f4c7af7874";
    const childNodeId = "019fa8be-a510-76b9-b73b-69f4c7af7875";
    const collection: TreeNode = {
      nodeId: collectionId,
      kind: "collection",
      name: "Destination",
      position: 0,
      orderRevision: 7,
    };
    const wrapper = mountNavigator({
      rootNodes: [collection, requestNode(firstNodeId, "Root request", 1, 7)],
      collectionChildren: {
        [collectionId]: [requestNode(childNodeId, "Child request", 0, 2)],
      },
      expandedCollectionIds: [collectionId],
    });
    const rootRequest = wrapper.get<HTMLElement>(
      `[data-tree-node-id="${firstNodeId}"]`,
    );
    const collectionRow = wrapper.get<HTMLElement>(".collection-tree-row");
    const requestRow = wrapper.get<HTMLElement>(".request-tree-row");
    expect(collectionRow.element.children[0]?.classList).toContain(
      "tree-toggle-button",
    );
    expect(requestRow.element.children[0]?.classList).toContain(
      "tree-toggle-spacer",
    );
    expect(collectionRow.element.children[1]?.classList).toContain(
      "tree-node-main",
    );
    expect(requestRow.element.children[1]?.classList).toContain(
      "tree-node-main",
    );
    vi.spyOn(collectionRow.element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 200,
      bottom: 40,
      left: 0,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "uninitialized",
      setData: vi.fn(),
    };

    await rootRequest.trigger("dragstart", { dataTransfer });
    await collectionRow.trigger("dragover", { clientY: 10, dataTransfer });
    expect(collectionRow.classes()).toContain("is-drop-before");
    await collectionRow.trigger("drop", { clientY: 10, dataTransfer });
    expect(wrapper.emitted("reorderTree")?.[0]).toEqual([
      null,
      [firstNodeId, collectionId],
      7,
    ]);

    await rootRequest.trigger("dragstart", { dataTransfer });
    await collectionRow.trigger("dragover", { clientY: 20, dataTransfer });
    expect(collectionRow.classes()).toContain("is-drop-inside");
    await collectionRow.trigger("drop", { clientY: 20, dataTransfer });
    expect(wrapper.emitted("moveTree")?.[0]).toEqual([
      firstNodeId,
      collectionId,
      "inside",
      7,
    ]);

    await rootRequest.trigger("keydown", {
      key: "ArrowRight",
      altKey: true,
    });
    expect(wrapper.emitted("moveTree")?.[1]).toEqual([
      firstNodeId,
      collectionId,
      "inside",
      7,
    ]);
    await wrapper
      .get(`[data-tree-node-id="${childNodeId}"]`)
      .trigger("keydown", { key: "ArrowLeft", altKey: true });
    expect(wrapper.emitted("moveTree")?.[2]).toEqual([
      childNodeId,
      collectionId,
      "after",
      2,
    ]);
    wrapper.unmount();
  });
});
