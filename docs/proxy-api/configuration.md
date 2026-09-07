# Proxy Configuration

The proxy reads one complete strict-YAML configuration document. The canonical
container path is `/etc/apinteract/proxy.yaml`; `--config <path>` selects another
file. Configuration is validated before the listener starts, and unknown
properties are rejected.

```yaml
configVersion: 1

server:
  host: 127.0.0.1
  port: 8081

cache:
  path: /cache
  retentionMs: 900000

limits:
  maxMetadataBytes: 1048576
  maxRequestHeaderCount: 1024
  maxRequestBodyBytes: 786432
  maxResponseBodyBytes: 1073741824
  maxCacheBytesPerPrincipal: 2147483648
  maxConcurrentExecutionsPerPrincipal: 16

targetPolicy:
  privateNetworkAccess: deny
  allowCidrs: []
  denyCidrs: []

transportObservations:
  enabled: true

principals:
  - id: backend_primary
    bearerToken: "replace-with-a-high-entropy-token"
```

Except for `principals`, the sections and fields above have the shown defaults.
At least one principal is required. Principal identifiers and bearer tokens must
each be unique.

## Key Reference

### Root, listener, and cache

| Key                 | Accepted value              | Default     | Meaning                                                                  |
| ------------------- | --------------------------- | ----------- | ------------------------------------------------------------------------ |
| `configVersion`     | Integer `1`                 | Required    | Selects the configuration contract.                                      |
| `server.host`       | Non-empty string            | `127.0.0.1` | Listener address.                                                        |
| `server.port`       | Integer from 1 to 65535     | `8081`      | Listener TCP port.                                                       |
| `cache.path`        | Non-empty path              | `/cache`    | Directory for retained response-frame files.                             |
| `cache.retentionMs` | Integer from 1 to 604800000 | `900000`    | Terminal execution retention in milliseconds; the maximum is seven days. |

Cache state is disposable. It cannot restore executions after a proxy restart
because ownership, idempotency, sequence, and quota state are held in memory.

### Enforced limits

| Key                                          | Minimum |    Default |     Maximum | Meaning                                                      |
| -------------------------------------------- | ------: | ---------: | ----------: | ------------------------------------------------------------ |
| `limits.maxMetadataBytes`                    |       1 |    1048576 |    16777216 | Execution-creation JSON metadata bytes.                      |
| `limits.maxRequestHeaderCount`               |       1 |       1024 |        1024 | Target request header fields.                                |
| `limits.maxRequestBodyBytes`                 |       0 |     786432 |  4294967296 | Uploaded request body bytes; zero permits only empty bodies. |
| `limits.maxResponseBodyBytes`                |       1 | 1073741824 |  4294967296 | Stored target response bytes per execution.                  |
| `limits.maxCacheBytesPerPrincipal`           |    4096 | 2147483648 | 68719476736 | Aggregate retained frame bytes owned by one principal.       |
| `limits.maxConcurrentExecutionsPerPrincipal` |       1 |         16 |        1024 | Active and retained executions owned by one principal.       |

Every value is an integer number of bytes or entries as indicated. The proxy
rejects values outside these finite ranges before listening. Execution-specific
timeouts and the response ceiling remain bounded by both this configuration and
the values reported by `/capabilities`.

### Outbound target policy

| Key                                 | Accepted value              | Default | Meaning                                                                                |
| ----------------------------------- | --------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `targetPolicy.privateNetworkAccess` | `allow` or `deny`           | `deny`  | Default decision for private IPv4, carrier-grade NAT, and IPv6 unique-local addresses. |
| `targetPolicy.allowCidrs`           | Unique IPv4/IPv6 CIDR array | `[]`    | Explicit allow rules evaluated before the private-network default.                     |
| `targetPolicy.denyCidrs`            | Unique IPv4/IPv6 CIDR array | `[]`    | Explicit deny rules with precedence over allow rules.                                  |

CIDRs require an address and valid family prefix, such as `10.20.0.0/16` or
`fd00::/8`. Hard-denied non-target ranges remain blocked regardless of these
settings; see [Outbound Target Policy](#outbound-target-policy).

### Transport observations

| Key                             | Accepted value | Default | Meaning                                                                          |
| ------------------------------- | -------------- | ------- | -------------------------------------------------------------------------------- |
| `transportObservations.enabled` | Boolean        | `true`  | Collects bounded socket, phase-timing, TLS, trust, and certificate observations. |

Disabling detailed observations does not remove first-byte or total execution
timings.

### Principals

| Key                        | Accepted value          | Default  | Meaning                                                                   |
| -------------------------- | ----------------------- | -------- | ------------------------------------------------------------------------- |
| `principals`               | Non-empty array         | Required | Authorized backend identities. Supplying an array replaces it completely. |
| `principals[].id`          | Unique non-empty string | Required | Stable ownership and quota identity.                                      |
| `principals[].bearerToken` | Unique non-empty string | Required | Plaintext bearer credential accepted for that principal.                  |

Unknown properties are rejected at the root and within every host-owned
section. YAML values are not overridden by process environment variables.

## All-In-One Configuration

The all-in-one image optionally reads administrator input from
`/etc/apinteract/proxy.yaml`, merges it over packaged defaults, and writes the
effective private file to `/run/apinteract/proxy.yaml`. The proxy process reads
that runtime file. The AIO initializer always owns the loopback listener and
generated local principal; administrator input cannot expose the proxy or
replace that identity.

Administrators can set `cache`, `limits`, `targetPolicy`, and
`transportObservations`. The AIO initializer overrides `server` and
`principals`, regardless of values in the administrator file. The generated
AIO credential and effective component files remain under `/run/apinteract`
with owner-only permissions. Cache frames remain under `/cache` and are
disposable.

## Transport Observation Collection

Detailed execution transport observations are enabled by default. They include
socket endpoints, connection reuse, DNS and connection phase timings, TLS
negotiation and verification results, and a bounded peer certificate chain.
Disable them when deployment policy requires less network metadata:

```yaml
transportObservations:
  enabled: false
```

The disabled mode suppresses endpoint, TLS, certificate, DNS, connection, and
TLS-handshake details. First-byte and total execution timings are still
reported. The capability response and each terminal execution result state
whether detailed collection was enabled.

## Outbound Target Policy

The proxy applies destination policy to the final URL after all backend and
script changes. It resolves every A and AAAA answer, validates every candidate,
and pins an approved address into the actual connection. The original hostname
is retained for the HTTP `Host` field and TLS certificate verification. This
prevents a second unvalidated DNS lookup from bypassing the decision.

Policy precedence is:

1. hard-denied address classes;
2. administrator `denyCidrs`;
3. administrator `allowCidrs`;
4. `privateNetworkAccess`; and
5. ordinary publicly routable destinations.

Loopback, link-local, unspecified, multicast, and other non-unicast special-use
destinations are always denied. They cannot be enabled by `allowCidrs` or LAN
mode. Link-local denial includes common cloud metadata destinations.

Private IPv4 networks, carrier-grade NAT space, and IPv6 unique-local addresses
are denied by default. Enable LAN access while retaining selected exclusions:

```yaml
targetPolicy:
  privateNetworkAccess: allow
  allowCidrs: []
  denyCidrs:
    - 192.168.20.0/24
```

Alternatively, leave private access denied and allow only selected subnets:

```yaml
targetPolicy:
  privateNetworkAccess: deny
  allowCidrs:
    - 10.20.0.0/16
  denyCidrs:
    - 10.20.5.0/24
```

If DNS returns both allowed and denied candidates, the complete target is
denied. Redirects remain manual and are returned as target responses; the proxy
does not automatically follow them.

## Resource Limits

`/capabilities` reports the effective values used by the authenticated
principal. The same values enforce:

- JSON execution metadata and target header count;
- request upload bytes before the parser buffers beyond the limit;
- each execution's response body and the administrator response ceiling;
- total retained execution count per principal;
- aggregate response-frame cache bytes per principal; and
- terminal response-cache retention and cleanup.

The proxy also enforces the connection, response-header, response-idle, and
total execution timeouts supplied in a validated execution descriptor. Total
timeout starts at execution creation, so it includes time awaiting request-body
upload. Terminal expiry releases the frame file, idempotency mapping, execution
slot, and cache accounting. Cache files left by a stopped process are removed
when the proxy initializes because their in-memory execution state cannot be
resumed after restart.

Configured values must remain within finite implementation ceilings. The proxy
will not start with a negative, non-integer, or excessively large limit.

## Bearer Authentication

A principal identifies an authorized backend instance, not an APInteract
application user. Execution ownership and quotas use the stable configured
principal ID. Request data cannot supply or override an owner, and another
principal receives the same not-found result as a missing execution.

The current configuration stores one plaintext `bearerToken` value for each
principal. Authentication compares the supplied token with configured values
using a constant-time operation after checking byte length. The proxy does not
currently store token hashes or support several rotating tokens for one
principal. Operators must therefore:

- generate a high-entropy token;
- restrict configuration-file ownership and permissions;
- keep tokens out of logs, diagnostics, and source control; and
- replace the configured token and backend credential together when rotating
  it.

The AIO image generates its local credential automatically and protects the
runtime files with mode `0600`.

## TLS Between Backend And Proxy

The proxy does not currently terminate inbound TLS itself. Loopback-local AIO
traffic uses cleartext HTTP inside one container. A separately deployed proxy
must be placed behind an external reverse proxy, ingress, or load balancer that
terminates TLS; the backend must use the resulting HTTPS endpoint. Never send a
bearer credential across an untrusted cleartext network.

Outbound target TLS is separate. HTTPS executions use the execution's strict or
insecure target-verification mode as documented by the proxy API.
