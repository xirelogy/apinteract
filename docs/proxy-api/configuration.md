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

principals:
  - id: backend_primary
    bearerToken: "replace-with-a-high-entropy-token"
```

Except for `principals`, the sections and fields above have the shown defaults.
At least one principal is required. Principal identifiers and bearer tokens must
each be unique.

## All-In-One Configuration

The all-in-one image optionally reads administrator input from
`/etc/apinteract/proxy.yaml`, merges it over packaged defaults, and writes the
effective private file to `/run/apinteract/proxy.yaml`. The proxy process reads
that runtime file. The AIO initializer always owns the loopback listener and
generated local principal; administrator input cannot expose the proxy or
replace that identity.

Administrators can set `cache`, `limits`, and `targetPolicy`. The generated AIO
credential and effective component files remain under `/run/apinteract` with
owner-only permissions. Cache frames remain under `/cache` and are disposable.

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
