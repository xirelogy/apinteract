import { createHash } from "node:crypto";
import { STATUS_CODES } from "node:http";

import type {
  ImportedRequestBodyDefinition as RequestBodyDefinition,
  ImportedRequestBodyOption,
  ImportedCapturedExchange,
  ImportedRequestField as RequestField,
  ImportedVariableWrite as VariableWrite,
  ImportDiagnostic,
  ImportedCollection,
  ImportedRequest,
  ImportPlan,
  ImportProbeResult,
  ImportProvider,
  ImportProviderManifest,
  ImportSource,
} from "@apinteract/plugin-api/backend";
import {
  editableValue,
  isRecord,
  parseJsonObject,
  ImportProviderError,
  sourceStem,
  stringValue,
  unknownArray,
} from "@apinteract/plugin-sdk/backend/import";

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
const METHOD_NAMES = new Map(
  HTTP_METHODS.map((method) => [method.toLowerCase(), method] as const),
);

/** Imports OpenAPI 3 JSON operations through the source-neutral plan boundary. */
export class OpenApiJsonImportProvider implements ImportProvider {
  readonly manifest: ImportProviderManifest = {
    id: "openapi-json",
    version: "1.4.0",
    label: "OpenAPI JSON",
    acceptedExtensions: [".json"],
    acceptedMediaTypes: ["application/json"],
    inputKinds: ["file"],
    capabilities: {
      multipleRequests: true,
      hierarchy: true,
      attachments: false,
      capturedResponses: true,
      responseExamples: true,
      variables: true,
    },
  };

  /** Recognizes OpenAPI 3 documents without fully parsing their operations. */
  probe(source: ImportSource): ImportProbeResult {
    try {
      const document = JSON.parse(source.text) as unknown;
      const version = isRecord(document) ? document.openapi : undefined;
      return typeof version === "string" && version.startsWith("3.")
        ? { confidence: 1, reason: `OpenAPI ${version}` }
        : { confidence: 0, reason: "Missing an OpenAPI 3 version" };
    } catch {
      return { confidence: 0, reason: "Invalid JSON" };
    }
  }

  /** Converts supported OpenAPI operations into composed request drafts. */
  parse(source: ImportSource): Omit<ImportPlan, "sourceFingerprint"> {
    const document = parseJsonObject(source);
    const version = stringValue(document.openapi);
    if (!version.startsWith("3.0.") && !version.startsWith("3.1.")) {
      throw new ImportProviderError(
        "openapi_version_unsupported",
        "Only OpenAPI 3.0 and 3.1 JSON documents are supported.",
      );
    }
    const diagnostics: ImportDiagnostic[] = [];
    const requests: ImportedRequest[] = [];
    const info = isRecord(document.info) ? document.info : {};
    const suggestedName = (
      stringValue(info.title).trim() || sourceStem(source.name, [".json"])
    ).slice(0, 200);
    const rootDescription = importShortDescription(
      info.summary,
      diagnostics,
      "#/info/summary",
    );
    const mappedRequests: MappedOpenApiRequest[] = [];
    const paths = isRecord(document.paths) ? document.paths : {};
    for (const [path, rawPathItem] of Object.entries(paths)) {
      const pathItem = resolveLocalReference(
        document,
        rawPathItem,
        diagnostics,
      );
      if (!isRecord(pathItem)) continue;
      const pathLocation = `#/paths/${escapePointer(path)}`;
      const pathDescription = importShortDescription(
        pathItem.summary,
        diagnostics,
        `${pathLocation}/summary`,
      );
      const pathNotes = stringValue(pathItem.description);
      for (const [methodName, method] of METHOD_NAMES) {
        const rawOperation = pathItem[methodName];
        const operation = resolveLocalReference(
          document,
          rawOperation,
          diagnostics,
        );
        if (!isRecord(operation)) continue;
        const itemId = `operation:${method}:${path}`;
        const sourceLocation = `#/paths/${escapePointer(path)}/${methodName}`;
        const server = resolveEffectiveServer(
          document,
          pathItem,
          operation,
          itemId,
          sourceLocation,
          diagnostics,
        );
        const parameters = mergeParameters(
          document,
          pathItem.parameters,
          operation.parameters,
          diagnostics,
          itemId,
        );
        const mapped = mapParameters(
          parameters,
          path,
          server.variables.map((variable) => variable.name),
        );
        const body = mapRequestBody(
          document,
          operation.requestBody,
          itemId,
          diagnostics,
          stringValue(operation.description),
        );
        const security = mapSecurity(
          document,
          operation.security ?? document.security,
          itemId,
          diagnostics,
          [...server.variables, ...mapped.variables].map(
            (variable) => variable.name,
          ),
        );
        const capturedExchanges = mapResponseExamples(
          document,
          operation.responses,
          itemId,
          diagnostics,
        );
        mappedRequests.push({
          server,
          path,
          pathDescription,
          pathNotes,
          tag: primaryOperationTag(operation, itemId, diagnostics),
          request: {
            itemId,
            sourceLocation,
            collectionKey: null,
            name: requestName(operation, method, path),
            description: importShortDescription(
              operation.summary,
              diagnostics,
              `${sourceLocation}/summary`,
              itemId,
            ),
            notes: boundedRequestNotes(
              itemId,
              diagnostics,
              stringValue(operation.description).trim() ===
                stringValue(operation.summary).trim()
                ? ""
                : operation.description,
              body.notes,
              security.notes,
            ),
            method,
            targetMode: "composed",
            targetUrl: mapped.targetUrl,
            query: [...mapped.query, ...security.query],
            headers: [...mapped.headers, ...security.headers],
            requestBody: body.requestBody,
            ...(body.requestBodyOptions === undefined
              ? {}
              : {
                  requestBodyOptions: body.requestBodyOptions,
                  defaultRequestBodyOptionId: body.defaultRequestBodyOptionId,
                }),
            body: body.legacyBody,
            preRequestScript: "",
            postResponseScript: "",
            variables: [
              ...server.variables,
              ...mapped.variables,
              ...security.variables,
            ],
            ...(capturedExchanges.length === 0 ? {} : { capturedExchanges }),
          },
        });
      }
    }
    const hierarchy = buildOpenApiHierarchy(
      mappedRequests,
      declaredTagOrder(document.tags),
      declaredTagNotes(document.tags),
      diagnostics,
    );
    requests.push(...hierarchy.requests);
    if (requests.length === 0) {
      diagnostics.push({
        code: "openapi_no_operations",
        severity: "error",
        message:
          "The OpenAPI document does not contain supported HTTP operations.",
        sourceLocation: "#/paths",
      });
    }
    return {
      schemaVersion: 1,
      providerId: this.manifest.id,
      providerVersion: this.manifest.version,
      sourceName: source.name,
      suggestedName,
      description: rootDescription,
      notes: joinOpenApiNotes(
        info.description,
        singleEffectiveServerNotes(mappedRequests),
      ),
      pathPrefix: hierarchy.pathPrefix,
      variables: hierarchy.variables,
      collections: hierarchy.collections,
      requests,
      diagnostics,
    };
  }
}

/** Maps a bounded single-line summary without silently truncating source text. */
function importShortDescription(
  value: unknown,
  diagnostics: ImportDiagnostic[],
  sourceLocation: string,
  itemId?: string,
): string {
  const description = stringValue(value).trim();
  if (
    !/[\r\n]/u.test(description) &&
    Buffer.byteLength(description, "utf8") <= 2 * 1024
  ) {
    return description;
  }
  diagnostics.push({
    code: "openapi_summary_not_imported",
    severity: "warning",
    message:
      "A summary was not imported as a description because it is not a bounded single-line value.",
    ...(itemId === undefined ? {} : { itemId }),
    sourceLocation,
  });
  return "";
}

/** Represents one normalized effective server boundary used for composition. */
interface ResolvedOpenApiServer {
  readonly key: string;
  readonly url: string;
  readonly notes: string;
  readonly variables: readonly VariableWrite[];
}

/** Retains provider metadata needed to build the imported collection tree. */
interface MappedOpenApiRequest {
  readonly request: ImportedRequest;
  readonly server: ResolvedOpenApiServer;
  readonly path: string;
  readonly pathDescription: string;
  readonly pathNotes: string;
  readonly tag: string | null;
}

/** Contains the root profile and routed requests produced from OpenAPI groups. */
interface OpenApiHierarchy {
  readonly pathPrefix: string;
  readonly variables: readonly VariableWrite[];
  readonly collections: readonly ImportedCollection[];
  readonly requests: readonly ImportedRequest[];
}

/** Combines distinct OpenAPI prose blocks into one Markdown notes document. */
function joinOpenApiNotes(...values: readonly unknown[]): string {
  return [...new Set(values.map((value) => stringValue(value).trim()))]
    .filter((value) => value !== "")
    .join("\n\n");
}

/** Combines request notes without allowing imported documentation to exceed core bounds. */
function boundedRequestNotes(
  itemId: string,
  diagnostics: ImportDiagnostic[],
  ...values: readonly unknown[]
): string {
  const retained: string[] = [];
  let omitted = false;
  for (const value of [
    ...new Set(values.map((candidate) => stringValue(candidate).trim())),
  ]) {
    if (value === "") continue;
    const candidate = [...retained, value].join("\n\n");
    if (Buffer.byteLength(candidate, "utf8") <= 256 * 1024) {
      retained.push(value);
    } else {
      omitted = true;
    }
  }
  if (omitted) {
    diagnostics.push({
      code: "openapi_request_documentation_limited",
      severity: "warning",
      message:
        "Some request documentation was too large to include in the imported notes.",
      itemId,
    });
  }
  return retained.join("\n\n");
}

/** Returns server notes only when one effective server belongs at the root. */
function singleEffectiveServerNotes(
  mappedRequests: readonly MappedOpenApiRequest[],
): string {
  const servers = new Map(
    mappedRequests.map((mapped) => [mapped.server.key, mapped.server]),
  );
  return servers.size === 1 ? ([...servers.values()][0]?.notes ?? "") : "";
}

/** Builds tag, optional server, and path collections without request overrides. */
function buildOpenApiHierarchy(
  mappedRequests: readonly MappedOpenApiRequest[],
  tagOrder: readonly string[],
  tagNotes: ReadonlyMap<string, string>,
  diagnostics: ImportDiagnostic[],
): OpenApiHierarchy {
  const serverGroups = new Map<string, ResolvedOpenApiServer>();
  for (const mapped of mappedRequests) {
    if (!serverGroups.has(mapped.server.key)) {
      serverGroups.set(mapped.server.key, mapped.server);
    }
  }
  const pathPrefix =
    serverGroups.size === 1 ? [...serverGroups.values()][0]!.url : "";
  const variables = collectRootVariables(mappedRequests, diagnostics);
  const collections: ImportedCollection[] = [];
  const requests: ImportedRequest[] = [];
  const pathCollectionKeys = new Set<string>();
  const usesTagCollections = mappedRequests.some(
    (mapped) => mapped.tag !== null,
  );

  if (!usesTagCollections) {
    if (serverGroups.size > 1) {
      collections.push(
        ...[...serverGroups.values()].map((server) => ({
          collectionKey: server.key,
          parentCollectionKey: null,
          name: serverCollectionName(server),
          description: "",
          notes: server.notes,
          pathPrefix: server.url,
          variables: [],
        })),
      );
    }
    for (const mapped of mappedRequests) {
      routeMappedRequest(
        mapped,
        serverGroups.size > 1 ? mapped.server.key : null,
        collections,
        requests,
        pathCollectionKeys,
      );
    }
    return { pathPrefix, variables, collections, requests };
  }

  const requestsByTag = new Map<string | null, MappedOpenApiRequest[]>();
  for (const mapped of mappedRequests) {
    const grouped = requestsByTag.get(mapped.tag) ?? [];
    grouped.push(mapped);
    requestsByTag.set(mapped.tag, grouped);
  }
  const orderedTags = [
    ...tagOrder.filter((tag) => requestsByTag.has(tag)),
    ...[...requestsByTag.keys()].filter(
      (tag) => tag !== null && !tagOrder.includes(tag),
    ),
    ...(requestsByTag.has(null) ? [null] : []),
  ];
  for (const tag of orderedTags) {
    const taggedRequests = requestsByTag.get(tag) ?? [];
    const tagKey = openApiTagCollectionKey(tag);
    const tagServers = new Map<string, ResolvedOpenApiServer>();
    for (const mapped of taggedRequests) {
      if (!tagServers.has(mapped.server.key)) {
        tagServers.set(mapped.server.key, mapped.server);
      }
    }
    const tagOwnsServerPrefix = serverGroups.size > 1 && tagServers.size === 1;
    collections.push({
      collectionKey: tagKey,
      parentCollectionKey: null,
      name: openApiTagCollectionName(tag),
      description: "",
      notes: joinOpenApiNotes(
        tag === null ? "" : (tagNotes.get(tag) ?? ""),
        tagOwnsServerPrefix ? [...tagServers.values()][0]?.notes : "",
      ),
      pathPrefix: tagOwnsServerPrefix ? [...tagServers.values()][0]!.url : "",
      variables: [],
    });
    const tagUsesServerCollections =
      serverGroups.size > 1 && tagServers.size > 1;
    const serverKeys = new Map<string, string>();
    if (tagUsesServerCollections) {
      for (const server of tagServers.values()) {
        const collectionKey = openApiTaggedServerCollectionKey(
          tagKey,
          server.key,
        );
        serverKeys.set(server.key, collectionKey);
        collections.push({
          collectionKey,
          parentCollectionKey: tagKey,
          name: serverCollectionName(server),
          description: "",
          notes: server.notes,
          pathPrefix: server.url,
          variables: [],
        });
      }
    }
    for (const mapped of taggedRequests) {
      routeMappedRequest(
        mapped,
        tagUsesServerCollections
          ? (serverKeys.get(mapped.server.key) ?? tagKey)
          : tagKey,
        collections,
        requests,
        pathCollectionKeys,
      );
    }
  }
  return { pathPrefix, variables, collections, requests };
}

/** Adds one path collection once and routes an operation beneath it. */
function routeMappedRequest(
  mapped: MappedOpenApiRequest,
  parentCollectionKey: string | null,
  collections: ImportedCollection[],
  requests: ImportedRequest[],
  pathCollectionKeys: Set<string>,
): void {
  const pathKey = openApiPathCollectionKey(
    parentCollectionKey,
    mapped.server.key,
    mapped.path,
  );
  if (!pathCollectionKeys.has(pathKey)) {
    pathCollectionKeys.add(pathKey);
    collections.push({
      collectionKey: pathKey,
      parentCollectionKey,
      name: openApiPathCollectionName(mapped.path),
      description: mapped.pathDescription,
      notes: mapped.pathNotes,
      pathPrefix: mapped.request.targetUrl,
      variables: [],
    });
  }
  requests.push({
    ...mapped.request,
    collectionKey: pathKey,
    targetUrl: "",
    variables: [],
  });
}

/** Chooses one deterministic root declaration and reports conflicting defaults. */
function collectRootVariables(
  mappedRequests: readonly MappedOpenApiRequest[],
  diagnostics: ImportDiagnostic[],
): VariableWrite[] {
  const variables: VariableWrite[] = [];
  const declarations = new Map<
    string,
    {
      readonly variable: VariableWrite;
      readonly itemId: string;
      readonly descriptionItemId: string | undefined;
      readonly outputIndex: number;
    }
  >();
  const descriptionConflictItems = new Set<string>();
  const descriptionConflictNames = new Set<string>();
  for (const mapped of mappedRequests) {
    for (const variable of mapped.request.variables) {
      const existing = declarations.get(variable.name);
      if (existing === undefined) {
        declarations.set(variable.name, {
          variable,
          itemId: mapped.request.itemId,
          descriptionItemId:
            (variable.description ?? "") === ""
              ? undefined
              : mapped.request.itemId,
          outputIndex: variables.length,
        });
        variables.push(variable);
      } else {
        if (
          openApiVariableSignature(existing.variable) !==
          openApiVariableSignature(variable)
        ) {
          diagnostics.push({
            code: "openapi_variable_default_conflict",
            severity: "warning",
            message: `Variable ${variable.name} has conflicting OpenAPI defaults; the first imported value was kept.`,
            itemIds: [existing.itemId, mapped.request.itemId],
          });
        }
        if (
          (existing.variable.description ?? "") !== "" &&
          (variable.description ?? "") !== "" &&
          existing.variable.description !== variable.description
        ) {
          descriptionConflictNames.add(variable.name);
          descriptionConflictItems.add(
            existing.descriptionItemId ?? existing.itemId,
          );
          descriptionConflictItems.add(mapped.request.itemId);
        } else if (
          (existing.variable.description ?? "") === "" &&
          (variable.description ?? "") !== ""
        ) {
          const documented = {
            ...existing.variable,
            description: variable.description,
          } as VariableWrite;
          variables[existing.outputIndex] = documented;
          declarations.set(variable.name, {
            ...existing,
            variable: documented,
            descriptionItemId: mapped.request.itemId,
          });
        }
      }
    }
  }
  if (descriptionConflictNames.size > 0) {
    diagnostics.push({
      code: "openapi_variable_description_conflict",
      severity: "warning",
      message: `Conflicting descriptions for imported variables were ignored after their first declaration: ${[...descriptionConflictNames].join(", ")}.`,
      itemIds: [...descriptionConflictItems],
    });
  }
  return variables;
}

/** Compares imported declarations without including their values in diagnostics. */
function openApiVariableSignature(variable: VariableWrite): string {
  if (variable.kind === "value")
    return JSON.stringify(["value", variable.value]);
  if (variable.kind === "alias")
    return JSON.stringify(["alias", variable.target]);
  if (variable.kind === "secret") {
    return JSON.stringify(["secret", variable.value ?? null]);
  }
  return "unset";
}

/** Applies operation, path, and document server precedence for one operation. */
function resolveEffectiveServer(
  document: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  itemId: string,
  operationLocation: string,
  diagnostics: ImportDiagnostic[],
): ResolvedOpenApiServer {
  const candidates = [
    {
      servers: unknownArray(operation.servers),
      label: "operation",
      location: `${operationLocation}/servers/0`,
    },
    {
      servers: unknownArray(pathItem.servers),
      label: "path",
      location: `${operationLocation.slice(0, operationLocation.lastIndexOf("/"))}/servers/0`,
    },
    {
      servers: unknownArray(document.servers),
      label: "document",
      location: "#/servers/0",
    },
  ];
  const selected = candidates.find((candidate) => candidate.servers.length > 0);
  if (selected === undefined) {
    return { key: "server:none", url: "", notes: "", variables: [] };
  }
  if (selected.servers.length > 1) {
    diagnostics.push({
      code: "openapi_server_selected",
      severity: "info",
      message: `The first ${selected.label} server was selected; ${selected.servers.length - 1} alternative${selected.servers.length === 2 ? "" : "s"} were not imported.`,
      itemId,
      sourceLocation: selected.location,
    });
  }
  return resolveServerTemplate(
    selected.servers[0],
    selected.location,
    itemId,
    diagnostics,
  );
}

/** Preserves a server template as APInteract interpolation and variable defaults. */
function resolveServerTemplate(
  rawServer: unknown,
  sourceLocation: string,
  itemId: string,
  diagnostics: ImportDiagnostic[],
): ResolvedOpenApiServer {
  if (!isRecord(rawServer) || stringValue(rawServer.url).trim() === "") {
    diagnostics.push({
      code: "openapi_server_invalid",
      severity: "error",
      message: "The effective OpenAPI server does not contain a usable URL.",
      itemId,
      sourceLocation,
    });
    return {
      key: `server:invalid:${itemId}`,
      url: "",
      notes: "",
      variables: [],
    };
  }
  let url = stringValue(rawServer.url).trim();
  const serverVariables: VariableWrite[] = [];
  const serverVariableNames = new Set<string>();
  const server = rawServer;
  const variables = isRecord(server.variables) ? server.variables : {};
  url = url.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const variableName = uniqueVariableName(name, serverVariableNames);
    serverVariableNames.add(variableName);
    const definition = variables[name];
    const hasDefault = isRecord(definition) && definition.default !== undefined;
    const description = isRecord(definition)
      ? stringValue(definition.description)
      : "";
    serverVariables.push({
      name: variableName,
      kind: "value",
      value: hasDefault ? editableValue(definition.default) : "",
      ...(description === "" ? {} : { description }),
    });
    if (!hasDefault) {
      diagnostics.push({
        code: "openapi_server_variable_unresolved",
        severity: "warning",
        message: `Server variable ${name} has no default and requires a value.`,
        itemId,
        sourceLocation,
      });
    }
    return `<<${variableName}>>`;
  });
  if (/[{}]/u.test(url) || hasUnsupportedServerScheme(url)) {
    diagnostics.push({
      code: "openapi_server_unsupported",
      severity: "error",
      message: `The effective OpenAPI server ${url} cannot be represented as a composed HTTP target.`,
      itemId,
      sourceLocation,
    });
  }
  const normalizedUrl = normalizeServerBoundary(url);
  return {
    key: `server:${createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 16)}`,
    url: normalizedUrl,
    notes: stringValue(server.description),
    variables: serverVariables,
  };
}

/** Rejects explicit non-HTTP schemes while continuing to support relative servers. */
function hasUnsupportedServerScheme(url: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(url);
  const scheme = match?.[1]?.toLowerCase();
  return scheme !== undefined && scheme !== "http" && scheme !== "https";
}

/** Normalizes equivalent trailing slashes without inventing a common prefix. */
function normalizeServerBoundary(url: string): string {
  if (url === "/") return url;
  return url.replace(/\/+$/u, "");
}

/** Derives a compact deterministic collection name for one server group. */
function serverCollectionName(server: ResolvedOpenApiServer): string {
  if (server.url === "") return "No server";
  try {
    const parsed = new URL(server.url.replace(/<<[^<>]+>>/gu, "variable"));
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(
      0,
      200,
    );
  } catch {
    return server.url.slice(0, 200);
  }
}

/** Creates a stable provider-local key for one parent, server, and API path. */
function openApiPathCollectionKey(
  parentCollectionKey: string | null,
  serverKey: string,
  path: string,
): string {
  return `path:${createHash("sha256")
    .update(parentCollectionKey ?? "root")
    .update("\u0000")
    .update(serverKey)
    .update("\u0000")
    .update(path)
    .digest("hex")
    .slice(0, 16)}`;
}

/** Chooses the first operation tag as the tree-compatible logical parent. */
function primaryOperationTag(
  operation: Record<string, unknown>,
  itemId: string,
  diagnostics: ImportDiagnostic[],
): string | null {
  const tags = [
    ...new Set(
      unknownArray(operation.tags)
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
    ),
  ];
  const primary = tags[0] ?? null;
  if (primary !== null && tags.length > 1) {
    diagnostics.push({
      code: "openapi_additional_tags_not_grouped",
      severity: "info",
      message: `Operation was grouped under tag ${primary}; additional tags were not represented: ${tags.slice(1).join(", ")}.`,
      itemId,
    });
  }
  return primary;
}

/** Reads the explicit top-level tag order used by OpenAPI tooling. */
function declaredTagOrder(rawTags: unknown): string[] {
  return [
    ...new Set(
      unknownArray(rawTags)
        .flatMap((tag) => (isRecord(tag) ? [stringValue(tag.name).trim()] : []))
        .filter((tag) => tag !== ""),
    ),
  ];
}

/** Maps declared tag descriptions to their logical collection names. */
function declaredTagNotes(rawTags: unknown): ReadonlyMap<string, string> {
  const notes = new Map<string, string>();
  for (const rawTag of unknownArray(rawTags)) {
    if (!isRecord(rawTag)) continue;
    const name = stringValue(rawTag.name).trim();
    if (name !== "" && !notes.has(name)) {
      notes.set(name, stringValue(rawTag.description));
    }
  }
  return notes;
}

/** Creates a stable key for one declared or synthetic untagged group. */
function openApiTagCollectionKey(tag: string | null): string {
  if (tag === null) return "tag:untagged";
  return `tag:${createHash("sha256").update(tag).digest("hex").slice(0, 16)}`;
}

/** Creates a server key scoped beneath a logical tag collection. */
function openApiTaggedServerCollectionKey(
  tagKey: string,
  serverKey: string,
): string {
  return `tag-server:${createHash("sha256")
    .update(tagKey)
    .update("\u0000")
    .update(serverKey)
    .digest("hex")
    .slice(0, 16)}`;
}

/** Bounds logical group names to collection constraints. */
function openApiTagCollectionName(tag: string | null): string {
  return (tag ?? "Untagged").slice(0, 200);
}

/** Uses the explicit OpenAPI path as the compact path-collection label. */
function openApiPathCollectionName(path: string): string {
  return (path.trim() || "/").slice(0, 200);
}

/** Resolves a local JSON Pointer reference while rejecting external retrieval. */
function resolveLocalReference(
  document: Record<string, unknown>,
  value: unknown,
  diagnostics: ImportDiagnostic[],
): unknown {
  let current = value;
  const visited = new Set<string>();
  while (isRecord(current) && typeof current.$ref === "string") {
    const reference = current.$ref;
    if (!reference.startsWith("#/")) {
      diagnostics.push({
        code: "openapi_remote_reference_unsupported",
        severity: "warning",
        message: `Remote reference ${reference} was not fetched.`,
        sourceLocation: reference,
      });
      return undefined;
    }
    if (visited.has(reference) || visited.size >= 20) {
      diagnostics.push({
        code: "openapi_reference_cycle",
        severity: "warning",
        message: `Local reference ${reference} is cyclic or too deep.`,
        sourceLocation: reference,
      });
      return undefined;
    }
    visited.add(reference);
    current = document;
    for (const segment of reference
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      current = isRecord(current) ? current[segment] : undefined;
    }
    if (current === undefined) {
      diagnostics.push({
        code: "openapi_reference_missing",
        severity: "warning",
        message: `Local reference ${reference} could not be resolved.`,
        sourceLocation: reference,
      });
      return undefined;
    }
  }
  return current;
}

/** Converts explicit response examples into immutable imported captures. */
function mapResponseExamples(
  document: Record<string, unknown>,
  rawResponses: unknown,
  itemId: string,
  diagnostics: ImportDiagnostic[],
): ImportedCapturedExchange[] {
  if (!isRecord(rawResponses)) return [];
  const captures: ImportedCapturedExchange[] = [];
  for (const [statusKey, rawResponse] of Object.entries(rawResponses)) {
    const response = resolveLocalReference(document, rawResponse, diagnostics);
    if (!isRecord(response) || !isRecord(response.content)) continue;
    for (const [contentType, rawMedia] of Object.entries(response.content)) {
      if (!isRecord(rawMedia)) continue;
      const examples = responseMediaExamples(document, rawMedia, diagnostics);
      if (examples.length === 0) continue;
      if (!/^[1-5][0-9]{2}$/u.test(statusKey)) {
        diagnostics.push({
          code: "openapi_response_status_not_captured",
          severity: "warning",
          message: `Response examples for status ${statusKey} were not captured because it is not one concrete HTTP status.`,
          itemId,
        });
        continue;
      }
      const status = Number(statusKey);
      for (const example of examples) {
        if (captures.length >= 50) {
          diagnostics.push({
            code: "openapi_response_examples_limited",
            severity: "warning",
            message:
              "Only the first 50 response examples were captured for this operation.",
            itemId,
          });
          return captures;
        }
        const body = serializeMediaExample(contentType, example.value);
        if (body === null) {
          diagnostics.push({
            code: "openapi_response_example_not_text",
            severity: "warning",
            message: `${statusKey} ${contentType} response content was not captured because its example is not a string and this importer does not serialize that media type.`,
            itemId,
          });
          continue;
        }
        if (Buffer.byteLength(body, "utf8") > 262_144) {
          diagnostics.push({
            code: "openapi_response_example_too_large",
            severity: "warning",
            message: `A ${statusKey} ${contentType} response example was too large to capture.`,
            itemId,
          });
          continue;
        }
        captures.push({
          label: (example.name || "example").slice(0, 200),
          status,
          statusText: STATUS_CODES[status] ?? "",
          headers: mapResponseExampleHeaders(
            document,
            response.headers,
            contentType,
            diagnostics,
          ),
          contentType,
          body,
          bodyEncoding: "text",
          bodyComplete: true,
          bodyBytes: Buffer.byteLength(body, "utf8"),
          recordedAt: null,
        });
      }
    }
  }
  return captures;
}

/** Uses explicit response examples first, then constructs one deterministic schema sample. */
function responseMediaExamples(
  document: Record<string, unknown>,
  media: Record<string, unknown>,
  diagnostics: ImportDiagnostic[],
): { readonly name: string; readonly value: unknown }[] {
  const explicit = explicitMediaExamples(document, media, diagnostics);
  if (explicit.length > 0) return explicit;
  if (media.schema === undefined) return [];
  const sample = sampleSchema(document, media.schema, diagnostics, 0);
  return sample === undefined ? [] : [{ name: "example", value: sample }];
}

/** Returns media- or schema-level explicit examples without fabricating values. */
function explicitMediaExamples(
  document: Record<string, unknown>,
  media: Record<string, unknown>,
  diagnostics: ImportDiagnostic[],
): { readonly name: string; readonly value: unknown }[] {
  if (media.example !== undefined) return [{ name: "", value: media.example }];
  if (isRecord(media.examples)) {
    return Object.entries(media.examples).flatMap(([name, rawExample]) => {
      const example = resolveLocalReference(document, rawExample, diagnostics);
      return isRecord(example) && example.value !== undefined
        ? [{ name, value: example.value }]
        : [];
    });
  }
  const schema = resolveLocalReference(document, media.schema, diagnostics);
  if (!isRecord(schema)) return [];
  if (schema.example !== undefined)
    return [{ name: "schema example", value: schema.example }];
  if (Array.isArray(schema.examples)) {
    return (schema.examples as unknown[]).map((value, index) => ({
      name: `schema example ${index + 1}`,
      value,
    }));
  }
  return [];
}

/** Serializes one response example without placing JSON under another media type. */
function serializeMediaExample(
  contentType: string,
  value: unknown,
): string | null {
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    return JSON.stringify(value, null, 2) ?? "";
  }
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/** Maps concrete response-header examples and always records Content-Type. */
function mapResponseExampleHeaders(
  document: Record<string, unknown>,
  rawHeaders: unknown,
  contentType: string,
  diagnostics: ImportDiagnostic[],
): { readonly name: string; readonly value: string }[] {
  const headers: { readonly name: string; readonly value: string }[] = [
    { name: "Content-Type", value: contentType },
  ];
  if (!isRecord(rawHeaders)) return headers;
  for (const [name, rawHeader] of Object.entries(rawHeaders)) {
    if (name.toLowerCase() === "content-type") continue;
    const header = resolveLocalReference(document, rawHeader, diagnostics);
    if (!isRecord(header)) continue;
    const schema = resolveLocalReference(document, header.schema, diagnostics);
    const value =
      header.example ??
      (isRecord(schema) ? (schema.example ?? schema.default) : undefined);
    if (value !== undefined)
      headers.push({ name, value: editableValue(value) });
  }
  return headers;
}

/** Merges path and operation parameters using OpenAPI's nearer-operation precedence. */
function mergeParameters(
  document: Record<string, unknown>,
  pathParameters: unknown,
  operationParameters: unknown,
  diagnostics: ImportDiagnostic[],
  itemId: string,
): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const raw of [
    ...unknownArray(pathParameters),
    ...unknownArray(operationParameters),
  ]) {
    const parameter = resolveLocalReference(document, raw, diagnostics);
    if (!isRecord(parameter)) continue;
    const name = stringValue(parameter.name);
    const location = stringValue(parameter.in);
    if (name === "" || location === "") {
      diagnostics.push({
        code: "openapi_parameter_invalid",
        severity: "warning",
        message: "A parameter without both name and location was skipped.",
        itemId,
      });
      continue;
    }
    merged.set(`${location}:${name}`, parameter);
  }
  return [...merged.values()];
}

/** Maps OpenAPI parameters into templates, structured fields, and request variables. */
function mapParameters(
  parameters: readonly Record<string, unknown>[],
  path: string,
  reservedVariableNames: readonly string[],
): {
  readonly targetUrl: string;
  readonly query: RequestField[];
  readonly headers: RequestField[];
  readonly variables: VariableWrite[];
} {
  const query: RequestField[] = [];
  const headers: RequestField[] = [];
  const variables: VariableWrite[] = [];
  const variableNames = new Set(reservedVariableNames);
  let targetUrl = path;
  for (const parameter of parameters) {
    const name = stringValue(parameter.name);
    const location = stringValue(parameter.in);
    const schema = isRecord(parameter.schema) ? parameter.schema : {};
    const example =
      parameter.example ?? schema.example ?? schema.default ?? undefined;
    const value = editableValue(example);
    const enabled = parameter.required === true || example !== undefined;
    const description = stringValue(parameter.description);
    if (location === "path") {
      const variableName = uniqueVariableName(name, variableNames);
      variableNames.add(variableName);
      targetUrl = targetUrl.replaceAll(`{${name}}`, `<<${variableName}>>`);
      variables.push({
        name: variableName,
        kind: "value",
        value,
        ...(description === "" ? {} : { description }),
      });
    } else if (location === "query") {
      query.push({
        name,
        value,
        enabled,
        ...(description === "" ? {} : { description }),
      });
    } else if (location === "header") {
      headers.push({
        name,
        value,
        enabled,
        mode: "override",
        ...(description === "" ? {} : { description }),
      });
    } else if (location === "cookie") {
      headers.push({
        name: "Cookie",
        value: `${name}=${value}`,
        enabled,
        mode: "append",
        ...(description === "" ? {} : { description }),
      });
    }
  }
  return { targetUrl, query, headers, variables };
}

/** Selects and maps one preferred OpenAPI request-body media type. */
function mapRequestBody(
  document: Record<string, unknown>,
  rawRequestBody: unknown,
  itemId: string,
  diagnostics: ImportDiagnostic[],
  operationDescription = "",
): {
  readonly requestBody: RequestBodyDefinition;
  readonly requestBodyOptions?: readonly ImportedRequestBodyOption[];
  readonly defaultRequestBodyOptionId?: string;
  readonly legacyBody: string;
  readonly notes: string;
} {
  const requestBody = resolveLocalReference(
    document,
    rawRequestBody,
    diagnostics,
  );
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) {
    return { requestBody: { kind: "none" }, legacyBody: "", notes: "" };
  }
  const requestBodyDescription = stringValue(requestBody.description).trim();
  const entries = Object.entries(requestBody.content).filter((entry) =>
    isRecord(entry[1]),
  ) as [string, Record<string, unknown>][];
  const notes =
    requestBodyDescription === operationDescription.trim()
      ? ""
      : requestBodyDescription;
  const options = entries.flatMap(([contentType, media], mediaIndex) =>
    requestBodyMediaOptions(
      document,
      contentType,
      media,
      mediaIndex,
      requestBody.required === true,
      itemId,
      diagnostics,
    ),
  );
  if (options.length === 0) {
    return { requestBody: { kind: "none" }, legacyBody: "", notes };
  }
  const selected = [...options].sort(
    (left, right) =>
      mediaTypePriority(requestBodyOptionContentType(left)) -
      mediaTypePriority(requestBodyOptionContentType(right)),
  )[0]!;
  if (options.length > 1) {
    diagnostics.push({
      code: "openapi_body_option_defaulted",
      severity: "info",
      message: `${selected.label} is the default; another request body may be selected before import.`,
      itemId,
    });
  }
  const text =
    selected.requestBody.kind === "text" ? selected.requestBody.text : "";
  return {
    requestBody: selected.requestBody,
    ...(options.length === 1
      ? {}
      : {
          requestBodyOptions: options,
          defaultRequestBodyOptionId: selected.optionId,
        }),
    legacyBody: text,
    notes:
      options.length === 1
        ? joinOpenApiNotes(notes, selected.documentation)
        : notes,
  };
}

/** Expands media examples or schema unions into deterministic body choices. */
function requestBodyMediaOptions(
  document: Record<string, unknown>,
  contentType: string,
  media: Record<string, unknown>,
  mediaIndex: number,
  required: boolean,
  itemId: string,
  diagnostics: ImportDiagnostic[],
): ImportedRequestBodyOption[] {
  const schema = resolveLocalReference(document, media.schema, diagnostics);
  const examples = explicitMediaExamples(document, media, diagnostics);
  const schemaAlternatives =
    examples.length === 0 && isRecord(schema)
      ? schemaUnionAlternatives(document, schema, diagnostics)
      : [];
  const candidates =
    examples.length > 0
      ? examples.map((example) => ({
          name: example.name,
          schema,
          example: example.value,
        }))
      : schemaAlternatives.length > 0
        ? schemaAlternatives.map((alternative, index) => ({
            name:
              stringValue(alternative.title).trim() || `Option ${index + 1}`,
            schema: alternative,
            example: undefined,
          }))
        : [{ name: "", schema, example: undefined }];
  return candidates.map((candidate, candidateIndex) => ({
    optionId: `body:${mediaIndex}:${candidateIndex}`,
    label: [contentType, candidate.name]
      .filter((value) => value !== "")
      .join(" — ")
      .slice(0, 200),
    selectionKey: contentType.toLowerCase(),
    requestBody: mapRequestBodyDefinition(
      document,
      contentType,
      candidate.schema,
      candidate.example,
      itemId,
      diagnostics,
    ),
    documentation: requestBodySchemaNotes(
      document,
      required,
      contentType,
      candidate.schema,
      itemId,
      diagnostics,
    ),
  }));
}

/** Returns oneOf or anyOf branches while allOf remains one composed schema. */
function schemaUnionAlternatives(
  document: Record<string, unknown>,
  schema: Record<string, unknown>,
  diagnostics: ImportDiagnostic[],
): Record<string, unknown>[] {
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : [];
  return alternatives
    .map((alternative) =>
      resolveLocalReference(document, alternative, diagnostics),
    )
    .filter(isRecord);
}

/** Maps one OpenAPI media/schema/example combination into wire body semantics. */
function mapRequestBodyDefinition(
  document: Record<string, unknown>,
  contentType: string,
  schema: unknown,
  explicitExample: unknown,
  itemId: string,
  diagnostics: ImportDiagnostic[],
): RequestBodyDefinition {
  const normalizedContentType = contentType.toLowerCase();
  if (normalizedContentType === "application/x-www-form-urlencoded") {
    return {
      kind: "urlencoded",
      contentType,
      fields: schemaFields(
        document,
        schema,
        diagnostics,
        undefined,
        explicitExample,
      ),
    };
  }
  if (normalizedContentType === "multipart/form-data") {
    const fields = schemaFields(
      document,
      schema,
      diagnostics,
      (name) => {
        diagnostics.push({
          code: "openapi_file_requires_attachment",
          severity: "warning",
          message: `Multipart field ${name} requires a file to be attached after import.`,
          itemId,
        });
      },
      explicitExample,
    );
    return {
      kind: "multipart",
      contentType,
      boundary: `apinteract-import-${createHash("sha256").update(itemId).digest("hex").slice(0, 16)}`,
      fields,
    };
  }
  const example =
    explicitExample === undefined
      ? sampleSchema(document, schema, diagnostics, 0)
      : explicitExample;
  if (
    normalizedContentType !== "application/json" &&
    !normalizedContentType.endsWith("+json")
  ) {
    if (typeof example === "string") {
      return { kind: "text", contentType, text: example };
    }
    if (example !== undefined && example !== null) {
      diagnostics.push({
        code: "openapi_body_example_not_text",
        severity: "warning",
        message: `${contentType} request content was left empty because its example is not a string and this importer does not serialize that media type.`,
        itemId,
      });
    }
    return { kind: "text", contentType, text: "" };
  }
  const text = JSON.stringify(example ?? {}, null, 2);
  return { kind: "text", contentType, text };
}

/** Reads the content type already carried by a normalized body option. */
function requestBodyOptionContentType(
  option: ImportedRequestBodyOption,
): string {
  return option.requestBody.kind === "none"
    ? ""
    : (option.requestBody.contentType ?? "");
}

/** Renders bounded, provider-owned OpenAPI body schemas into request notes. */
function requestBodySchemaNotes(
  document: Record<string, unknown>,
  required: boolean,
  contentType: string,
  rawSchema: unknown,
  itemId: string,
  diagnostics: ImportDiagnostic[],
): string {
  if (rawSchema === undefined) return "";
  const schema = expandLocalSchemaReferences(
    document,
    rawSchema,
    diagnostics,
    new Set(),
    0,
  );
  const sections = [
    "## OpenAPI request body",
    "",
    `Required: ${required ? "yes" : "no"}`,
    "",
    `Content type: \`${contentType.replace(/[\r\n`]/gu, " ")}\``,
    "",
    ...renderOpenApiSchemaTable(schema),
  ];
  const result = sections.join("\n");
  if (Buffer.byteLength(result, "utf8") <= 220 * 1024) return result;
  diagnostics.push({
    code: "openapi_request_schema_notes_limited",
    severity: "warning",
    message:
      "The selected request body schema was too large to include in request documentation.",
    itemId,
  });
  return [
    "## OpenAPI request body",
    "",
    `Required: ${required ? "yes" : "no"}`,
    "",
    `Content type: \`${contentType.replace(/[\r\n`]/gu, " ")}\``,
    "",
    "Schema documentation was omitted because it exceeded the import limit.",
  ].join("\n");
}

interface OpenApiSchemaTableRow {
  readonly field: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
  readonly constraints: string;
}

/** Renders one selected OpenAPI Schema Object as a compact Markdown table. */
function renderOpenApiSchemaTable(value: unknown): string[] {
  const rows: OpenApiSchemaTableRow[] = [];
  collectOpenApiSchemaRows(value, "$body", true, rows, 0);
  return [
    "| Field | Type | Required | Description | Constraints |",
    "| --- | --- | :---: | --- | --- |",
    ...rows.map(
      (row) =>
        `| \`${escapeMarkdownCode(row.field)}\` | ${escapeMarkdownTable(row.type)} | ${row.required ? "Yes" : "No"} | ${escapeMarkdownTable(row.description)} | ${escapeMarkdownTable(row.constraints)} |`,
    ),
  ];
}

/** Flattens nested schema properties into stable field-path table rows. */
function collectOpenApiSchemaRows(
  value: unknown,
  path: string,
  required: boolean,
  rows: OpenApiSchemaTableRow[],
  depth: number,
): void {
  if (rows.length >= 500) return;
  if (depth > 8 || !isRecord(value)) {
    rows.push({
      field: path,
      type: depth > 8 ? "…" : "any",
      required,
      description: "",
      constraints: "",
    });
    return;
  }
  const title = stringValue(value.title).trim();
  rows.push({
    field: path,
    type: openApiSchemaType(value),
    required,
    description: stringValue(value.description).trim(),
    constraints: openApiSchemaConstraints(value, title),
  });
  if (isRecord(value.properties)) {
    const requiredProperties = new Set(
      Array.isArray(value.required)
        ? value.required.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    );
    for (const [name, property] of Object.entries(value.properties)) {
      collectOpenApiSchemaRows(
        property,
        path === "$body" ? name : `${path}.${name}`,
        requiredProperties.has(name),
        rows,
        depth + 1,
      );
    }
  }
  if (value.items !== undefined) {
    collectOpenApiSchemaRows(value.items, `${path}[]`, true, rows, depth + 1);
  }
}

/** Describes one schema's wire type without exposing its raw JSON representation. */
function openApiSchemaType(schema: Record<string, unknown>): string {
  const declared = stringValue(schema.type).trim();
  const type =
    declared ||
    (isRecord(schema.properties)
      ? "object"
      : schema.items !== undefined
        ? "array"
        : Array.isArray(schema.oneOf)
          ? "one of"
          : Array.isArray(schema.anyOf)
            ? "any of"
            : "any");
  const format = stringValue(schema.format).trim();
  return format === "" ? type : `${type} (${format})`;
}

/** Summarizes common OpenAPI validation and example annotations. */
function openApiSchemaConstraints(
  schema: Record<string, unknown>,
  title: string,
): string {
  const constraints: string[] = title === "" ? [] : [`Schema: ${title}`];
  if (schema.const !== undefined)
    constraints.push(`Value: ${editableValue(schema.const)}`);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    constraints.push(
      `Allowed: ${schema.enum.map((entry) => editableValue(entry)).join(", ")}`,
    );
  }
  if (schema.default !== undefined)
    constraints.push(`Default: ${editableValue(schema.default)}`);
  if (schema.example !== undefined)
    constraints.push(`Example: ${editableValue(schema.example)}`);
  for (const [key, label] of [
    ["minimum", "Minimum"],
    ["maximum", "Maximum"],
    ["minLength", "Minimum length"],
    ["maxLength", "Maximum length"],
    ["minItems", "Minimum items"],
    ["maxItems", "Maximum items"],
    ["pattern", "Pattern"],
  ] as const) {
    if (schema[key] !== undefined)
      constraints.push(`${label}: ${editableValue(schema[key])}`);
  }
  if (schema.nullable === true) constraints.push("Nullable");
  if (schema.deprecated === true) constraints.push("Deprecated");
  return constraints.join("; ");
}

/** Escapes arbitrary imported text for a Markdown table cell. */
function escapeMarkdownTable(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/[\r\n]+/gu, "<br>");
}

/** Escapes field paths embedded in Markdown code spans. */
function escapeMarkdownCode(value: string): string {
  return value.replace(/`/gu, "\\`").replace(/[\r\n]+/gu, " ");
}

/** Dereferences bounded local schema references while retaining cyclic markers. */
function expandLocalSchemaReferences(
  document: Record<string, unknown>,
  value: unknown,
  diagnostics: ImportDiagnostic[],
  references: ReadonlySet<string>,
  depth: number,
): unknown {
  if (depth > 30) return value;
  if (Array.isArray(value)) {
    return value.map((entry) =>
      expandLocalSchemaReferences(
        document,
        entry,
        diagnostics,
        references,
        depth + 1,
      ),
    );
  }
  if (!isRecord(value)) return value;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    if (references.has(value.$ref)) return { $ref: value.$ref };
    const resolved = resolveLocalReference(document, value, diagnostics);
    if (resolved === undefined || resolved === value) return value;
    return expandLocalSchemaReferences(
      document,
      resolved,
      diagnostics,
      new Set([...references, value.$ref]),
      depth + 1,
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      expandLocalSchemaReferences(
        document,
        entry,
        diagnostics,
        references,
        depth + 1,
      ),
    ]),
  );
}

/** Assigns a stable preference order to request media types. */
function mediaTypePriority(contentType: string): number {
  if (contentType === "application/json" || contentType.endsWith("+json"))
    return 0;
  if (contentType === "application/x-www-form-urlencoded") return 1;
  if (contentType === "multipart/form-data") return 2;
  if (contentType.startsWith("text/")) return 3;
  return 4;
}

/** Produces editable form fields from one shallow object schema. */
function schemaFields(
  document: Record<string, unknown>,
  rawSchema: unknown,
  diagnostics: ImportDiagnostic[],
  onBinary?: (name: string) => void,
  rawExample?: unknown,
): RequestField[] {
  const schema = resolveLocalReference(document, rawSchema, diagnostics);
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const fields: RequestField[] = [];
  const example = isRecord(rawExample) ? rawExample : {};
  for (const [name, rawProperty] of Object.entries(schema.properties)) {
    const property = resolveLocalReference(document, rawProperty, diagnostics);
    if (!isRecord(property)) continue;
    if (property.type === "string" && property.format === "binary") {
      onBinary?.(name);
      continue;
    }
    const description = stringValue(property.description);
    fields.push({
      name,
      value: editableValue(
        example[name] ?? property.example ?? property.default,
      ),
      enabled: required.has(name),
      ...(description === "" ? {} : { description }),
    });
  }
  return fields;
}

/** Generates a small deterministic example without traversing recursive schemas deeply. */
function sampleSchema(
  document: Record<string, unknown>,
  rawSchema: unknown,
  diagnostics: ImportDiagnostic[],
  depth: number,
): unknown {
  if (depth > 3) return undefined;
  const schema = resolveLocalReference(document, rawSchema, diagnostics);
  if (!isRecord(schema)) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0];
  if (Array.isArray(schema.allOf)) {
    const samples = schema.allOf.map((entry) =>
      sampleSchema(document, entry, diagnostics, depth + 1),
    );
    if (samples.every(isRecord)) return Object.assign({}, ...samples);
  }
  const union = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : [];
  if (union.length > 0) {
    return sampleSchema(document, union[0], diagnostics, depth + 1);
  }
  if (schema.type === "object" || isRecord(schema.properties)) {
    const output: Record<string, unknown> = {};
    if (isRecord(schema.properties)) {
      for (const [name, property] of Object.entries(schema.properties)) {
        const sample = sampleSchema(document, property, diagnostics, depth + 1);
        if (sample !== undefined) output[name] = sample;
      }
    }
    return output;
  }
  if (schema.type === "array") {
    const sample = sampleSchema(document, schema.items, diagnostics, depth + 1);
    return sample === undefined ? [] : [sample];
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return 0;
  return "";
}

/** Maps the first OpenAPI security alternative into blank secret variables. */
function mapSecurity(
  document: Record<string, unknown>,
  rawSecurity: unknown,
  itemId: string,
  diagnostics: ImportDiagnostic[],
  reservedVariableNames: readonly string[],
): {
  readonly query: RequestField[];
  readonly headers: RequestField[];
  readonly variables: VariableWrite[];
  readonly notes: string;
} {
  const query: RequestField[] = [];
  const headers: RequestField[] = [];
  const variables: VariableWrite[] = [];
  const variableNames = new Set(reservedVariableNames);
  const schemes =
    isRecord(document.components) &&
    isRecord(document.components.securitySchemes)
      ? document.components.securitySchemes
      : {};
  const requirements = unknownArray(rawSecurity).filter(isRecord);
  const notes = securityNotes(document, requirements, diagnostics);
  if (requirements.length === 0) return { query, headers, variables, notes };
  const selectedIndex = requirements.findIndex((requirement) =>
    Object.keys(requirement).every((schemeName) => {
      const scheme = resolveLocalReference(
        document,
        schemes[schemeName],
        diagnostics,
      );
      return executableSecurityScheme(scheme);
    }),
  );
  if (selectedIndex < 0) {
    diagnostics.push({
      code: "openapi_security_requires_manual_configuration",
      severity: "warning",
      message:
        "The operation's security requirements were documented but require manual configuration.",
      itemId,
    });
    return { query, headers, variables, notes };
  }
  const requirement = requirements[selectedIndex]!;
  if (selectedIndex > 0) {
    diagnostics.push({
      code: "openapi_security_alternative_selected",
      severity: "info",
      message: `Security alternative ${selectedIndex + 1} was selected because earlier alternatives require manual configuration.`,
      itemId,
    });
  }
  for (const schemeName of Object.keys(requirement)) {
    const scheme = resolveLocalReference(
      document,
      schemes[schemeName],
      diagnostics,
    );
    if (!isRecord(scheme) || !executableSecurityScheme(scheme)) continue;
    const variableName = uniqueVariableName(schemeName, variableNames);
    variableNames.add(variableName);
    const description = stringValue(scheme.description);
    variables.push({
      name: variableName,
      kind: "secret",
      ...(description === "" ? {} : { description }),
    });
    if (scheme.type === "apiKey") {
      const name = stringValue(scheme.name, schemeName);
      if (scheme.in === "query")
        query.push({ name, value: `<<${variableName}>>`, enabled: true });
      else if (scheme.in === "cookie")
        headers.push({
          name: "Cookie",
          value: `${name}=<<${variableName}>>`,
          enabled: true,
          mode: "append",
        });
      else
        headers.push({
          name,
          value: `<<${variableName}>>`,
          enabled: true,
          mode: "override",
        });
    } else {
      const prefix =
        scheme.scheme === "bearer"
          ? "Bearer "
          : scheme.scheme === "basic"
            ? "Basic "
            : "";
      headers.push({
        name: "Authorization",
        value: `${prefix}<<${variableName}>>`,
        enabled: true,
        mode: "override",
      });
    }
    diagnostics.push({
      code: "openapi_security_secret_unconfigured",
      severity: "warning",
      message: `Security scheme ${schemeName} was imported as unconfigured secret variable ${variableName}; set its value before sending requests.`,
      itemId,
      sourceLocation: `#/components/securitySchemes/${escapePointer(schemeName)}`,
    });
  }
  return { query, headers, variables, notes };
}

/** Reports whether core request fields can represent one security scheme safely. */
function executableSecurityScheme(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (value.type === "apiKey") {
    return (
      typeof value.name === "string" &&
      (value.in === "header" || value.in === "query" || value.in === "cookie")
    );
  }
  return (
    value.type === "http" &&
    (value.scheme === "bearer" || value.scheme === "basic")
  );
}

/** Documents effective OpenAPI OR/AND security semantics without importing secrets. */
function securityNotes(
  document: Record<string, unknown>,
  requirements: readonly Record<string, unknown>[],
  diagnostics: ImportDiagnostic[],
): string {
  if (requirements.length === 0) {
    return "## Security\n\nNo security requirement.";
  }
  const schemes =
    isRecord(document.components) &&
    isRecord(document.components.securitySchemes)
      ? document.components.securitySchemes
      : {};
  const alternatives = requirements.map((requirement, index) => {
    const entries = Object.entries(requirement);
    if (entries.length === 0) return `${index + 1}. No authentication`;
    const rendered = entries.map(([schemeName, rawScopes]) => {
      const scheme = resolveLocalReference(
        document,
        schemes[schemeName],
        diagnostics,
      );
      return securitySchemeSummary(schemeName, scheme, rawScopes);
    });
    return `${index + 1}. ${rendered.join(" **and** ")}`;
  });
  return [
    "## Security",
    "",
    ...(alternatives.length > 1 ? ["Any one of:", ""] : []),
    ...alternatives,
  ].join("\n");
}

/** Formats one OpenAPI security scheme and the scopes required by an operation. */
function securitySchemeSummary(
  name: string,
  rawScheme: unknown,
  rawScopes: unknown,
): string {
  if (!isRecord(rawScheme)) return `\`${name}\` — unresolved scheme`;
  const description = stringValue(rawScheme.description).trim();
  let detail = stringValue(rawScheme.type, "unknown security scheme");
  if (rawScheme.type === "apiKey") {
    detail = `API key in ${stringValue(rawScheme.in, "unknown location")} \`${stringValue(rawScheme.name, name)}\``;
  } else if (rawScheme.type === "http") {
    detail = `HTTP ${stringValue(rawScheme.scheme, "authentication")}`;
    const bearerFormat = stringValue(rawScheme.bearerFormat).trim();
    if (bearerFormat !== "") detail += ` (${bearerFormat})`;
  } else if (rawScheme.type === "oauth2") {
    const scopes = unknownArray(rawScopes).filter(
      (scope): scope is string => typeof scope === "string",
    );
    detail = `OAuth 2.0${scopes.length === 0 ? "" : ` scopes: ${scopes.join(", ")}`}`;
  } else if (rawScheme.type === "openIdConnect") {
    detail = `OpenID Connect ${stringValue(rawScheme.openIdConnectUrl)}`.trim();
  } else if (rawScheme.type === "mutualTLS") {
    detail = "mutual TLS";
  }
  return `\`${name}\` — ${detail}${description === "" ? "" : ` — ${description}`}`;
}

/** Chooses a stable human-facing operation name. */
function requestName(
  operation: Record<string, unknown>,
  method: string,
  path: string,
): string {
  return (
    stringValue(operation.operationId).trim() ||
    stringValue(operation.summary).trim() ||
    `${method} ${path}`
  ).slice(0, 200);
}

/** Produces a request-variable identifier safe for the interpolation grammar. */
function uniqueVariableName(
  name: string,
  reservedNames: ReadonlySet<string>,
): string {
  const sanitized = name.replace(/[^A-Za-z0-9_.-]/g, "_") || "value";
  const base = /^[A-Za-z_]/u.test(sanitized) ? sanitized : `_${sanitized}`;
  let candidate = base;
  let suffix = 2;
  while (reservedNames.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Escapes one JSON Pointer path segment for diagnostic provenance. */
function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
