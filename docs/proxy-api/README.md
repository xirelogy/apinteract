# Proxy Component API

[`openapi.json`](openapi.json) is the single source of truth for the APInteract
proxy component's public API. Proxy implementations, backend clients, contract
tests, generated clients, and published references use it as their
authoritative contract.

The current `0.1.1` contract defines the backend-to-proxy HTTP execution
protocol. It separates small control-plane operations from streaming request
and response data:

- health and authenticated capability discovery describe deployment readiness
  and effective limits;
- an execution is created from a final URL, ordered headers, and body metadata;
- a principal-scoped idempotency key prevents duplicate execution creation;
- arbitrary request bytes are uploaded without Base64 encoding;
- target response metadata and body bytes use a compact framed stream; and
- cancellation, response resume, release, and execution state remain available
  through the control plane.

Except for `/health`, every operation requires a bearer token. Proxy
configuration maps each recognized token to a backend principal. A principal
represents an authorized backend instance and is distinct from an APInteract
application user.

The proxy derives execution ownership only from that principal; request data
does not contain an ownership field. Requests authenticated as another
principal receive the same response as requests for a missing execution. This
prevents execution identifiers from revealing resources across principals. See
[proxy authentication configuration](configuration.md).

Bearer credentials do not provide transport confidentiality. Remote proxy
communication uses TLS.

## TLS And Transport Observations

Each execution selects strict or insecure target TLS verification when that
mode is reported by `/capabilities`. Strict mode verifies the target
certificate and hostname. Insecure mode keeps the connection encrypted but
allows an untrusted, expired, hostname-mismatched, or self-signed target
certificate.

The proxy can report the actual local and remote socket endpoints, connection
reuse, negotiated TLS details, verification outcome, and the peer certificate
chain. `/capabilities` identifies which observations are available to the
authenticated principal.

Successful connections carry available observations in the response-head
frame, before response body frames. DNS, connection, and TLS failures carry
observations collected before failure in the terminal error frame. Certificate
entries preserve DER bytes in Base64 because they are bounded metadata rather
than request or response payloads. The backend can parse those bytes for
display without replacing the observed certificate representation.

## Response Recovery

The proxy caches response frames until the terminal execution is released or
expires. If a backend receives frames through sequence `173` and disconnects,
it resumes without repeating those bytes:

```http
GET /executions/{executionId}/response?afterSequence=173
Authorization: Bearer <token>
```

The proxy continues from sequence `174`. Omitting `afterSequence` starts or
replays the stream from sequence zero. An execution has at most one active
response reader.

After persisting or discarding a terminal result, the backend releases the
execution with `DELETE /executions/{executionId}`. This removes cached frames
and the associated idempotency-key mapping. Request-body upload resume is not
part of framing version 1.

Valid target HTTP statuses, including `4xx` and `5xx`, are normal responses.
Proxy, network, and malformed HTTP response failures use distinct error
categories and stable snake_case codes.

Proxy API version changes follow explicit maintainer approval.
