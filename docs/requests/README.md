# Compose and execute HTTP requests

## Build request targets from collection paths

APInteract can store a request as either a complete URL or as a path composed
from its workspace and collection hierarchy. Composed targets make it easier
to move a group of requests between servers or change a shared API prefix in
one place.

## Configure a composed target

The first non-empty component in the workspace and collection chain establishes
the absolute HTTP or HTTPS URL. You can normally set it as the **Base URL** in
**Workspace properties**:

```text
https://api.example.com
```

You can also leave the workspace and any number of outer collections blank,
then establish the absolute URL in the first collection that has a value. Open
**Collection properties** and set its **Target prefix** to an absolute URL.
This is useful when different collection branches address different services.

Every non-empty component after the absolute URL contributes a path. Nested
collection prefixes are applied from the outermost collection to the innermost
collection.

For example, these settings:

| Level              | Value                     |
| ------------------ | ------------------------- |
| Workspace base URL | `https://api.example.com` |
| `Public API`       | `/v1`                     |
| `Users`            | `/users`                  |
| Request path       | `/{id}`                   |

produce this effective target:

```text
https://api.example.com/v1/users/{id}
```

The request editor shows the effective target below the target controls. If
the workspace and every ancestor collection are blank, the request itself may
provide the absolute HTTP(S) URL as the first non-empty component. Once an
inherited component exists, the request value must be a relative path
template; it cannot replace that inherited target.

For example, the workspace and `Public API` collection may be blank while a
nested `Service A` collection starts its branch:

| Level              | Value                      |
| ------------------ | -------------------------- |
| Workspace base URL |                            |
| `Public API`       |                            |
| `Service A`        | `https://a.example.com/v1` |
| `Users`            | `/users`                   |
| Request path       | `/{id}`                    |

This produces `https://a.example.com/v1/users/{id}`. A sibling collection can
establish a different service URL in the same way.

APInteract removes extra slashes only where two components meet. Slashes
inside a component are preserved. After an absolute component has been
established, every later component (including a request path under an
inherited prefix) cannot contain a query string, fragment, network authority,
or a separate URL scheme. A request that is itself the first non-empty
component follows the absolute-URL rules above. Add query parameters through
the request's **Query** tab.

## Choose composed or absolute mode

Use **Composed** when a request belongs to the API represented by its workspace
and collections. Newly created request drafts use this mode.

Use **Absolute** when the request must ignore the hierarchy and address a
complete URL directly, for example a health endpoint on another service:

```text
https://status.example.com/health
```

Existing requests created before composed targets were introduced remain in
absolute mode. Switching modes does not silently rewrite the text in the
target field; enter a suitable path or URL for the selected mode.

## Use variables in target components

The workspace base URL, every collection prefix, and the request path can use
APInteract variable references. Each component is resolved separately and the
resolved components are then joined. This prevents a substituted path value
from unexpectedly changing where component boundaries occur.

```text
Workspace:  https://<<api_host>>
Collection: /<<api_version>>
Request:    /users/<<user_id>>
```

The same variable precedence and secret-handling rules used by request
headers and bodies apply to target components. The final resolved value must
be a valid HTTP or HTTPS URL before APInteract sends it.

## Scripts and versions

A pre-request script reads the fully composed target through
`asdk.request.url.get()`. If the script calls `asdk.request.setUrl(value)`, its
replacement becomes the complete working URL for that execution; collection
prefixes are not applied again.

When APInteract creates an immutable request version, it records the workspace
base URL and collection path components effective at that time. Renaming,
moving, or changing a collection later affects the current request but does
not change the target structure stored by an earlier version. Variables in
that stored structure are still resolved from the environment and variable
profiles selected when the version is executed.

## Configure HTTP redirects

APInteract follows redirects by default, with a limit of 10 transitions. You
can change both values at three levels:

1. **Options > Defaults > HTTP redirections** sets your per-user default.
2. **Workspace properties > Execution** optionally overrides either value for
   every request in the workspace.
3. A request's **Settings** tab optionally overrides either value for that
   versioned request.

The follow toggle and maximum count inherit independently in request,
workspace, user, then packaged-default order. The effective values are saved
with every execution, so later preference changes do not reinterpret history.
Values from 0 through 50 are accepted; 50 is a fixed safety ceiling.

APInteract follows only `301`, `302`, `303`, `307`, and `308`. Redirected
methods and bodies use these rules:

| Status    | Original method | Redirected method and body                |
| --------- | --------------- | ----------------------------------------- |
| 301 / 302 | GET or HEAD     | Preserve method; preserve body            |
| 301 / 302 | POST            | Change to GET; remove body                |
| 301 / 302 | Other           | Preserve method and body                  |
| 303       | HEAD            | Preserve HEAD; preserve body              |
| 303       | Other           | Change to GET; remove body                |
| 307 / 308 | Any             | Preserve method and replay the exact body |

Every destination is sent as a new single-hop proxy execution and passes the
normal DNS, SSRF, CIDR, TLS, timeout, and response-size checks again. HTTPS to
HTTP downgrades and destination URLs containing credentials are always
blocked. Missing `Location` fields leave an ordinary 3xx response; malformed,
ambiguous, or unsupported destinations retain the source response with a
structured redirect failure.

Same-origin redirects retain normal end-to-end headers. Cross-origin redirects
remove authorization, proxy authorization, explicit cookies,
authentication-generated fields, and every secret-derived header. Framing and
hop-by-hop headers are regenerated for every destination, and a method rewrite
that removes the body also removes its representation headers. The source
response records removed header names without recording their values.

## Use HTTP cookies

Cookie-based workflows use workspace-owned jars selected by the active
environment, with inherited per-request enablement and explicit concurrency
control. See [Use shared HTTP cookie jars](cookies.md) for ownership, matching,
security, redirect, and management behavior.
