# Build request targets from collection paths

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

The request editor shows the effective target below the target controls. An
absolute URL must be established by the workspace or a collection before a
composed request can be sent.

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
inside a component are preserved. Components after the first non-empty one and
the request path cannot contain a query string, fragment, network authority,
or a separate URL scheme. Add query parameters through the request's **Query**
tab.

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
