/**
 * This file is generated from docs/proxy-api/openapi.json.
 * Do not edit it directly; the OpenAPI document is the canonical source.
 */
export const proxyRuntimeContract = {
  schemas: {
    Health: {
      type: "object",
      additionalProperties: false,
      required: ["status", "apiVersion", "componentVersion"],
      properties: {
        status: {
          type: "string",
          enum: ["ready", "not_ready"],
        },
        apiVersion: {
          type: "string",
          const: "0.1.1",
        },
        componentVersion: {
          type: "string",
          minLength: 1,
          description: "Version of the running proxy implementation.",
        },
      },
    },
    Capabilities: {
      type: "object",
      additionalProperties: false,
      required: [
        "apiVersion",
        "responseFrameVersions",
        "outboundHttpVersions",
        "features",
        "limits",
      ],
      properties: {
        apiVersion: {
          type: "string",
          const: "0.1.1",
        },
        responseFrameVersions: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            type: "integer",
            enum: [1],
          },
        },
        outboundHttpVersions: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["HTTP/1.1"],
          },
        },
        features: {
          $ref: "#/components/schemas/CapabilityFeatures",
        },
        limits: {
          $ref: "#/components/schemas/CapabilityLimits",
        },
      },
    },
    CapabilityFeatures: {
      type: "object",
      additionalProperties: false,
      required: [
        "responseResume",
        "requestUploadResume",
        "redirectModes",
        "tlsVerificationModes",
        "transportMetadata",
        "automaticContentDecompression",
        "cookieJar",
      ],
      properties: {
        responseResume: {
          type: "boolean",
          const: true,
        },
        requestUploadResume: {
          type: "boolean",
          const: false,
        },
        redirectModes: {
          type: "array",
          minItems: 1,
          maxItems: 1,
          prefixItems: [
            {
              const: "manual",
            },
          ],
          items: false,
        },
        tlsVerificationModes: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["strict", "insecure"],
          },
        },
        transportMetadata: {
          $ref: "#/components/schemas/TransportMetadataCapabilities",
        },
        automaticContentDecompression: {
          type: "boolean",
          const: false,
        },
        cookieJar: {
          type: "boolean",
          const: false,
        },
      },
    },
    TransportMetadataCapabilities: {
      type: "object",
      additionalProperties: false,
      required: [
        "remoteEndpoint",
        "localEndpoint",
        "connectionReuse",
        "tlsSummary",
        "peerCertificateChain",
      ],
      properties: {
        remoteEndpoint: {
          type: "boolean",
        },
        localEndpoint: {
          type: "boolean",
        },
        connectionReuse: {
          type: "boolean",
        },
        tlsSummary: {
          type: "boolean",
        },
        peerCertificateChain: {
          type: "boolean",
        },
      },
      description:
        "Transport observations available to the authenticated principal. A true value indicates implementation and policy support; an observation may still be absent when a particular connection fails before the value is known.",
    },
    CapabilityLimits: {
      type: "object",
      additionalProperties: false,
      required: [
        "maxMetadataBytes",
        "maxRequestHeaderCount",
        "maxRequestBodyBytes",
        "maxResponseBodyBytes",
        "maxCacheBytesPerPrincipal",
        "maxConcurrentExecutionsPerPrincipal",
        "responseCacheRetentionMs",
        "maxFramePayloadBytes",
      ],
      properties: {
        maxMetadataBytes: {
          type: "integer",
          minimum: 1,
        },
        maxRequestHeaderCount: {
          type: "integer",
          minimum: 1,
          maximum: 1024,
        },
        maxRequestBodyBytes: {
          type: "integer",
          minimum: 0,
        },
        maxResponseBodyBytes: {
          type: "integer",
          minimum: 1,
        },
        maxCacheBytesPerPrincipal: {
          type: "integer",
          minimum: 1,
        },
        maxConcurrentExecutionsPerPrincipal: {
          type: "integer",
          minimum: 1,
        },
        responseCacheRetentionMs: {
          type: "integer",
          minimum: 1,
        },
        maxFramePayloadBytes: {
          type: "integer",
          const: 1048576,
        },
      },
    },
    ExecutionId: {
      type: "string",
      minLength: 16,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
      description:
        "Opaque execution identifier. Clients must not infer ownership or other semantics from its value.",
    },
    CreateExecutionRequest: {
      type: "object",
      additionalProperties: false,
      required: ["request"],
      properties: {
        request: {
          $ref: "#/components/schemas/TargetRequest",
        },
      },
    },
    TargetRequest: {
      type: "object",
      additionalProperties: false,
      required: ["method", "url", "headers", "body", "behavior"],
      properties: {
        method: {
          type: "string",
          minLength: 1,
          maxLength: 32,
          pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$",
          description: "Final HTTP method token to send to the target.",
        },
        url: {
          type: "string",
          format: "uri",
          pattern: "^https?://",
          description:
            "Final semantic absolute HTTP or HTTPS URL, including the already-materialized path and query string. The proxy must not independently add, remove, or reorder query parameters. The Host header and TLS server name are derived from this URL. URI fragments and user information are not permitted.",
          not: {
            anyOf: [
              {
                pattern: "#",
              },
              {
                pattern: "^https?://[^/]*@",
              },
            ],
          },
        },
        headers: {
          type: "array",
          maxItems: 1024,
          description:
            "Ordered final target header fields. Duplicate names are permitted. Header names are compared case-insensitively against the forbidden list.",
          "x-apinteract-forbidden-header-names": [
            "Host",
            "Content-Length",
            "Transfer-Encoding",
            "Connection",
            "Keep-Alive",
            "Proxy-Connection",
            "Upgrade",
            "TE",
            "Trailer",
            "Expect",
            "Proxy-Authorization",
          ],
          items: {
            $ref: "#/components/schemas/HeaderField",
          },
        },
        body: {
          $ref: "#/components/schemas/RequestBodyDescriptor",
        },
        behavior: {
          $ref: "#/components/schemas/ExecutionBehavior",
        },
      },
    },
    HeaderField: {
      type: "object",
      additionalProperties: false,
      required: ["name", "value"],
      properties: {
        name: {
          type: "string",
          minLength: 1,
          pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$",
        },
        value: {
          type: "string",
          pattern: "^[^\\u0000-\\u0008\\u000A-\\u001F\\u007F]*$",
          description:
            "Unmodified semantic header value. Control characters prohibited by HTTP/1.1 are not permitted.",
        },
      },
    },
    RequestBodyDescriptor: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "length", "sha256"],
      properties: {
        mode: {
          type: "string",
          enum: ["none", "stream"],
        },
        length: {
          type: ["integer", "null"],
          minimum: 0,
          description:
            "Exact raw body length when known, otherwise null. Must be zero when mode is none. The proxy derives Content-Length from a known value and otherwise selects HTTP/1.1 streaming transfer framing.",
        },
        sha256: {
          type: ["string", "null"],
          pattern: "^[0-9a-f]{64}$",
          description:
            "Lowercase SHA-256 digest of the complete raw body when known, otherwise null. Must be null when mode is none. Because the proxy streams to the target, a mismatch can be detected only after some or all bytes have reached the target.",
        },
      },
      allOf: [
        {
          if: {
            properties: {
              mode: {
                const: "none",
              },
            },
            required: ["mode"],
          },
          then: {
            properties: {
              length: {
                const: 0,
              },
              sha256: {
                type: "null",
              },
            },
          },
        },
      ],
    },
    ExecutionBehavior: {
      type: "object",
      additionalProperties: false,
      required: [
        "connectTimeoutMs",
        "responseHeaderTimeoutMs",
        "responseIdleTimeoutMs",
        "totalTimeoutMs",
        "redirectMode",
        "tlsVerification",
        "maxResponseBodyBytes",
      ],
      properties: {
        connectTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 600000,
          default: 10000,
        },
        responseHeaderTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 600000,
          default: 30000,
        },
        responseIdleTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 600000,
          default: 30000,
          description:
            "Maximum time between bytes received from the target after its response begins.",
        },
        totalTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 86400000,
          default: 300000,
          description:
            "Maximum lifetime from execution creation through target completion. Starting at creation also bounds sessions that never begin request-body upload.",
        },
        redirectMode: {
          type: "string",
          const: "manual",
          default: "manual",
          description:
            "Redirect responses are returned to the backend and are never followed automatically in the MVP.",
        },
        tlsVerification: {
          type: "string",
          enum: ["strict", "insecure"],
          default: "strict",
          description:
            "Strict verifies the target certificate and hostname. Insecure explicitly disables enforcement of both checks for this execution while retaining TLS encryption. The proxy reports the verification outcome in transport metadata when its transport implementation exposes it.",
        },
        maxResponseBodyBytes: {
          type: "integer",
          minimum: 1,
          default: 1073741824,
          description:
            "Maximum target response body accepted for this execution. It must not exceed the effective principal capability.",
        },
      },
      description:
        "Non-header target behavior. Outbound HTTP is HTTP/1.1, cookies are not retained between executions, and content encoding is never automatically decompressed. Transfer coding may be removed by HTTP framing while content-encoded bytes remain unchanged.",
    },
    ExecutionSession: {
      type: "object",
      additionalProperties: false,
      required: [
        "executionId",
        "state",
        "requestBodyState",
        "responseState",
        "createdAt",
        "expiresAt",
        "error",
      ],
      properties: {
        executionId: {
          $ref: "#/components/schemas/ExecutionId",
        },
        state: {
          $ref: "#/components/schemas/ExecutionState",
        },
        requestBodyState: {
          $ref: "#/components/schemas/RequestBodyState",
        },
        responseState: {
          $ref: "#/components/schemas/ResponseState",
        },
        createdAt: {
          type: "string",
          format: "date-time",
        },
        expiresAt: {
          type: ["string", "null"],
          format: "date-time",
          description:
            "Null while the execution is active. After a terminal state, the time at which the proxy may delete transient state, cached frames, and the idempotency-key mapping.",
        },
        error: {
          anyOf: [
            {
              $ref: "#/components/schemas/ExecutionStreamError",
            },
            {
              type: "null",
            },
          ],
          description:
            "Safe terminal failure details. Null unless state is failed.",
        },
      },
      description:
        "Transient execution state. Principal identity is intentionally omitted because ownership is derived from authentication and is not client-controlled.",
      "x-apinteract-state-rules": [
        "A bodyless execution becomes active when it is created.",
        "A streaming-body execution becomes active when request-body upload begins.",
        "Request upload and target response streaming may overlap.",
        "Completed, failed, cancelled, and expired are terminal states.",
        "Only terminal executions may be released.",
        "Cancellation is best effort and cannot retract bytes already sent to the target.",
      ],
    },
    ExecutionState: {
      type: "string",
      enum: [
        "accepted",
        "active",
        "cancelling",
        "completed",
        "failed",
        "cancelled",
        "expired",
      ],
    },
    RequestBodyState: {
      type: "string",
      enum: [
        "not_required",
        "awaiting_upload",
        "streaming",
        "complete",
        "failed",
        "cancelled",
      ],
    },
    ResponseState: {
      type: "string",
      enum: [
        "waiting",
        "streaming",
        "complete",
        "failed",
        "cancelled",
        "expired",
      ],
    },
    ProxyResponseStream: {
      type: "string",
      format: "binary",
      description:
        "Version 1 APInteract framed response stream. Each frame starts with the 16-byte header defined by the media type's x-apinteract-framing contract, followed by exactly payloadLength bytes.",
    },
    ResponseHead: {
      type: "object",
      additionalProperties: false,
      required: ["status", "httpVersion", "headers", "receivedAt"],
      properties: {
        status: {
          type: "integer",
          minimum: 100,
          maximum: 599,
          description: "Final target HTTP response status.",
        },
        reasonPhrase: {
          type: ["string", "null"],
        },
        httpVersion: {
          type: "string",
          enum: ["HTTP/1.1"],
          description: "HTTP transport version negotiated with the target.",
        },
        headers: {
          $ref: "#/components/schemas/HeaderList",
        },
        receivedAt: {
          type: "string",
          format: "date-time",
          description:
            "Time at which the proxy received the final target response headers.",
        },
        transport: {
          $ref: "#/components/schemas/TransportObservation",
        },
      },
      description:
        "Target response metadata. Transport observations are emitted here before response body frames when they are available.",
    },
    ResponseTrailers: {
      type: "object",
      additionalProperties: false,
      required: ["headers"],
      properties: {
        headers: {
          $ref: "#/components/schemas/HeaderList",
        },
      },
    },
    ResponseComplete: {
      type: "object",
      additionalProperties: false,
      required: ["bodyBytes", "bodySha256", "timings", "completedAt"],
      properties: {
        bodyBytes: {
          type: "integer",
          minimum: 0,
        },
        bodySha256: {
          type: ["string", "null"],
          pattern: "^[0-9a-f]{64}$",
          description:
            "Lowercase SHA-256 digest of the complete raw response body when calculated.",
        },
        timings: {
          $ref: "#/components/schemas/ExecutionTimings",
        },
        completedAt: {
          type: "string",
          format: "date-time",
        },
      },
    },
    ExecutionTimings: {
      type: "object",
      additionalProperties: false,
      required: ["totalMs"],
      properties: {
        dnsMs: {
          type: "number",
          minimum: 0,
        },
        connectMs: {
          type: "number",
          minimum: 0,
        },
        tlsMs: {
          type: "number",
          minimum: 0,
        },
        firstByteMs: {
          type: "number",
          minimum: 0,
        },
        totalMs: {
          type: "number",
          minimum: 0,
        },
      },
      description:
        "Target execution timings measured by the proxy. Optional phases are omitted when they do not apply or cannot be measured.",
    },
    TransportObservation: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        localEndpoint: {
          $ref: "#/components/schemas/NetworkEndpoint",
        },
        remoteEndpoint: {
          $ref: "#/components/schemas/NetworkEndpoint",
        },
        connectionReused: {
          type: "boolean",
          description:
            "Whether the target connection existed before this execution.",
        },
        tls: {
          $ref: "#/components/schemas/TlsObservation",
        },
      },
      description:
        "Best available observations about the target transport connection. Fields are omitted when they do not apply, are unavailable from the transport implementation, are suppressed by proxy policy, or were not observed before failure.",
    },
    NetworkEndpoint: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["address", "port", "family"],
          properties: {
            address: {
              type: "string",
              format: "ipv4",
            },
            port: {
              type: "integer",
              minimum: 1,
              maximum: 65535,
            },
            family: {
              type: "string",
              const: "ipv4",
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["address", "port", "family"],
          properties: {
            address: {
              type: "string",
              format: "ipv6",
            },
            port: {
              type: "integer",
              minimum: 1,
              maximum: 65535,
            },
            family: {
              type: "string",
              const: "ipv6",
            },
          },
        },
      ],
      description:
        "Observed socket endpoint. The remote endpoint is the address actually connected after name resolution, not the target hostname.",
    },
    TlsObservation: {
      type: "object",
      additionalProperties: false,
      required: ["verificationMode"],
      properties: {
        verificationMode: {
          type: "string",
          enum: ["strict", "insecure"],
        },
        authorized: {
          type: "boolean",
          description:
            "Whether the observed peer certificate and hostname satisfied normal strict verification, including when insecure mode allowed the connection to continue.",
        },
        authorizationErrorCode: {
          $ref: "#/components/schemas/TlsAuthorizationErrorCode",
        },
        protocol: {
          type: "string",
          enum: ["TLSv1.2", "TLSv1.3"],
        },
        alpnProtocol: {
          type: ["string", "null"],
          enum: ["http/1.1", null],
          description:
            "Negotiated ALPN protocol, or null when the peer did not negotiate ALPN.",
        },
        serverName: {
          type: ["string", "null"],
          maxLength: 253,
          description:
            "TLS Server Name Indication value sent to the target, or null when no server name was sent.",
        },
        cipher: {
          $ref: "#/components/schemas/TlsCipher",
        },
        peerCertificateChain: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            $ref: "#/components/schemas/TlsPeerCertificate",
          },
          description:
            "Peer certificate chain in leaf-first order as exposed by the transport runtime. A self-signed peer normally produces one entry.",
        },
      },
      description:
        "TLS observations collected during connection establishment. On a failed handshake, only values observed before failure are present.",
    },
    TlsAuthorizationErrorCode: {
      type: "string",
      enum: [
        "self_signed_certificate",
        "unknown_certificate_authority",
        "hostname_mismatch",
        "certificate_expired",
        "certificate_not_yet_valid",
        "certificate_revoked",
        "invalid_certificate_chain",
        "unsupported_certificate",
        "other_verification_error",
      ],
      description:
        "Normalized primary reason that normal strict certificate or hostname verification did not authorize the peer.",
    },
    TlsCipher: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          minLength: 1,
          description: "Cipher suite name reported by the transport runtime.",
        },
        standardName: {
          type: ["string", "null"],
          minLength: 1,
          description:
            "IANA cipher suite name when the transport runtime provides it.",
        },
      },
    },
    TlsPeerCertificate: {
      type: "object",
      additionalProperties: false,
      required: ["derBase64", "sha256Fingerprint"],
      properties: {
        derBase64: {
          type: "string",
          contentEncoding: "base64",
          contentMediaType: "application/pkix-cert",
          maxLength: 262144,
          description:
            "Base64 representation of the exact DER certificate bytes exposed by the transport runtime.",
        },
        sha256Fingerprint: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
          description: "Lowercase SHA-256 digest of the DER certificate bytes.",
        },
      },
    },
    ExecutionStreamError: {
      type: "object",
      additionalProperties: false,
      required: ["category", "code", "message", "phase", "retryable"],
      properties: {
        category: {
          type: "string",
          enum: ["proxy", "network", "http_protocol"],
          description:
            "Origin of the execution failure. Valid target HTTP status responses, including 4xx and 5xx, are not errors.",
        },
        code: {
          type: "string",
          pattern: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$",
          description:
            "Stable snake_case machine-readable error code. Clients must tolerate codes added in compatible API revisions.",
        },
        message: {
          type: "string",
          description:
            "Safe human-readable message that does not expose secrets or internal stack traces.",
        },
        phase: {
          type: "string",
          enum: [
            "upload",
            "dns",
            "connect",
            "tls",
            "request",
            "response",
            "cache",
            "internal",
          ],
        },
        retryable: {
          type: "boolean",
        },
        transport: {
          $ref: "#/components/schemas/TransportObservation",
          description:
            "Transport observations available before failure. When a response head was already emitted, the backend retains the observations from that frame and this field may be omitted.",
        },
      },
      description:
        "Terminal execution failure. Valid target HTTP status responses, including 4xx and 5xx, are not failures.",
    },
    HeaderList: {
      type: "array",
      items: {
        $ref: "#/components/schemas/HeaderField",
      },
      description: "Ordered HTTP header fields. Duplicate names are preserved.",
    },
    Problem: {
      type: "object",
      required: ["type", "title", "status", "category", "code"],
      properties: {
        type: {
          type: "string",
          format: "uri-reference",
        },
        title: {
          type: "string",
        },
        status: {
          type: "integer",
          minimum: 400,
          maximum: 599,
        },
        category: {
          type: "string",
          const: "proxy",
        },
        detail: {
          type: "string",
        },
        instance: {
          type: "string",
          format: "uri-reference",
        },
        code: {
          type: "string",
          pattern: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$",
          description: "Stable snake_case machine-readable error code.",
        },
        traceId: {
          type: "string",
          description:
            "Opaque identifier suitable for correlating sanitized proxy logs.",
        },
      },
      description:
        "RFC 9457 problem details with a stable APInteract error code. Extension members are permitted.",
    },
  },
  parameters: {
    IdempotencyKey: {
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description:
        "Opaque caller-generated key scoped to the authenticated principal. Concurrent or repeated creation requests with the same key and identical descriptor resolve to one execution. Reuse with different content returns 409.",
      schema: {
        type: "string",
        minLength: 16,
        maxLength: 128,
        pattern: "^[!-~]+$",
      },
    },
    ExecutionId: {
      name: "executionId",
      in: "path",
      required: true,
      description: "Opaque identifier of a transient proxy execution.",
      schema: {
        $ref: "#/components/schemas/ExecutionId",
      },
    },
    AfterSequence: {
      name: "afterSequence",
      in: "query",
      required: false,
      description:
        "Resume after this previously received frame sequence. When omitted, the stream starts or replays from sequence zero.",
      schema: {
        type: "integer",
        minimum: 0,
        maximum: 4294967295,
      },
    },
  },
} as const;
