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

Operators should configure a high-entropy bearer token, protect the proxy
configuration with restrictive filesystem permissions, and keep the matching
backend credential out of logs and source control. AIO generates and protects
this credential automatically. When standalone proxy packaging becomes
available, its operators should follow the complete
[bearer authentication configuration](configuration.md#bearer-authentication).

The proxy derives execution ownership only from that principal; request data
does not contain an ownership field. Requests authenticated as another
principal receive the same response as requests for a missing execution. This
prevents execution identifiers from revealing resources across principals. See
[proxy authentication configuration](configuration.md#bearer-authentication).

Bearer credentials do not provide transport confidentiality. The proxy does not
currently terminate inbound TLS. Once supported, remote deployments must use an
external TLS terminator and configure the backend with its HTTPS endpoint; AIO
traffic stays on container loopback.

## Outbound Target Policy

Before opening a socket, the proxy resolves the final HTTP or HTTPS hostname,
checks every returned address against hard safety rules and administrator CIDR
policy, and pins one approved address into the connection. The original
hostname remains authoritative for `Host` and TLS verification. A mixed DNS
answer containing any denied address is rejected.

Loopback and link-local destinations, including common cloud metadata
addresses, are always denied. Private-network access is denied by default but
can be enabled for LAN deployments; explicit deny CIDRs retain precedence. See
[proxy configuration](configuration.md#outbound-target-policy) for exact rules.

## TLS And Transport Observations

Each execution selects strict or insecure target TLS verification when that
mode is reported by `/capabilities`. Strict mode verifies the target
certificate and hostname. Insecure mode keeps the connection encrypted but
allows an untrusted, expired, hostname-mismatched, or self-signed target
certificate.

The contract can represent local and remote socket endpoints, connection reuse,
negotiated TLS details, verification outcome, and the peer certificate chain.
The current Node transport reports these capability flags as false and omits
the observations. `/capabilities` is authoritative for what a running proxy can
provide.

Successful connections carry available observations in the response-head
frame, before response body frames. DNS, connection, and TLS failures carry
observations collected before failure in the terminal error frame. Certificate
entries preserve DER bytes in Base64 because they are bounded metadata rather
than request or response payloads. The backend can parse those bytes for
display without replacing the observed certificate representation.

## Response Recovery

The proxy caches response frames until the terminal execution is released or
its configured retention deadline expires. Expiry removes the execution,
idempotency mapping, quota accounting, and frame file. If a backend receives
frames through sequence `173` and disconnects before then, it resumes without
repeating those bytes:

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
