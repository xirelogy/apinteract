import { createHash } from "node:crypto";

import type {
  RequestBodyDefinition,
  RequestField,
} from "../requests/request-service.js";
import type { VariableWrite } from "../variables/variable-profile-store.js";
import {
  type ImportDiagnostic,
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
    version: "1.0.0",
    label: "OpenAPI JSON",
    acceptedExtensions: [".json"],
    acceptedMediaTypes: ["application/json"],
    inputKinds: ["file"],
    capabilities: {
      multipleRequests: true,
      hierarchy: false,
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
    const server = resolveServerUrl(document, diagnostics);
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
        if (unknownArray(operation.servers).length > 0) {
          diagnostics.push({
            code: "openapi_operation_server_ignored",
            severity: "warning",
            message:
              "An operation-level server override was not selected; the document server is used.",
            itemId,
          });
        }
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
        requests.push({
          itemId,
          sourceLocation: `#/paths/${escapePointer(path)}/${methodName}`,
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
        });
      }
    }
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
      pathPrefix: server.url,
      requests,
      diagnostics,
    };
  }
}

/** Resolves the first OpenAPI server and substitutes declared server defaults. */
function resolveServerUrl(
  document: Record<string, unknown>,
  diagnostics: ImportDiagnostic[],
): { readonly url: string; readonly variables: VariableWrite[] } {
  const server = unknownArray(document.servers)[0];
  if (unknownArray(document.servers).length > 1) {
    diagnostics.push({
      code: "openapi_server_selected",
      severity: "info",
      message: "The first document server was selected for this import.",
      sourceLocation: "#/servers/0",
    });
  }
  if (!isRecord(server)) return { url: "", variables: [] };
  let url = stringValue(server.url);
  const requestVariables: VariableWrite[] = [];
  const requestVariableNames = new Set<string>();
  const variables = isRecord(server.variables) ? server.variables : {};
  url = url.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const definition = variables[name];
    if (isRecord(definition) && definition.default !== undefined) {
      return editableValue(definition.default);
    }
    diagnostics.push({
      code: "openapi_server_variable_unresolved",
      severity: "warning",
      message: `Server variable ${name} has no default and was converted to an APInteract variable.`,
      sourceLocation: "#/servers/0",
    });
    const variableName = uniqueVariableName(name, requestVariableNames);
    requestVariableNames.add(variableName);
    requestVariables.push({ name: variableName, kind: "value", value: "" });
    return `<<${variableName}>>`;
  });
  return { url, variables: requestVariables };
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
