import type {
  HttpMethod,
  RequestAttachment,
  RequestBodyDefinition,
  RequestField,
  VariableWrite,
} from "@/model/contracts/backend";
import type {
  CollectionPropertiesDraft,
  EnvironmentDraft,
  RequestDraftInput,
  RequestRecoveryWarning,
  WorkspacePropertiesDraft,
} from "@/model/domain/application";

const STORAGE_VERSION = 2;
const MANIFEST_KEY_PREFIX = "apinteract.request-session.v1";
const DATABASE_NAME = "apinteract-local-requests";
const DATABASE_VERSION = 1;
const TAB_STORE_NAME = "request-tabs";
const USER_INDEX_NAME = "userId";
const HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** Editable state retained for one open request tab in the browser database. */
export interface LocalRequestTabSnapshot {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly requestId: string | null;
  readonly baseDraftRevision: number | null;
  readonly baseVariableRevision: number | null;
  readonly pendingParentCollectionId: string | null;
  readonly draft: RequestDraftInput;
  readonly draftDirty: boolean;
  readonly variableDraft: readonly VariableWrite[] | null;
  readonly variableDirty: boolean;
  readonly omittedSecretValues: boolean;
  readonly recoveryWarnings: readonly RequestRecoveryWarning[];
}

/** Secret-safe editable state retained for one resource workbench tab. */
export type LocalResourceTabSnapshot =
  | {
      readonly kind: "workspace";
      readonly tabId: string;
      readonly workspaceId: string;
      readonly resourceId: string;
      readonly baseRevision: number;
      readonly baseVariableRevision: number;
      readonly draft: WorkspacePropertiesDraft;
      readonly dirty: boolean;
      readonly omittedSecretValues: boolean;
    }
  | {
      readonly kind: "collection";
      readonly tabId: string;
      readonly workspaceId: string;
      readonly resourceId: string;
      readonly baseRevision: number;
      readonly baseVariableRevision: number;
      readonly draft: CollectionPropertiesDraft;
      readonly dirty: boolean;
      readonly omittedSecretValues: boolean;
    }
  | {
      readonly kind: "environment";
      readonly tabId: string;
      readonly workspaceId: string;
      readonly resourceId: string | null;
      readonly baseRevision: number | null;
      readonly baseVariableRevision: null;
      readonly draft: EnvironmentDraft;
      readonly dirty: boolean;
      readonly omittedSecretValues: boolean;
    };

/** Complete local state projected from the current user's request workbench. */
export interface LocalRequestSessionSnapshot {
  readonly selectedWorkspaceId: string | null;
  readonly activeRequestTabId: string | null;
  readonly tabs: readonly LocalRequestTabSnapshot[];
  readonly activeWorkbenchTabId: string | null;
  readonly workbenchTabOrder: readonly string[];
  readonly resourceTabs: readonly LocalResourceTabSnapshot[];
}

/** One manifest entry joined with its optional IndexedDB payload. */
export interface RestoredRequestTabEntry {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly requestId: string | null;
  readonly snapshot: LocalRequestTabSnapshot | null;
}

/** Validated local session data ready for backend reconciliation. */
export interface RestoredRequestSession {
  readonly selectedWorkspaceId: string | null;
  readonly activeRequestTabId: string | null;
  readonly tabs: readonly RestoredRequestTabEntry[];
  readonly activeWorkbenchTabId: string | null;
  readonly workbenchTabOrder: readonly string[];
  readonly resourceTabs: readonly RestoredResourceTabEntry[];
}

/** One resource manifest entry joined with its validated IndexedDB payload. */
export interface RestoredResourceTabEntry {
  readonly kind: LocalResourceTabSnapshot["kind"];
  readonly tabId: string;
  readonly workspaceId: string;
  readonly resourceId: string | null;
  readonly snapshot: LocalResourceTabSnapshot | null;
}

/** Persists small tab manifests separately from potentially large draft bodies. */
export interface RequestSessionStorage {
  load(userId: string): Promise<RestoredRequestSession | null>;
  save(userId: string, snapshot: LocalRequestSessionSnapshot): Promise<void>;
  clear(userId: string): Promise<void>;
}

interface StoredManifest {
  readonly version: 1 | 2;
  readonly userId: string;
  readonly selectedWorkspaceId: string | null;
  readonly activeRequestTabId: string | null;
  readonly tabs: readonly StoredManifestTab[];
  readonly activeWorkbenchTabId?: string | null;
  readonly workbenchTabOrder?: readonly string[];
  readonly resourceTabs?: readonly StoredResourceManifestTab[];
}

interface StoredResourceManifestTab {
  readonly kind: LocalResourceTabSnapshot["kind"];
  readonly tabId: string;
  readonly workspaceId: string;
  readonly resourceId: string | null;
}

interface StoredManifestTab {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly requestId: string | null;
}

interface StoredTabRecord {
  readonly storageKey: string;
  readonly userId: string;
  readonly tabId: string;
  readonly payload: string;
}

/** Browser implementation backed by localStorage and an IndexedDB object store. */
export class BrowserRequestSessionStorage implements RequestSessionStorage {
  #databasePromise: Promise<IDBDatabase | null> | null = null;

  /** Loads and validates one authenticated user's local workbench state. */
  async load(userId: string): Promise<RestoredRequestSession | null> {
    const manifest = readManifest(userId);
    if (manifest === null) return null;
    const database = await this.#database();
    if (database === null) {
      return {
        selectedWorkspaceId: manifest.selectedWorkspaceId,
        activeRequestTabId: manifest.activeRequestTabId,
        tabs: manifest.tabs.map((tab) => ({ ...tab, snapshot: null })),
        activeWorkbenchTabId:
          manifest.activeWorkbenchTabId ?? manifest.activeRequestTabId,
        workbenchTabOrder:
          manifest.workbenchTabOrder ?? manifest.tabs.map((tab) => tab.tabId),
        resourceTabs: (manifest.resourceTabs ?? []).map((tab) => ({
          ...tab,
          snapshot: null,
        })),
      };
    }
    const transaction = database.transaction(TAB_STORE_NAME, "readonly");
    const store = transaction.objectStore(TAB_STORE_NAME);
    const entries = await Promise.all(
      manifest.tabs.map(async (tab): Promise<RestoredRequestTabEntry> => {
        const getRequest = store.get(
          tabStorageKey(userId, tab.tabId),
        ) as IDBRequest<StoredTabRecord | undefined>;
        const record = await requestResult<StoredTabRecord | undefined>(
          getRequest,
        );
        return {
          ...tab,
          snapshot: parseTabRecord(record, userId, tab),
        };
      }),
    );
    const resourceEntries = await Promise.all(
      (manifest.resourceTabs ?? []).map(
        async (tab): Promise<RestoredResourceTabEntry> => {
          const getRequest = store.get(
            tabStorageKey(userId, tab.tabId),
          ) as IDBRequest<StoredTabRecord | undefined>;
          const record = await requestResult<StoredTabRecord | undefined>(
            getRequest,
          );
          return {
            ...tab,
            snapshot: parseResourceTabRecord(record, userId, tab),
          };
        },
      ),
    );
    await transactionCompletion(transaction);
    return {
      selectedWorkspaceId: manifest.selectedWorkspaceId,
      activeRequestTabId: manifest.activeRequestTabId,
      tabs: entries,
      activeWorkbenchTabId:
        manifest.activeWorkbenchTabId ?? manifest.activeRequestTabId,
      workbenchTabOrder:
        manifest.workbenchTabOrder ?? manifest.tabs.map((tab) => tab.tabId),
      resourceTabs: resourceEntries,
    };
  }

  /** Commits removals before cleanup and additions after their payloads exist. */
  async save(
    userId: string,
    snapshot: LocalRequestSessionSnapshot,
  ): Promise<void> {
    const removalSnapshot = manifestRemovalSnapshot(userId, snapshot);
    if (removalSnapshot !== null) {
      writeManifest(userId, removalSnapshot);
    }
    const database = await this.#database();
    if (database !== null) {
      await writeTabRecords(database, userId, [
        ...snapshot.tabs,
        ...snapshot.resourceTabs,
      ]);
    }
    writeManifest(userId, snapshot);
  }

  /** Removes one user's manifest and every locally retained request payload. */
  async clear(userId: string): Promise<void> {
    removeManifest(userId);
    const database = await this.#database();
    if (database !== null) {
      await deleteUserTabRecords(database, userId);
    }
  }

  /** Opens the versioned request database without making persistence mandatory. */
  async #database(): Promise<IDBDatabase | null> {
    if (this.#databasePromise === null) {
      this.#databasePromise = openDatabase();
    }
    return this.#databasePromise;
  }
}

/**
 * Builds a manifest that immediately forgets removed tabs without publishing
 * newly added tabs before their IndexedDB payloads have committed.
 */
function manifestRemovalSnapshot(
  userId: string,
  snapshot: LocalRequestSessionSnapshot,
): LocalRequestSessionSnapshot | null {
  const previousManifest = readManifest(userId);
  if (previousManifest === null) return null;
  const retainedTabIds = new Set(snapshot.tabs.map((tab) => tab.tabId));
  const retainedResourceTabIds = new Set(
    snapshot.resourceTabs.map((tab) => tab.tabId),
  );
  if (
    !previousManifest.tabs.some((tab) => !retainedTabIds.has(tab.tabId)) &&
    !(previousManifest.resourceTabs ?? []).some(
      (tab) => !retainedResourceTabIds.has(tab.tabId),
    )
  ) {
    return null;
  }
  const previousTabIds = new Set(previousManifest.tabs.map((tab) => tab.tabId));
  const retainedTabs = snapshot.tabs.filter((tab) =>
    previousTabIds.has(tab.tabId),
  );
  const previousResourceIds = new Set(
    (previousManifest.resourceTabs ?? []).map((tab) => tab.tabId),
  );
  const retainedResourceTabs = snapshot.resourceTabs.filter((tab) =>
    previousResourceIds.has(tab.tabId),
  );
  const retainedIds = new Set([
    ...retainedTabs.map((tab) => tab.tabId),
    ...retainedResourceTabs.map((tab) => tab.tabId),
  ]);
  return {
    selectedWorkspaceId: snapshot.selectedWorkspaceId,
    activeRequestTabId: retainedTabs.some(
      (tab) => tab.tabId === snapshot.activeRequestTabId,
    )
      ? snapshot.activeRequestTabId
      : null,
    tabs: retainedTabs,
    activeWorkbenchTabId:
      snapshot.activeWorkbenchTabId !== null &&
      retainedIds.has(snapshot.activeWorkbenchTabId)
        ? snapshot.activeWorkbenchTabId
        : null,
    workbenchTabOrder: snapshot.workbenchTabOrder.filter((tabId) =>
      retainedIds.has(tabId),
    ),
    resourceTabs: retainedResourceTabs,
  };
}

/** Returns variable writes safe for local persistence and whether values were omitted. */
export function redactSecretVariableWrites(
  variables: readonly VariableWrite[] | null,
): {
  readonly variables: VariableWrite[] | null;
  readonly omittedSecretValues: boolean;
} {
  if (variables === null) {
    return { variables: null, omittedSecretValues: false };
  }
  let omittedSecretValues = false;
  const safeVariables = variables.map((variable): VariableWrite => {
    if (variable.kind !== "secret" || variable.value === undefined) {
      return { ...variable };
    }
    omittedSecretValues = true;
    return {
      ...(variable.variableId === undefined
        ? {}
        : { variableId: variable.variableId }),
      name: variable.name,
      kind: "secret",
      ...(variable.clearValue === undefined
        ? {}
        : { clearValue: variable.clearValue }),
    };
  });
  return { variables: safeVariables, omittedSecretValues };
}

/** Writes a validated manifest containing only identifiers and tab ordering. */
function writeManifest(
  userId: string,
  snapshot: LocalRequestSessionSnapshot,
): void {
  const storage = browserLocalStorage();
  if (storage === null) return;
  const manifest: StoredManifest = {
    version: STORAGE_VERSION,
    userId,
    selectedWorkspaceId: snapshot.selectedWorkspaceId,
    activeRequestTabId: snapshot.activeRequestTabId,
    tabs: snapshot.tabs.map((tab) => ({
      tabId: tab.tabId,
      workspaceId: tab.workspaceId,
      requestId: tab.requestId,
    })),
    activeWorkbenchTabId: snapshot.activeWorkbenchTabId,
    workbenchTabOrder: snapshot.workbenchTabOrder,
    resourceTabs: snapshot.resourceTabs.map((tab) => ({
      kind: tab.kind,
      tabId: tab.tabId,
      workspaceId: tab.workspaceId,
      resourceId: tab.resourceId,
    })),
  };
  storage.setItem(manifestKey(userId), JSON.stringify(manifest));
}

/** Loads a manifest only when its version, owner, and identifier shapes match. */
function readManifest(userId: string): StoredManifest | null {
  const storage = browserLocalStorage();
  if (storage === null) return null;
  try {
    const value = storage.getItem(manifestKey(userId));
    if (value === null) return null;
    const parsed: unknown = JSON.parse(value);
    return isStoredManifest(parsed, userId) ? parsed : null;
  } catch {
    return null;
  }
}

/** Removes a manifest without exposing storage failures to application workflows. */
function removeManifest(userId: string): void {
  try {
    browserLocalStorage()?.removeItem(manifestKey(userId));
  } catch {
    // Browser persistence is best-effort and must not block logout.
  }
}

/** Returns localStorage when the current runtime exposes usable browser storage. */
function browserLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Opens or upgrades the browser database used for request draft payloads. */
function openDatabase(): Promise<IDBDatabase | null> {
  if (globalThis.indexedDB === undefined) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    /** Resolves the open attempt exactly once and closes late database handles. */
    const finish = (database: IDBDatabase | null): void => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(TAB_STORE_NAME)
        ? request.transaction?.objectStore(TAB_STORE_NAME)
        : database.createObjectStore(TAB_STORE_NAME, { keyPath: "storageKey" });
      if (store !== undefined && !store.indexNames.contains(USER_INDEX_NAME)) {
        store.createIndex(USER_INDEX_NAME, "userId", { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      finish(request.result);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}

/** Replaces one user's IndexedDB payload set in a single transaction. */
async function writeTabRecords(
  database: IDBDatabase,
  userId: string,
  snapshots: readonly (LocalRequestTabSnapshot | LocalResourceTabSnapshot)[],
): Promise<void> {
  const transaction = database.transaction(TAB_STORE_NAME, "readwrite");
  const store = transaction.objectStore(TAB_STORE_NAME);
  const retainedKeys = new Set(
    snapshots.map((snapshot) => tabStorageKey(userId, snapshot.tabId)),
  );
  for (const snapshot of snapshots) {
    const record: StoredTabRecord = {
      storageKey: tabStorageKey(userId, snapshot.tabId),
      userId,
      tabId: snapshot.tabId,
      payload: JSON.stringify(snapshot),
    };
    store.put(record);
  }
  await deleteUserRecordsExcept(store, userId, retainedKeys);
  await transactionCompletion(transaction);
}

/** Deletes every IndexedDB request payload owned by one local user. */
async function deleteUserTabRecords(
  database: IDBDatabase,
  userId: string,
): Promise<void> {
  const transaction = database.transaction(TAB_STORE_NAME, "readwrite");
  const store = transaction.objectStore(TAB_STORE_NAME);
  await deleteUserRecordsExcept(store, userId, new Set());
  await transactionCompletion(transaction);
}

/** Removes indexed records not present in the retained storage-key set. */
function deleteUserRecordsExcept(
  store: IDBObjectStore,
  userId: string,
  retainedKeys: ReadonlySet<string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.index(USER_INDEX_NAME).openCursor(userId);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve();
        return;
      }
      if (
        typeof cursor.primaryKey !== "string" ||
        !retainedKeys.has(cursor.primaryKey)
      ) {
        cursor.delete();
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("Cursor failed"));
  });
}

/** Converts one IndexedDB request into a Promise of its result. */
function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Request failed"));
  });
}

/** Resolves after a transaction commits or rejects when it aborts. */
function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Transaction aborted"));
  });
}

/** Parses and validates one IndexedDB payload against its manifest identity. */
function parseTabRecord(
  record: StoredTabRecord | undefined,
  userId: string,
  manifestTab: StoredManifestTab,
): LocalRequestTabSnapshot | null {
  if (
    record === undefined ||
    record.userId !== userId ||
    record.tabId !== manifestTab.tabId ||
    record.storageKey !== tabStorageKey(userId, manifestTab.tabId)
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(record.payload);
    return isLocalRequestTabSnapshot(parsed, manifestTab) ? parsed : null;
  } catch {
    return null;
  }
}

/** Parses and validates one resource-editor payload against manifest identity. */
function parseResourceTabRecord(
  record: StoredTabRecord | undefined,
  userId: string,
  manifestTab: StoredResourceManifestTab,
): LocalResourceTabSnapshot | null {
  if (
    record === undefined ||
    record.userId !== userId ||
    record.tabId !== manifestTab.tabId ||
    record.storageKey !== tabStorageKey(userId, manifestTab.tabId)
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(record.payload);
    return isLocalResourceTabSnapshot(parsed, manifestTab) ? parsed : null;
  } catch {
    return null;
  }
}

/** Validates the localStorage trust boundary for one user's manifest. */
function isStoredManifest(
  value: unknown,
  userId: string,
): value is StoredManifest {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== STORAGE_VERSION) ||
    value.userId !== userId
  ) {
    return false;
  }
  if (
    !isNullableString(value.selectedWorkspaceId) ||
    !isNullableString(value.activeRequestTabId) ||
    !Array.isArray(value.tabs)
  ) {
    return false;
  }
  if (
    value.activeWorkbenchTabId !== undefined &&
    !isNullableString(value.activeWorkbenchTabId)
  ) {
    return false;
  }
  if (
    value.workbenchTabOrder !== undefined &&
    (!Array.isArray(value.workbenchTabOrder) ||
      !value.workbenchTabOrder.every((tabId) => typeof tabId === "string"))
  ) {
    return false;
  }
  if (value.resourceTabs !== undefined && !Array.isArray(value.resourceTabs)) {
    return false;
  }
  const tabIds = new Set<string>();
  const requestTabsValid = value.tabs.every((tab) => {
    if (
      !isRecord(tab) ||
      typeof tab.tabId !== "string" ||
      typeof tab.workspaceId !== "string" ||
      !isNullableString(tab.requestId) ||
      tabIds.has(tab.tabId)
    ) {
      return false;
    }
    tabIds.add(tab.tabId);
    return true;
  });
  if (!requestTabsValid) return false;
  return (value.resourceTabs ?? []).every((tab) => {
    if (
      !isRecord(tab) ||
      (tab.kind !== "workspace" &&
        tab.kind !== "collection" &&
        tab.kind !== "environment") ||
      typeof tab.tabId !== "string" ||
      typeof tab.workspaceId !== "string" ||
      !isNullableString(tab.resourceId) ||
      tabIds.has(tab.tabId)
    ) {
      return false;
    }
    if (tab.kind !== "environment" && tab.resourceId === null) return false;
    tabIds.add(tab.tabId);
    return true;
  });
}

/** Validates a request payload loaded from the browser database. */
function isLocalRequestTabSnapshot(
  value: unknown,
  manifestTab: StoredManifestTab,
): value is LocalRequestTabSnapshot {
  return (
    isRecord(value) &&
    value.tabId === manifestTab.tabId &&
    value.workspaceId === manifestTab.workspaceId &&
    value.requestId === manifestTab.requestId &&
    isNullableNumber(value.baseDraftRevision) &&
    isNullableNumber(value.baseVariableRevision) &&
    isNullableString(value.pendingParentCollectionId) &&
    isRequestDraft(value.draft) &&
    typeof value.draftDirty === "boolean" &&
    (value.variableDraft === null ||
      (Array.isArray(value.variableDraft) &&
        value.variableDraft.every(isVariableWrite))) &&
    typeof value.variableDirty === "boolean" &&
    typeof value.omittedSecretValues === "boolean" &&
    Array.isArray(value.recoveryWarnings) &&
    value.recoveryWarnings.every(
      (warning) => warning === "stale" || warning === "secrets-omitted",
    )
  );
}

/** Validates one secret-safe resource draft loaded from browser storage. */
function isLocalResourceTabSnapshot(
  value: unknown,
  manifestTab: StoredResourceManifestTab,
): value is LocalResourceTabSnapshot {
  if (
    !isRecord(value) ||
    value.kind !== manifestTab.kind ||
    value.tabId !== manifestTab.tabId ||
    value.workspaceId !== manifestTab.workspaceId ||
    value.resourceId !== manifestTab.resourceId ||
    typeof value.omittedSecretValues !== "boolean" ||
    typeof value.dirty !== "boolean"
  ) {
    return false;
  }
  if (value.kind === "workspace") {
    return (
      typeof value.baseRevision === "number" &&
      typeof value.baseVariableRevision === "number" &&
      isWorkspacePropertiesDraft(value.draft)
    );
  }
  if (value.kind === "collection") {
    return (
      typeof value.baseRevision === "number" &&
      typeof value.baseVariableRevision === "number" &&
      isCollectionPropertiesDraft(value.draft)
    );
  }
  return (
    value.kind === "environment" &&
    isNullableNumber(value.baseRevision) &&
    value.baseVariableRevision === null &&
    isEnvironmentDraft(value.draft)
  );
}

/** Validates one persisted workspace-properties draft. */
function isWorkspacePropertiesDraft(
  value: unknown,
): value is WorkspacePropertiesDraft {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.baseUrl === "string" &&
    isFieldArray(value.headers) &&
    isVariableWriteArray(value.variables)
  );
}

/** Validates one persisted collection-properties draft. */
function isCollectionPropertiesDraft(
  value: unknown,
): value is CollectionPropertiesDraft {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.pathPrefix === "string" &&
    isFieldArray(value.headers) &&
    isVariableWriteArray(value.variables)
  );
}

/** Validates one persisted environment draft. */
function isEnvironmentDraft(value: unknown): value is EnvironmentDraft {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isVariableWriteArray(value.variables) &&
    Array.isArray(value.includedEnvironmentIds) &&
    value.includedEnvironmentIds.every((id) => typeof id === "string")
  );
}

/** Validates an array of structured request fields. */
function isFieldArray(value: unknown): value is RequestField[] {
  return Array.isArray(value) && value.every(isRequestField);
}

/** Validates an array of secret-safe variable writes. */
function isVariableWriteArray(value: unknown): value is VariableWrite[] {
  return Array.isArray(value) && value.every(isVariableWrite);
}

/** Validates editable request content before it crosses into application state. */
function isRequestDraft(value: unknown): value is RequestDraftInput {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.method === "string" &&
    HTTP_METHODS.has(value.method as HttpMethod) &&
    (value.targetMode === "absolute" || value.targetMode === "composed") &&
    typeof value.targetUrl === "string" &&
    Array.isArray(value.query) &&
    value.query.every(isRequestField) &&
    Array.isArray(value.headers) &&
    value.headers.every(isRequestField) &&
    (value.requestBody === undefined || isRequestBody(value.requestBody)) &&
    typeof value.body === "string" &&
    typeof value.preRequestScript === "string" &&
    typeof value.postResponseScript === "string"
  );
}

/** Validates one semantic request-body variant and its nested fields. */
function isRequestBody(value: unknown): value is RequestBodyDefinition {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "none":
      return true;
    case "text":
      return (
        isNullableString(value.contentType) && typeof value.text === "string"
      );
    case "file":
      return (
        isNullableString(value.contentType) && isAttachment(value.attachment)
      );
    case "urlencoded":
      return (
        isNullableString(value.contentType) &&
        Array.isArray(value.fields) &&
        value.fields.every(isRequestField)
      );
    case "multipart":
      return (
        isNullableString(value.contentType) &&
        typeof value.boundary === "string" &&
        Array.isArray(value.fields) &&
        value.fields.every(
          (field) =>
            isRequestField(field) ||
            (isRecord(field) &&
              field.kind === "file" &&
              typeof field.name === "string" &&
              typeof field.enabled === "boolean" &&
              isAttachment(field.attachment)),
        )
      );
    default:
      return false;
  }
}

/** Validates attachment metadata without accepting raw browser File objects. */
function isAttachment(value: unknown): value is RequestAttachment {
  return (
    isRecord(value) &&
    typeof value.attachmentId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.fileName === "string" &&
    typeof value.contentType === "string" &&
    typeof value.byteLength === "number" &&
    typeof value.sha256 === "string"
  );
}

/** Validates one structured query, header, or form field. */
function isRequestField(value: unknown): value is RequestField {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.value === "string" &&
    typeof value.enabled === "boolean" &&
    (value.mode === undefined ||
      value.mode === "override" ||
      value.mode === "append")
  );
}

/** Validates one non-secret or redacted secret variable write. */
function isVariableWrite(value: unknown): value is VariableWrite {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    (value.variableId !== undefined && typeof value.variableId !== "string")
  ) {
    return false;
  }
  switch (value.kind) {
    case "value":
      return typeof value.value === "string";
    case "secret":
      return (
        value.value === undefined &&
        (value.clearValue === undefined ||
          typeof value.clearValue === "boolean")
      );
    case "alias":
      return typeof value.target === "string";
    case "unset":
      return true;
    default:
      return false;
  }
}

/** Reports whether a value is a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reports whether a value is a string or explicit null. */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Reports whether a value is a finite number or explicit null. */
function isNullableNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

/** Builds the per-user localStorage manifest key. */
function manifestKey(userId: string): string {
  return `${MANIFEST_KEY_PREFIX}:${userId}`;
}

/** Builds a collision-free IndexedDB primary key for one user's tab. */
function tabStorageKey(userId: string, tabId: string): string {
  return `${userId}:${tabId}`;
}
