# Architecture Overview

APInteract separates product state and orchestration from outbound API
execution. The same component contracts apply whether the system is deployed
as one all-in-one image or as separately operated services.

## Components

### Backend

The backend is the authoritative control plane and the primary APInteract
component. It owns:

- users, authentication, and authorization;
- workspaces, collections, environments, and request versions;
- variables, secret handling, and header inheritance;
- request composition and execution orchestration;
- pre-request and post-response script execution;
- persistent data and request history; and
- communication with frontends and proxy nodes.

The backend is organized into separate modules for transport handlers, domain
rules, persistence adapters, script runtimes, and proxy clients. This
separation keeps deployment and implementation choices outside product
behavior.

SQLite is the default database. The portable persistence boundary is designed
to accommodate PostgreSQL and MySQL through the same domain contracts.

Authentication providers are backend extensions that prove provider-scoped
identities. User linkage, authorization, and session management remain core
backend services, so every login method produces the same APInteract session
behavior. The public
[authentication provider plugin contract](../plugins/authentication-providers.md)
describes this extension boundary.

### Frontend

The frontend is a Vue 3 and TypeScript web application. It presents APInteract
state and workflows to users and communicates with the backend through
WebSocket.

The frontend does not execute target requests directly and does not own
authorization, secret resolution, inheritance, scripting, or persistence
rules.

Frontend and backend extension packages share one discovery format but always
target a single runtime. Built-in packages are discovered from the installation
plugin directory; user packages are discovered from the data plugin directory.
The core components depend on typed provider contracts rather than importing
format-specific implementations. The public [plugin guide](../plugins/README.md)
documents packaging, discovery, registration, and trust boundaries.

### Proxy

The proxy is the outbound request execution and data-plane component. It
receives a fully materialized request from an authorized backend principal,
performs a semantically valid HTTP request, and returns target response metadata
and bytes.

The proxy does not understand APInteract users, workspaces, collections,
environments, variables, or scripts. Its authenticated principal identifies an
authorized backend instance, not an application user.

The proxy has no permanent product storage. It may use bounded transient
storage to apply backpressure, cache request or response data during transfer,
and support sequence-based response resume. Transient data is released after
backend acknowledgement or expiry.

The MVP proxy executes HTTP/1.1. Its implementation language is not part of the
public contract and may differ from the Node.js backend.

## Request Execution

An API request follows this flow:

1. The frontend asks the backend to execute a request.
2. The backend authenticates and authorizes the application user.
3. The backend loads the selected request version and applies inherited
   headers.
4. The backend prepares the variable context, runs the pre-request script, and
   resolves the resulting variable and secret templates.
5. The backend selects a proxy and creates an idempotent execution using the
   final URL, headers, behavior, and body metadata.
6. The backend streams request bytes to the proxy when a body is present.
7. The proxy performs the target HTTP request and streams response metadata and
   bytes back to the backend.
8. The backend runs the post-response script, persists appropriate history, and
   sends response events to the frontend.
9. The backend releases the terminal proxy execution after persisting or
   discarding its result.

Workspace scripts run in a backend-managed, isolated script runner rather than
in the frontend, proxy, or main backend JavaScript context. The
[scripting guide](../scripting/README.md) explains the two execution phases,
available request and response helpers, secret boundaries, and limits. The
backend validates and materializes every script-produced request before
contacting the proxy.

Target HTTP statuses, including `4xx` and `5xx`, are valid target responses.
Proxy, network, and malformed HTTP response failures are separate execution
errors.

Common headers resolve from the workspace profile through root-to-leaf
collection profiles toward the request's direct parent. Header names match
case-insensitively: when a nearer enabled layer declares a name, its complete
ordered group replaces the farther group with that name. Request-local headers
are the nearest layer. Disabled fields do not participate in execution or
suppress inherited values. The backend stores this resolved header set in the
immutable revision and execution snapshot before contacting the proxy.

Workspaces may also own environments containing ordered variables. Environment
selection is persisted per application session and workspace, so separate
browser sessions belonging to the same user may safely target different
environments. A new session begins with no environment selected, and deleting
an environment clears all session selections that reference it.

Persisted variable profiles belong to workspaces, collections, environments,
and saved requests. A selected environment overrides workspace defaults,
collection profiles then inherit root-to-leaf, and request profiles are the
highest persisted scope. Profiles are independently revisioned so
request-scoped secret values do not enter mutable drafts or immutable request
revisions.

Variables may be ordinary values, write-only secrets, aliases, or explicitly
unset values. A variable's kind is immutable after creation; changing kind
requires removing it and creating a new variable, so a stored secret can never
be recast as a readable value. Names are case-sensitive; aliases resolve after
scope merging and preserve secret sensitivity. The backend interpolates
`<<variable-name>>` placeholders in target URLs, query values, header values,
and text bodies immediately before execution. Persisted execution evidence
identifies every contributing profile revision and referenced secret version
without copying secret plaintext into the snapshot.

The request editor recognizes the same placeholder grammar before execution and
requests redacted resolution previews from the backend. Ordinary variables may
show their current resolved value; secret and secret-derived variables expose
only kind, source scope, presence, and version metadata. Preview results are
advisory and execution always performs authoritative resolution again.

Normal APIs never return workspace secret values. The built-in MVP persistence
representation may store those values without at-rest encryption, isolated
behind a versioned backend storage boundary so a later encrypted or external
secret store does not change product or API behavior. Operators must protect
the backend data volume accordingly.

## Control And Data Planes

Backend-to-proxy communication has two logical planes:

- The control plane uses authenticated HTTP operations for health,
  capabilities, execution creation, status, cancellation, and release.
- The data plane streams unmodified request-body bytes to the proxy and returns
  framed response metadata and body bytes to the backend.

Separating the planes allows request upload and target response streaming to
overlap over independent HTTP/1.1 connections. It also allows bounded caching
and response resume without encoding arbitrary payloads as Base64.

The canonical proxy component contract is
[`docs/proxy-api/openapi.json`](../proxy-api/openapi.json).

## Deployment

### All-In-One

The all-in-one image prioritizes easy deployment. It may contain several
processes and runtimes:

- compiled frontend assets;
- the backend process;
- a local proxy process; and
- a minimal process supervisor.

The backend uses the same public proxy contract over a local connection. The
all-in-one topology does not introduce a private execution path with different
behavior.

The source-built AIO image supervises the backend and loopback proxy as
separate processes. The compiled frontend is static content served by the
backend. Initialization generates one container-local proxy credential under
`/run/apinteract`; the credential is shared only through private effective
component configuration and is not persisted with product data.

Durable backend state is mounted at `/data`, while `/cache` contains disposable
proxy transfer state. This separation keeps backup and restoration focused on
authoritative backend data without treating recoverable proxy frames as product
records. The application processes run as an unprivileged account, and the
provided Compose deployment makes the remaining container filesystem
read-only.

Backend persistent data and proxy transient cache data use separate writable
locations.

### Standalone Proxy

The proxy is also packaged independently for deployments where outbound
requests originate from another network or security boundary. Remote
communication uses TLS.

A standalone proxy may serve several backend instances. Configuration maps
bearer tokens to isolated backend principals, and every execution, idempotency
key, limit, stream, and cached object is scoped to its creating principal.

## Public Contracts

Each independently deployed component owns its public API specification. The
[component API index](../api/README.md) lists the available canonical OpenAPI
documents.
