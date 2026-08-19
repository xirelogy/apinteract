import { createHash } from "node:crypto";

import type {
  RequestBodyDefinition,
  RequestField,
} from "../requests/request-service.js";
import type { VariableWrite } from "../variables/variable-profile-store.js";
import {
  type ImportDiagnostic,
  type ImportedCollection,
  type ImportedRequest,
  type ImportPlan,
  type ImportProbeResult,
  type ImportProvider,
  type ImportProviderManifest,
  type ImportSource,
  ImportSourceError,
} from "./import-types.js";
import {
  editableValue,
  isRecord,
  parseJsonObject,
  sourceStem,
  stringValue,
  unknownArray,
} from "./provider-utils.js";

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
    version: "1.2.0",
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
      throw new ImportSourceError(
        "openapi_version_unsupported",
        "Only OpenAPI 3.0 and 3.1 JSON documents are supported.",
      );
    }
    const diagnostics: ImportDiagnostic[] = [];
    const requests: ImportedRequest[] = [];
    const info = isRecord(document.info) ? document.info : {};
    const suggestedName = (
      stringValue(info.title).trim() || sourceStem(source.name)
    ).slice(0, 200);
    const mappedRequests: MappedOpenApiRequest[] = [];
    const paths = isRecord(document.paths) ? document.paths : {};
    for (const [path, rawPathItem] of Object.entries(paths)) {
      const pathItem = resolveLocalReference(
        document,
        rawPathItem,
        diagnostics,
      );
      if (!isRecord(pathItem)) continue;
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
        if (
          containsResponseExample(document, operation.responses, diagnostics)
        ) {
          diagnostics.push({
            code: "openapi_response_example_available",
            severity: "info",
            message:
              "Response examples are present but are not treated as recorded responses.",
            itemId,
          });
        }
        mappedRequests.push({
          server,
          path,
          tag: primaryOperationTag(operation, itemId, diagnostics),
          request: {
            itemId,
            sourceLocation,
            collectionKey: null,
            name: requestName(operation, method, path),
            method,
            targetMode: "composed",
            targetUrl: mapped.targetUrl,
            query: [...mapped.query, ...security.query],
            headers: [...mapped.headers, ...security.headers],
            requestBody: body.requestBody,
            body: body.legacyBody,
            preRequestScript: "",
            postResponseScript: "",
            variables: [
              ...server.variables,
              ...mapped.variables,
              ...security.variables,
            ],
          },
        });
      }
    }
    const hierarchy = buildOpenApiHierarchy(
      mappedRequests,
      declaredTagOrder(document.tags),
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
      pathPrefix: hierarchy.pathPrefix,
      variables: hierarchy.variables,
      collections: hierarchy.collections,
      requests,
      diagnostics,
    };
  }
}

/** Represents one normalized effective server boundary used for composition. */
interface ResolvedOpenApiServer {
  readonly key: string;
  readonly url: string;
  readonly variables: readonly VariableWrite[];
}

/** Retains provider metadata needed to build the imported collection tree. */
interface MappedOpenApiRequest {
  readonly request: ImportedRequest;
  readonly server: ResolvedOpenApiServer;
  readonly path: string;
  readonly tag: string | null;
}

/** Contains the root profile and routed requests produced from OpenAPI groups. */
interface OpenApiHierarchy {
  readonly pathPrefix: string;
  readonly variables: readonly VariableWrite[];
  readonly collections: readonly ImportedCollection[];
  readonly requests: readonly ImportedRequest[];
}

/** Builds tag, optional server, and path collections without request overrides. */
function buildOpenApiHierarchy(
  mappedRequests: readonly MappedOpenApiRequest[],
  tagOrder: readonly string[],
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
    { readonly variable: VariableWrite; readonly itemId: string }
  >();
  for (const mapped of mappedRequests) {
    for (const variable of mapped.request.variables) {
      const existing = declarations.get(variable.name);
      if (existing === undefined) {
        declarations.set(variable.name, {
          variable,
          itemId: mapped.request.itemId,
        });
        variables.push(variable);
      } else if (
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
    }
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
    return { key: "server:none", url: "", variables: [] };
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
    return { key: `server:invalid:${itemId}`, url: "", variables: [] };
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
    serverVariables.push({
      name: variableName,
      kind: "value",
      value: hasDefault ? editableValue(definition.default) : "",
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

/** Reports whether any response media definition contains an explicit example. */
function containsResponseExample(
  document: Record<string, unknown>,
  rawResponses: unknown,
  diagnostics: ImportDiagnostic[],
): boolean {
  if (!isRecord(rawResponses)) return false;
  return Object.values(rawResponses).some((rawResponse) => {
    const response = resolveLocalReference(document, rawResponse, diagnostics);
    if (!isRecord(response) || !isRecord(response.content)) return false;
    return Object.values(response.content).some(
      (rawMedia) =>
        isRecord(rawMedia) &&
        (rawMedia.example !== undefined ||
          (isRecord(rawMedia.examples) &&
            Object.keys(rawMedia.examples).length > 0)),
    );
  });
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
    if (location === "path") {
      const variableName = uniqueVariableName(name, variableNames);
      variableNames.add(variableName);
      targetUrl = targetUrl.replaceAll(`{${name}}`, `<<${variableName}>>`);
      variables.push({ name: variableName, kind: "value", value });
    } else if (location === "query") {
      query.push({ name, value, enabled });
    } else if (location === "header") {
      headers.push({ name, value, enabled, mode: "override" });
    } else if (location === "cookie") {
      headers.push({
        name: "Cookie",
        value: `${name}=${value}`,
        enabled,
        mode: "append",
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
): {
  readonly requestBody: RequestBodyDefinition;
  readonly legacyBody: string;
} {
  const requestBody = resolveLocalReference(
    document,
    rawRequestBody,
    diagnostics,
  );
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) {
    return { requestBody: { kind: "none" }, legacyBody: "" };
  }
  const entries = Object.entries(requestBody.content).filter((entry) =>
    isRecord(entry[1]),
  ) as [string, Record<string, unknown>][];
  const selected = [...entries].sort(
    (left, right) => mediaTypePriority(left[0]) - mediaTypePriority(right[0]),
  )[0];
  if (selected === undefined) {
    return { requestBody: { kind: "none" }, legacyBody: "" };
  }
  if (entries.length > 1) {
    diagnostics.push({
      code: "openapi_body_media_type_selected",
      severity: "info",
      message: `${selected[0]} was selected from ${entries.length} request body media types.`,
      itemId,
    });
  }
  const [contentType, media] = selected;
  const schema = resolveLocalReference(document, media.schema, diagnostics);
  if (contentType === "application/x-www-form-urlencoded") {
    return {
      requestBody: {
        kind: "urlencoded",
        contentType,
        fields: schemaFields(document, schema, diagnostics),
      },
      legacyBody: "",
    };
  }
  if (contentType === "multipart/form-data") {
    const fields = schemaFields(document, schema, diagnostics, (name) => {
      diagnostics.push({
        code: "openapi_file_requires_attachment",
        severity: "warning",
        message: `Multipart field ${name} requires a file to be attached after import.`,
        itemId,
      });
    });
    return {
      requestBody: {
        kind: "multipart",
        contentType,
        boundary: `apinteract-import-${createHash("sha256").update(itemId).digest("hex").slice(0, 16)}`,
        fields,
      },
      legacyBody: "",
    };
  }
  const example = mediaExample(document, media, schema, diagnostics);
  const text =
    contentType === "application/json" || contentType.endsWith("+json")
      ? JSON.stringify(example ?? {}, null, 2)
      : editableValue(example);
  return {
    requestBody: { kind: "text", contentType, text },
    legacyBody: text,
  };
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
  for (const [name, rawProperty] of Object.entries(schema.properties)) {
    const property = resolveLocalReference(document, rawProperty, diagnostics);
    if (!isRecord(property)) continue;
    if (property.type === "string" && property.format === "binary") {
      onBinary?.(name);
      continue;
    }
    fields.push({
      name,
      value: editableValue(property.example ?? property.default),
      enabled: required.has(name),
    });
  }
  return fields;
}

/** Chooses an explicit media example or derives a bounded shallow schema sample. */
function mediaExample(
  document: Record<string, unknown>,
  media: Record<string, unknown>,
  rawSchema: unknown,
  diagnostics: ImportDiagnostic[],
): unknown {
  if (media.example !== undefined) return media.example;
  if (isRecord(media.examples)) {
    const first = Object.values(media.examples)[0];
    const resolved = resolveLocalReference(document, first, diagnostics);
    if (isRecord(resolved) && resolved.value !== undefined)
      return resolved.value;
  }
  return sampleSchema(document, rawSchema, diagnostics, 0);
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
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0];
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
} {
  const query: RequestField[] = [];
  const headers: RequestField[] = [];
  const variables: VariableWrite[] = [];
  const variableNames = new Set(reservedVariableNames);
  const requirement = unknownArray(rawSecurity)[0];
  const schemes =
    isRecord(document.components) &&
    isRecord(document.components.securitySchemes)
      ? document.components.securitySchemes
      : {};
  if (!isRecord(requirement)) return { query, headers, variables };
  for (const schemeName of Object.keys(requirement)) {
    const scheme = resolveLocalReference(
      document,
      schemes[schemeName],
      diagnostics,
    );
    if (!isRecord(scheme)) continue;
    if (scheme.type !== "apiKey" && scheme.type !== "http") {
      diagnostics.push({
        code: "openapi_security_scheme_unsupported",
        severity: "warning",
        message: `Security scheme ${schemeName} requires manual configuration.`,
        itemId,
      });
      continue;
    }
    const variableName = uniqueVariableName(schemeName, variableNames);
    variableNames.add(variableName);
    variables.push({ name: variableName, kind: "secret" });
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
  return { query, headers, variables };
}

/** Chooses a stable human-facing operation name. */
function requestName(
  operation: Record<string, unknown>,
  method: string,
  path: string,
): string {
  return (
    stringValue(operation.summary).trim() ||
    stringValue(operation.operationId).trim() ||
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
