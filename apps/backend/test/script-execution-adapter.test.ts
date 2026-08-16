import { describe, expect, it } from "vitest";

import { VariableResolver } from "../src/environments/variable-resolver.js";
import {
  executionRequestFromScript,
  postResponseScriptView,
  preRequestScriptView,
} from "../src/executions/script-execution-adapter.js";
import { createEntityId } from "../src/foundation/id.js";
import type { ExecutionRequestSnapshot } from "../src/requests/request-service.js";

describe("request form script adaptation", () => {
  it("preserves an unchanged structured form and taints secret templates", () => {
    const request: ExecutionRequestSnapshot = {
      workspaceId: createEntityId(),
      method: "POST",
      targetMode: "absolute",
      targetUrl: "https://example.test/forms",
      query: [],
      headers: [
        {
          name: "Content-Type",
          value: "application/x-www-form-urlencoded",
          enabled: true,
        },
      ],
      requestBody: {
        kind: "urlencoded",
        contentType: null,
        fields: [{ name: "account", value: "<<credential>>", enabled: true }],
      },
      body: "account=%3C%3Ccredential%3E%3E",
      bodyPresent: true,
      preRequestScript: "",
      postResponseScript: "",
    };
    const resolver = new VariableResolver([
      {
        variableId: createEntityId(),
        name: "credential",
        kind: "secret",
        value: "plaintext-secret",
        aliasTarget: null,
        secretVersion: 1,
      },
    ]);

    const scriptView = preRequestScriptView(request, resolver);
    expect(scriptView.body).toMatchObject({
      kind: "text",
      text: request.body,
      sensitive: true,
    });
    expect(executionRequestFromScript(request, scriptView)).toMatchObject({
      body: request.body,
      bodyPresent: true,
      requestBody: request.requestBody,
    });
  });

  it("converts a script-replaced structured form body to raw text", () => {
    const request: ExecutionRequestSnapshot = {
      workspaceId: createEntityId(),
      method: "POST",
      targetMode: "absolute",
      targetUrl: "https://example.test/forms",
      query: [],
      headers: [
        {
          name: "Content-Type",
          value: "multipart/form-data; boundary=OriginalBoundary",
          enabled: true,
        },
      ],
      requestBody: {
        kind: "multipart",
        contentType: null,
        boundary: "OriginalBoundary",
        fields: [{ name: "before", value: "value", enabled: true }],
      },
      body: '--OriginalBoundary\r\nContent-Disposition: form-data; name="before"\r\n\r\nvalue\r\n--OriginalBoundary--\r\n',
      bodyPresent: true,
      preRequestScript: "",
      postResponseScript: "",
    };
    const scriptView = preRequestScriptView(
      request,
      new VariableResolver(null),
    );

    const replaced = executionRequestFromScript(request, {
      ...scriptView,
      body: {
        kind: "text",
        text: "script replacement",
        readable: true,
        sensitive: false,
      },
    });

    expect(replaced).toMatchObject({
      body: "script replacement",
      bodyPresent: true,
      requestBody: {
        kind: "text",
        contentType: "multipart/form-data; boundary=OriginalBoundary",
        text: "script replacement",
      },
    });
  });

  it("preserves binary file bytes while hiding secret-derived multipart names", () => {
    const attachment = {
      attachmentId: createEntityId(),
      workspaceId: createEntityId(),
      fileName: "payload.bin",
      contentType: "application/octet-stream",
      byteLength: 4,
      sha256: "a".repeat(64),
    };
    const template: ExecutionRequestSnapshot = {
      workspaceId: attachment.workspaceId,
      method: "POST",
      targetMode: "absolute",
      targetUrl: "https://example.test/forms",
      query: [],
      headers: [],
      requestBody: {
        kind: "multipart",
        contentType: null,
        boundary: "FileBoundary",
        fields: [
          {
            kind: "file",
            name: "file-<<credential>>",
            enabled: true,
            attachment,
          },
        ],
      },
      body: "",
      bodyPresent: true,
      preRequestScript: "",
      postResponseScript: "",
    };
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const materialized: ExecutionRequestSnapshot = {
      ...template,
      requestBody: {
        kind: "multipart",
        contentType: null,
        boundary: "FileBoundary",
        fields: [
          {
            kind: "file",
            name: "file-plaintext-secret",
            enabled: true,
            attachment,
          },
        ],
      },
      bodyBytes: bytes,
    };
    const resolver = new VariableResolver([
      {
        variableId: createEntityId(),
        name: "credential",
        kind: "secret",
        value: "plaintext-secret",
        aliasTarget: null,
        secretVersion: 1,
      },
    ]);

    const preRequest = preRequestScriptView(materialized, resolver, template);
    expect(preRequest.body).toMatchObject({
      kind: "binary",
      bytes,
      sensitive: true,
    });
    expect(
      executionRequestFromScript(materialized, preRequest).bodyBytes,
    ).toEqual(bytes);
    expect(
      postResponseScriptView(template, materialized, resolver).body,
    ).toEqual({ kind: "binary", readable: false, sensitive: true });
  });
});
