import type {
  HttpMethod,
  RequestBodyDefinition,
  RequestField,
} from "../requests/request-service.js";
import type { VariableWrite } from "../variables/variable-profile-store.js";
import {
  type CapturedExchangeView,
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
  isRecord,
  optionalTimestamp,
  parseJsonObject,
  sourceStem,
  stringValue,
  utf8Bytes,
} from "./provider-utils.js";

const SUPPORTED_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
const DERIVED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_CAPTURE_BODY_CHARACTERS = 262_144;

/** Imports HAR 1.2 request entries and their recorded responses. */
export class HarImportProvider implements ImportProvider {
  readonly manifest: ImportProviderManifest = {
    id: "har",
    version: "1.0.0",
    label: "HAR",
    acceptedExtensions: [".har", ".json"],
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
  };

  /** Recognizes HAR documents by their log version and entry collection. */
  probe(source: ImportSource): ImportProbeResult {
    try {
      const document = JSON.parse(source.text) as unknown;
      const log =
        isRecord(document) && isRecord(document.log) ? document.log : null;
      return log !== null && Array.isArray(log.entries)
        ? {
            confidence: log.version === "1.2" ? 1 : 0.9,
            reason: "HAR log entries",
          }
        : { confidence: 0, reason: "Missing HAR log entries" };
    } catch {
      return { confidence: 0, reason: "Invalid JSON" };
    }
  }

  /** Converts bounded HAR entries into absolute requests and captured responses. */
  parse(source: ImportSource): Omit<ImportPlan, "sourceFingerprint"> {
    const document = parseJsonObject(source);
    const log = isRecord(document.log) ? document.log : null;
    if (log === null || !Array.isArray(log.entries)) {
      throw new ImportSourceError(
        "har_invalid",
        "The source does not contain a HAR log entry array.",
      );
    }
    const diagnostics: ImportDiagnostic[] = [];
    const requests: ImportedRequest[] = [];
    log.entries.forEach((rawEntry, index) => {
      const entry = isRecord(rawEntry) ? rawEntry : null;
      const request =
        entry !== null && isRecord(entry.request) ? entry.request : null;
      if (entry === null || request === null) {
        diagnostics.push({
          code: "har_entry_invalid",
          severity: "warning",
          message: `HAR entry ${index + 1} was skipped because it has no request.`,
          sourceLocation: `#/log/entries/${index}`,
        });
        return;
      }
      const method = stringValue(request.method).toUpperCase();
      if (!SUPPORTED_METHODS.has(method as HttpMethod)) {
        diagnostics.push({
          code: "har_method_unsupported",
          severity: "warning",
          message: `HAR entry ${index + 1} uses unsupported method ${method || "(empty)"}.`,
          sourceLocation: `#/log/entries/${index}/request/method`,
        });
        return;
      }
      const itemId = `entry:${index}`;
      const sensitiveVariables: VariableWrite[] = [];
      const mappedUrl = mapHarUrl(
        request,
        index,
        itemId,
        sensitiveVariables,
        diagnostics,
      );
      const headers = mapHarRequestHeaders(
        request.headers,
        itemId,
        sensitiveVariables,
        diagnostics,
      );
      if (!headers.some((header) => header.name.toLowerCase() === "cookie")) {
        headers.push(
          ...mapHarCookies(
            request.cookies,
            itemId,
            sensitiveVariables,
            diagnostics,
          ),
        );
      }
      const body = mapHarRequestBody(request.postData, itemId, diagnostics);
      const capturedExchange = isRecord(entry.response)
        ? mapHarResponse(
            entry.response,
            entry.startedDateTime,
            itemId,
            diagnostics,
          )
        : undefined;
      requests.push({
        itemId,
        sourceLocation: `#/log/entries/${index}`,
        name: harRequestName(method, mappedUrl.targetUrl, entry),
        method: method as HttpMethod,
        targetMode: "absolute",
        targetUrl: mappedUrl.targetUrl,
        query: mappedUrl.query,
        headers,
        requestBody: body.requestBody,
        body: body.legacyBody,
        preRequestScript: "",
        postResponseScript: "",
        variables: sensitiveVariables,
        ...(capturedExchange === undefined ? {} : { capturedExchange }),
      });
    });
    if (requests.length === 0) {
      diagnostics.push({
        code: "har_no_requests",
        severity: "error",
        message: "The HAR source does not contain supported requests.",
        sourceLocation: "#/log/entries",
      });
    }
    return {
      schemaVersion: 1,
      providerId: this.manifest.id,
      providerVersion: this.manifest.version,
      sourceName: source.name,
      suggestedName: sourceStem(source.name),
      pathPrefix: "",
      requests,
      diagnostics,
    };
  }
}

/** Separates the HAR URL query and rejects unsupported WebSocket schemes. */
function mapHarUrl(
  request: Record<string, unknown>,
  entryIndex: number,
  itemId: string,
  variables: VariableWrite[],
  diagnostics: ImportDiagnostic[],
): { readonly targetUrl: string; readonly query: RequestField[] } {
  const rawUrl = stringValue(request.url);
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "ws:" || url.protocol === "wss:") {
      diagnostics.push({
        code: "har_websocket_unsupported",
        severity: "error",
        message: `HAR entry ${entryIndex + 1} uses the unsupported ${url.protocol} WebSocket scheme.`,
        itemId,
        sourceLocation: `#/log/entries/${entryIndex}/request/url`,
      });
    }
    const query = mapHarQueryFields(
      Array.isArray(request.queryString)
        ? request.queryString
        : [...url.searchParams.entries()].map(([name, value]) => ({
            name,
            value,
          })),
      itemId,
      variables,
      diagnostics,
    );
    url.search = "";
    url.hash = "";
    return { targetUrl: url.toString(), query };
  } catch {
    diagnostics.push({
      code: "har_url_invalid",
      severity: "warning",
      message: `HAR entry ${entryIndex + 1} contains a URL that could not be structured.`,
      sourceLocation: `#/log/entries/${entryIndex}/request/url`,
    });
    return {
      targetUrl: rawUrl,
      query: Array.isArray(request.queryString)
        ? mapHarQueryFields(request.queryString, itemId, variables, diagnostics)
        : [],
    };
  }
}

/** Secretizes credential-like HAR query parameters before draft persistence. */
function mapHarQueryFields(
  rawFields: unknown,
  itemId: string,
  variables: VariableWrite[],
  diagnostics: ImportDiagnostic[],
): RequestField[] {
  if (!Array.isArray(rawFields)) return [];
  return rawFields.flatMap((rawField) => {
    if (!isRecord(rawField)) return [];
    const name = stringValue(rawField.name);
    const value = stringValue(rawField.value);
    if (!/(^|[-_])(api[-_]?key|token|secret)([-_]|$)/i.test(name)) {
      return [{ name, value, enabled: true }];
    }
    const variableName = nextSecretVariableName(name, variables);
    variables.push({ name: variableName, kind: "secret", value });
    diagnostics.push({
      code: "har_sensitive_query_secretized",
      severity: "info",
      message: `Sensitive query parameter ${name} was converted to a secret request variable.`,
      itemId,
    });
    return [{ name, value: `<<${variableName}>>`, enabled: true }];
  });
}

/** Maps HAR headers while omitting derived fields and secretizing credentials. */
function mapHarRequestHeaders(
  rawHeaders: unknown,
  itemId: string,
  variables: VariableWrite[],
  diagnostics: ImportDiagnostic[],
): RequestField[] {
  if (!Array.isArray(rawHeaders)) return [];
  const headers: RequestField[] = [];
  for (const rawHeader of rawHeaders) {
    if (!isRecord(rawHeader)) continue;
    const name = stringValue(rawHeader.name);
    const value = stringValue(rawHeader.value);
    const normalizedName = name.toLowerCase();
    if (isHttpPseudoHeader(normalizedName)) {
      diagnostics.push({
        code: "har_pseudo_header_omitted",
        severity: "info",
        message: `HTTP pseudo-header ${name} was omitted from the imported request.`,
        itemId,
      });
      continue;
    }
    if (DERIVED_HEADERS.has(normalizedName)) {
      diagnostics.push({
        code: "har_derived_header_omitted",
        severity: "info",
        message: `Derived header ${name} was omitted.`,
        itemId,
      });
      continue;
    }
    if (isSensitiveHeader(normalizedName)) {
      const variableName = nextSecretVariableName(name, variables);
      variables.push({ name: variableName, kind: "secret", value });
      headers.push({
        name,
        value: `<<${variableName}>>`,
        enabled: true,
        mode: "override",
      });
      diagnostics.push({
        code: "har_sensitive_header_secretized",
        severity: "info",
        message: `Sensitive header ${name} was converted to a secret request variable.`,
        itemId,
      });
      continue;
    }
    headers.push({ name, value, enabled: true, mode: "override" });
  }
  return headers;
}

/** Converts structured HAR cookies into secret-backed Cookie header fields. */
function mapHarCookies(
  rawCookies: unknown,
  itemId: string,
  variables: VariableWrite[],
  diagnostics: ImportDiagnostic[],
): RequestField[] {
  if (!Array.isArray(rawCookies)) return [];
  const fields: RequestField[] = [];
  for (const rawCookie of rawCookies) {
    if (!isRecord(rawCookie)) continue;
    const name = stringValue(rawCookie.name);
    const value = stringValue(rawCookie.value);
    if (name === "") continue;
    const variableName = nextSecretVariableName(`cookie_${name}`, variables);
    variables.push({ name: variableName, kind: "secret", value });
    fields.push({
      name: "Cookie",
      value: `${name}=<<${variableName}>>`,
      enabled: true,
      mode: "append",
    });
  }
  if (fields.length > 0) {
    diagnostics.push({
      code: "har_cookies_secretized",
      severity: "info",
      message:
        "Structured HAR cookies were converted to secret request variables.",
      itemId,
    });
  }
  return fields;
}

/** Converts HAR postData into the nearest editable body representation. */
function mapHarRequestBody(
  rawPostData: unknown,
  itemId: string,
  diagnostics: ImportDiagnostic[],
): {
  readonly requestBody: RequestBodyDefinition;
  readonly legacyBody: string;
} {
  if (!isRecord(rawPostData)) {
    return { requestBody: { kind: "none" }, legacyBody: "" };
  }
  const contentType = stringValue(rawPostData.mimeType) || null;
  if (
    contentType?.startsWith("application/x-www-form-urlencoded") &&
    Array.isArray(rawPostData.params)
  ) {
    return {
      requestBody: {
        kind: "urlencoded",
        contentType,
        fields: mapNameValueFields(rawPostData.params),
      },
      legacyBody: "",
    };
  }
  if (
    contentType?.startsWith("multipart/form-data") &&
    Array.isArray(rawPostData.params)
  ) {
    const fields: RequestField[] = [];
    for (const rawParameter of rawPostData.params) {
      if (!isRecord(rawParameter)) continue;
      const name = stringValue(rawParameter.name);
      if (typeof rawParameter.fileName === "string") {
        diagnostics.push({
          code: "har_file_bytes_missing",
          severity: "warning",
          message: `Multipart field ${name} references ${rawParameter.fileName}, but HAR does not include its file bytes.`,
          itemId,
        });
        continue;
      }
      fields.push({
        name,
        value: stringValue(rawParameter.value),
        enabled: true,
      });
    }
    return {
      requestBody: {
        kind: "multipart",
        contentType: "multipart/form-data",
        boundary: `apinteract-har-${itemId.replace(/[^A-Za-z0-9]/g, "-")}`,
        fields,
      },
      legacyBody: "",
    };
  }
  const text = stringValue(rawPostData.text);
  return {
    requestBody: { kind: "text", contentType, text },
    legacyBody: text,
  };
}

/** Maps a recorded HAR response and redacts known credential-bearing headers. */
function mapHarResponse(
  response: Record<string, unknown>,
  startedDateTime: unknown,
  itemId: string,
  diagnostics: ImportDiagnostic[],
): CapturedExchangeView | undefined {
  const status = response.status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    diagnostics.push({
      code: "har_response_unavailable",
      severity: "info",
      message: "The HAR entry did not contain a completed HTTP response.",
      itemId,
    });
    return undefined;
  }
  const content = isRecord(response.content) ? response.content : {};
  const bodyIncluded = typeof content.text === "string";
  const originalBody = stringValue(content.text);
  const encoding = content.encoding === "base64" ? "base64" : "text";
  const declaredSize =
    typeof content.size === "number" && content.size >= 0
      ? content.size
      : encoding === "base64"
        ? decodedBase64Bytes(originalBody)
        : utf8Bytes(originalBody);
  const bodyUnavailable = !bodyIncluded && declaredSize > 0;
  const bodyComplete =
    !bodyUnavailable && originalBody.length <= MAX_CAPTURE_BODY_CHARACTERS;
  const body = bodyComplete
    ? originalBody
    : originalBody.slice(0, MAX_CAPTURE_BODY_CHARACTERS);
  if (bodyUnavailable) {
    diagnostics.push({
      code: "har_response_body_unavailable",
      severity: "warning",
      message:
        "The HAR entry declares a response body but does not include its content.",
      itemId,
    });
  } else if (!bodyComplete) {
    diagnostics.push({
      code: "har_response_body_truncated",
      severity: "warning",
      message: "The captured response body was truncated to the preview limit.",
      itemId,
    });
  }
  return {
    source: "har",
    status,
    statusText: stringValue(response.statusText),
    headers: Array.isArray(response.headers)
      ? response.headers.flatMap((rawHeader) => {
          if (!isRecord(rawHeader)) return [];
          const name = stringValue(rawHeader.name);
          if (isHttpPseudoHeader(name)) {
            diagnostics.push({
              code: "har_response_pseudo_header_omitted",
              severity: "info",
              message: `HTTP pseudo-header ${name} was omitted from the captured response.`,
              itemId,
            });
            return [];
          }
          return [
            {
              name,
              value:
                name.toLowerCase() === "set-cookie" ||
                isSensitiveHeader(name.toLowerCase())
                  ? "[redacted]"
                  : stringValue(rawHeader.value),
            },
          ];
        })
      : [],
    contentType: stringValue(content.mimeType) || null,
    body,
    bodyEncoding: encoding,
    bodyComplete,
    bodyBytes: declaredSize,
    recordedAt: optionalTimestamp(startedDateTime),
  };
}

/** Converts HAR name/value arrays into enabled structured fields. */
function mapNameValueFields(value: unknown): RequestField[] {
  return Array.isArray(value)
    ? value.flatMap((item) =>
        isRecord(item)
          ? [
              {
                name: stringValue(item.name),
                value: stringValue(item.value),
                enabled: true,
              },
            ]
          : [],
      )
    : [];
}

/** Chooses a compact HAR request title without embedding sensitive query data. */
function harRequestName(
  method: string,
  targetUrl: string,
  entry: Record<string, unknown>,
): string {
  const comment = stringValue(entry.comment).trim();
  if (comment !== "") return comment.slice(0, 200);
  try {
    return `${method} ${new URL(targetUrl).pathname}`.slice(0, 200);
  } catch {
    return `${method} ${targetUrl}`.slice(0, 200);
  }
}

/** Reports whether a request header commonly carries reusable credentials. */
function isSensitiveHeader(normalizedName: string): boolean {
  return (
    normalizedName === "authorization" ||
    normalizedName === "proxy-authorization" ||
    normalizedName === "cookie" ||
    /(^|[-_])(api[-_]?key|token|secret)([-_]|$)/i.test(normalizedName)
  );
}

/** Reports HTTP/2 and HTTP/3 pseudo-headers that applications cannot set. */
function isHttpPseudoHeader(name: string): boolean {
  return name.startsWith(":");
}

/** Allocates a collision-free request-scoped variable for one sensitive header. */
function nextSecretVariableName(
  headerName: string,
  variables: readonly VariableWrite[],
): string {
  const base = `imported_${headerName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  let candidate = base;
  let suffix = 2;
  const names = new Set(variables.map((variable) => variable.name));
  while (names.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Calculates decoded bytes for bounded base64 without retaining another copy. */
function decodedBase64Bytes(value: string): number {
  try {
    return Buffer.from(value, "base64").byteLength;
  } catch {
    return 0;
  }
}
