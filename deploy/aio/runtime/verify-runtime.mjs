import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { stdin } from "node:process";
import { parseArgs } from "node:util";

const requireFromBackend = createRequire(
  "/opt/apinteract/backend/package.json",
);
const WebSocket = requireFromBackend("ws");

/** Runs the selected verification phase after all harness classes initialize. */
async function main() {
  const { values } = parseArgs({
    options: {
      phase: { type: "string" },
      origin: {
        type: "string",
        default:
          process.env.APINTERACT_AIO_PUBLIC_ORIGIN ?? "http://localhost:8080",
      },
      target: { type: "string", default: "http://target:8090/echo" },
      state: { type: "string" },
    },
  });
  if (
    values.phase !== "create" &&
    values.phase !== "restore" &&
    values.phase !== "failure"
  ) {
    throw new Error("--phase must be create, restore, or failure");
  }

  const password = await readStandardInput();
  if (password.length === 0) {
    throw new Error(
      "The verification administrator password is required on stdin",
    );
  }
  const accessToken = await login(values.origin, password);
  const client = new VerificationWebSocketClient(values.origin);
  await client.connect(accessToken);
  try {
    if (values.phase === "create") {
      const state = await createPersistentJourney(
        client,
        accessToken,
        values.target,
      );
      process.stdout.write(
        `${Buffer.from(JSON.stringify(state)).toString("base64url")}\n`,
      );
    } else if (values.phase === "restore") {
      if (values.state === undefined) {
        throw new Error("--state is required for the restore phase");
      }
      const state = JSON.parse(
        Buffer.from(values.state, "base64url").toString("utf8"),
      );
      await verifyRestoredJourney(client, accessToken, state);
      process.stdout.write("AIO persistence verification passed.\n");
    } else {
      await verifyExecutionFailure(client);
      process.stdout.write("AIO execution-failure verification passed.\n");
    }
  } finally {
    client.close();
  }
}

/** Reads one secret from standard input without placing it in process arguments. */
async function readStandardInput() {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trimEnd();
}

/** Authenticates through the public backend HTTP boundary. */
async function login(origin, password) {
  const response = await fetch("http://127.0.0.1:8080/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      providerId: "local-password",
      fields: { username: "admin", password },
    }),
  });
  if (!response.ok) {
    throw new Error(`Verification login failed with HTTP ${response.status}`);
  }
  const credential = await response.json();
  if (typeof credential.accessToken !== "string") {
    throw new Error("Verification login did not return an access token");
  }
  return credential.accessToken;
}

/** Creates, executes, and checks one product-shaped persistent request journey. */
async function createPersistentJourney(client, accessToken, targetUrl) {
  const marker = `aio-${Date.now()}`;
  const workspaceName = `AIO verification ${marker}`;
  const collectionName = "Persistent collection";
  const requestName = "Persistent request";
  const workspace = await client.command("workspace.create", {
    name: workspaceName,
  });
  await client.command("variable_profile.update", {
    scopeKind: "workspace",
    scopeId: workspace.workspaceId,
    expectedRevision: 0,
    variables: [
      { name: "workspace_marker", kind: "value", value: `workspace-${marker}` },
    ],
  });
  const environment = await client.command("environment.create", {
    workspaceId: workspace.workspaceId,
    name: "Persistent environment",
    variables: [
      { name: "base_url", kind: "value", value: targetUrl },
      { name: "marker", kind: "value", value: marker },
      { name: "token", kind: "secret", value: `secret-${marker}` },
    ],
  });
  await client.command("environment.select", {
    workspaceId: workspace.workspaceId,
    environmentId: environment.environmentId,
  });
  const collection = await client.command("collection.create", {
    workspaceId: workspace.workspaceId,
    parentCollectionId: null,
    name: collectionName,
  });
  await client.command("collection.headers.update", {
    collectionId: collection.nodeId,
    expectedRevision: 0,
    headers: [{ name: "X-AIO-Inherited", value: marker, enabled: true }],
  });
  await client.command("variable_profile.update", {
    scopeKind: "collection",
    scopeId: collection.nodeId,
    expectedRevision: 0,
    variables: [
      {
        name: "collection_marker",
        kind: "value",
        value: `collection-${marker}`,
      },
      { name: "marker", kind: "value", value: `collection-${marker}` },
    ],
  });
  const request = await client.command("request.create", {
    workspaceId: workspace.workspaceId,
    parentCollectionId: collection.nodeId,
    name: requestName,
    method: "POST",
    targetUrl: "<<base_url>>",
    query: [{ name: "marker", value: "<<marker>>", enabled: true }],
    headers: [
      { name: "X-AIO-Verification", value: "<<token>>", enabled: true },
    ],
    body: "<<workspace_marker>>|<<collection_marker>>|<<request_marker>>|<<marker>>",
  });
  await client.command("variable_profile.update", {
    scopeKind: "request",
    scopeId: request.requestId,
    expectedRevision: 0,
    variables: [
      { name: "request_marker", kind: "value", value: `request-${marker}` },
    ],
  });
  const execution = await client.command("execution.start", {
    requestId: request.requestId,
  });
  const terminal = await client.waitForEvent(
    (event) =>
      event.type === "execution.completed" &&
      event.payload?.executionId === execution.executionId,
  );
  const view = terminal.payload.data;
  if (
    view.status !== 200 ||
    view.bodyComplete !== true ||
    !view.bodyPreview?.includes(`"inherited":"${marker}"`) ||
    !view.bodyPreview.includes(`collection-${marker}`)
  ) {
    throw new Error("AIO proxy execution did not return the expected response");
  }
  await verifyBodyDownload(accessToken, execution.executionId, marker);
  return {
    marker,
    targetUrl,
    workspaceName,
    collectionName,
    requestName,
    workspaceId: workspace.workspaceId,
    collectionId: collection.nodeId,
    environmentId: environment.environmentId,
    requestId: request.requestId,
    executionId: execution.executionId,
  };
}

/** Verifies domain records and exact response bytes after an AIO restart. */
async function verifyRestoredJourney(client, accessToken, state) {
  const workspaces = await client.command("workspace.list", {});
  if (
    !workspaces.workspaces?.some(
      (workspace) =>
        workspace.workspaceId === state.workspaceId &&
        workspace.name === state.workspaceName,
    )
  ) {
    throw new Error("The verification workspace did not survive restart");
  }
  const root = await client.command("tree.list", {
    workspaceId: state.workspaceId,
    parentCollectionId: null,
  });
  if (!root.children?.some((node) => node.nodeId === state.collectionId)) {
    throw new Error("The verification collection did not survive restart");
  }
  const collection = await client.command("collection.get", {
    collectionId: state.collectionId,
  });
  if (
    collection.revision !== 1 ||
    !collection.headers?.some(
      (header) =>
        header.name === "X-AIO-Inherited" && header.value === state.marker,
    )
  ) {
    throw new Error("The collection header profile did not survive restart");
  }
  const workspaceVariables = await client.command("variable_profile.get", {
    scopeKind: "workspace",
    scopeId: state.workspaceId,
  });
  const collectionVariables = await client.command("variable_profile.get", {
    scopeKind: "collection",
    scopeId: state.collectionId,
  });
  const requestVariables = await client.command("variable_profile.get", {
    scopeKind: "request",
    scopeId: state.requestId,
  });
  if (
    workspaceVariables.revision !== 1 ||
    workspaceVariables.variables?.[0]?.value !== `workspace-${state.marker}` ||
    collectionVariables.revision !== 1 ||
    collectionVariables.variables?.[0]?.value !==
      `collection-${state.marker}` ||
    requestVariables.revision !== 1 ||
    requestVariables.variables?.[0]?.value !== `request-${state.marker}`
  ) {
    throw new Error("Persisted variable scopes did not survive restart");
  }
  const environments = await client.command("environment.list", {
    workspaceId: state.workspaceId,
  });
  if (
    environments.selectedEnvironmentId !== null ||
    !environments.environments?.some(
      (environment) => environment.environmentId === state.environmentId,
    )
  ) {
    throw new Error("The environment or new-session selection is invalid");
  }
  const environment = await client.command("environment.get", {
    environmentId: state.environmentId,
  });
  const secret = environment.variables?.find(
    (variable) => variable.name === "token",
  );
  if (
    secret?.kind !== "secret" ||
    secret.hasValue !== true ||
    Object.hasOwn(secret, "value")
  ) {
    throw new Error("The restored environment exposed or lost its secret");
  }
  await client.command("environment.select", {
    workspaceId: state.workspaceId,
    environmentId: state.environmentId,
  });
  const preview = await client.command("environment.preview_variables", {
    workspaceId: state.workspaceId,
    names: ["base_url", "token"],
  });
  const baseUrl = preview.previews?.find(
    (variable) => variable.name === "base_url",
  );
  const token = preview.previews?.find((variable) => variable.name === "token");
  if (
    baseUrl?.status !== "resolved" ||
    baseUrl.value !== state.targetUrl ||
    token?.status !== "resolved" ||
    token.effectiveKind !== "secret" ||
    token.value !== null ||
    JSON.stringify(preview).includes(`secret-${state.marker}`)
  ) {
    throw new Error("Variable previews were stale or exposed a secret");
  }
  const scopedPreview = await client.command("variable.preview", {
    workspaceId: state.workspaceId,
    parentCollectionId: state.collectionId,
    requestId: state.requestId,
    names: [
      "workspace_marker",
      "collection_marker",
      "request_marker",
      "marker",
      "token",
    ],
  });
  const previewSources = Object.fromEntries(
    scopedPreview.previews.map((variable) => [
      variable.name,
      variable.source?.scope ?? null,
    ]),
  );
  if (
    previewSources.workspace_marker !== "workspace" ||
    previewSources.collection_marker !== "collection" ||
    previewSources.request_marker !== "request" ||
    previewSources.marker !== "collection" ||
    scopedPreview.previews.find((variable) => variable.name === "marker")
      ?.value !== `collection-${state.marker}` ||
    scopedPreview.previews.find((variable) => variable.name === "token")
      ?.value !== null ||
    JSON.stringify(scopedPreview).includes(`secret-${state.marker}`)
  ) {
    throw new Error("Scoped variable previews were incorrect or unsafe");
  }
  const children = await client.command("tree.list", {
    workspaceId: state.workspaceId,
    parentCollectionId: state.collectionId,
  });
  if (
    !children.children?.some(
      (node) =>
        node.nodeId === state.requestId &&
        node.kind === "request" &&
        node.name === state.requestName,
    )
  ) {
    throw new Error("The verification request did not survive restart");
  }
  const restoredExecution = await client.command("execution.start", {
    requestId: state.requestId,
  });
  const restoredTerminal = await client.waitForEvent(
    (event) =>
      event.type === "execution.completed" &&
      event.payload?.executionId === restoredExecution.executionId,
  );
  if (
    restoredTerminal.payload?.data?.status !== 200 ||
    !restoredTerminal.payload?.data?.bodyPreview?.includes(
      `collection-${state.marker}`,
    )
  ) {
    throw new Error("The restored environment did not compose the request");
  }
  await verifyBodyDownload(accessToken, state.executionId, state.marker);
  const auditFiles = (await readdir("/data/audit")).filter((name) =>
    name.endsWith(".jsonl"),
  );
  const auditEvents = (
    await Promise.all(
      auditFiles.map(async (name) =>
        (await readFile(`/data/audit/${name}`, "utf8"))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line)),
      ),
    )
  ).flat();
  if (
    !auditEvents.some(
      (event) =>
        event.type === "workspace.created" &&
        event.workspaceId === state.workspaceId &&
        event.data?.name === state.workspaceName,
    )
  ) {
    throw new Error(
      "Workspace creation audit evidence did not survive restart",
    );
  }
  if (
    !auditEvents.some(
      (event) =>
        event.type === "execution.completed" &&
        event.workspaceId === state.workspaceId &&
        event.data?.executionId === state.executionId,
    )
  ) {
    throw new Error(
      "Execution completion audit evidence did not survive restart",
    );
  }
}

/** Confirms an unreachable target becomes an explicit terminal failure event. */
async function verifyExecutionFailure(client) {
  const workspaces = await client.command("workspace.list", {});
  const workspace = workspaces.workspaces?.[0];
  if (workspace === undefined) {
    throw new Error("Failure verification requires the persistent workspace");
  }
  const execution = await client.command("execution.start_temporary", {
    workspaceId: workspace.workspaceId,
    parentCollectionId: null,
    request: {
      method: "GET",
      targetUrl: "http://127.0.0.1:1/unreachable",
      query: [],
      headers: [],
      body: "",
    },
  });
  const terminal = await client.waitForEvent(
    (event) =>
      event.type === "execution.failed" &&
      event.payload?.executionId === execution.executionId,
  );
  if (
    terminal.payload?.data?.state !== "failed" ||
    typeof terminal.payload?.data?.error?.code !== "string"
  ) {
    throw new Error("Unreachable target did not produce a structured failure");
  }
}

/** Downloads and checks the immutable response bytes through authorized HTTP. */
async function verifyBodyDownload(accessToken, executionId, marker) {
  const response = await fetch(
    `http://127.0.0.1:8080/api/executions/${executionId}/body`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok || !(await response.text()).includes(marker)) {
    throw new Error("Persisted response-body download did not match execution");
  }
}

/** Correlates verification commands and retains events until asserted. */
class VerificationWebSocketClient {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #events = [];
  #waiters = [];

  constructor(origin) {
    this.origin = origin;
  }

  /** Opens the control connection and proves its session ownership. */
  async connect(accessToken) {
    this.#socket = new WebSocket("ws://127.0.0.1:8080/ws", {
      headers: { Origin: this.origin },
    });
    this.#socket.on("message", (data) => this.#receive(data));
    await new Promise((resolvePromise, reject) => {
      this.#socket.once("open", resolvePromise);
      this.#socket.once("error", reject);
    });
    await this.command("session.authenticate", { accessToken });
  }

  /** Sends one command and resolves only its matching successful reply. */
  command(type, payload) {
    const id = `verify-${++this.#nextId}`;
    const result = new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 15_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        reject: (cause) => {
          clearTimeout(timeout);
          reject(cause);
        },
      });
    });
    this.#socket.send(
      JSON.stringify({
        protocolVersion: 1,
        kind: "command",
        id,
        type,
        payload,
      }),
    );
    return result;
  }

  /** Resolves the next retained or incoming event accepted by a predicate. */
  waitForEvent(predicate) {
    const retainedIndex = this.#events.findIndex(predicate);
    if (retainedIndex >= 0) {
      return Promise.resolve(this.#events.splice(retainedIndex, 1)[0]);
    }
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== entry);
        reject(new Error("Timed out waiting for execution event"));
      }, 30_000);
      const entry = {
        predicate,
        resolve: (event) => {
          clearTimeout(timeout);
          resolvePromise(event);
        },
      };
      this.#waiters.push(entry);
    });
  }

  /** Closes verification transport after rejecting unfinished commands. */
  close() {
    this.#socket?.close();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("Verification connection closed"));
    }
    this.#pending.clear();
  }

  /** Routes one decoded reply or event to its waiting assertion. */
  #receive(raw) {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.kind === "event") {
      const waiterIndex = this.#waiters.findIndex((waiter) =>
        waiter.predicate(message),
      );
      if (waiterIndex >= 0) {
        const [waiter] = this.#waiters.splice(waiterIndex, 1);
        waiter.resolve(message);
      } else {
        this.#events.push(message);
      }
      return;
    }
    const pending = this.#pending.get(message.commandId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.commandId);
    if (message.outcome === "success") {
      pending.resolve(message.payload);
    } else {
      pending.reject(
        new Error(
          `${message.error?.code ?? "command_failed"}: ${message.error?.message ?? "Command failed"}`,
        ),
      );
    }
  }
}

await main();
