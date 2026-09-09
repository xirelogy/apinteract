# Use shared HTTP cookie jars

APInteract can retain cookies set by an API and apply them to later requests.
Cookie handling is enabled by default. The backend owns this state and sends
the proxy an ordinary prepared `Cookie` header; proxy nodes do not store or
select cookies.

## Choose the active jar

Every workspace has a default cookie jar. Each environment independently
chooses whether selecting it uses its own workspace-owned jar or the workspace
default while retaining that environment's variables. New and existing
environments default to their own jar. Configure the choice under
**Environment Properties > Cookies**.

Cookie contents never inherit or merge between jars. Switching an environment
to the workspace default does not delete its independent jar; switching it
back restores access to the same contents. Collections do not create
additional jars.

Jars are shared workspace state, not browser- or user-local state. Authorized
workspace editors therefore see the same values and runtime updates. Both
persistent and session cookies survive backend restarts and user sign-outs.

Automatic cookie behavior has one switch controlling both directions: sending
matching stored cookies and accepting response `Set-Cookie` fields. It resolves
in this order:

1. the request's **Settings** override;
2. **Workspace Properties > Cookies**;
3. **Options > Defaults > HTTP cookies**; and
4. the packaged enabled default.

A manually enabled `Cookie` request header replaces automatic injection for
that request. The enabled jar still accepts response changes.

## Inspect and clear cookies

Open the **Cookies** tab in Workspace Properties to configure automatic cookie
behavior and manage the workspace-default jar. A saved Environment Properties
surface has its own **Cookies** tab containing the jar-source choice and the
selected workspace or environment jar. Unsaved environments do not have a jar
until they are saved.

The **Cookie jar content** list displays name, domain and path, a dedicated
local-time expiry, and compact icons for the remaining properties. Expiry is
not repeated as an icon. Activating another property icon presents its
technical name and a concise explanation. Long values remain truncated in the
row and have a dedicated copy action. The expiry follows the date/time format
selected in Account Options. Jar revisions and locations remain implicit in
the owning Cookies tab and are not repeated.
The environment jar-source explanation is available from its information
control. The cookie list fills the remaining tab space and scrolls independently
so its clear actions remain in a stable footer.

Values are visible because jar read and runtime-write access are granted
together to workspace editors. Values are never included in audit records,
logs, or ordinary workspace exports.

APInteract deliberately does not offer manual cookie creation or value editing:
hand-authored values can silently lose metadata supplied by a server. You can
delete one cookie, clear only session cookies, or clear the complete active
jar. Both bulk clearing operations require explicit confirmation. A cookie
with neither `Expires` nor `Max-Age` is a session cookie even though APInteract
persists it until it is explicitly removed.

## Matching and security behavior

APInteract applies RFC 6265 matching and current browser-compatible rules for
domain, host-only, path, lifetime, `Max-Age`, `Expires`, `Secure`, and
`HttpOnly`. It retains and displays `SameSite`, but does not enforce it because
an API client has no browser top-level-site or navigation context. Invalid
fields and public-suffix domain cookies are ignored independently, while valid
`Set-Cookie` fields retain wire order.

The complete Public Suffix List, including its private, wildcard, exception,
and internationalized rules, is shipped with the backend and updated with
reviewed application releases. IP targets accept only host-only cookies.
Localhost and loopback addresses receive the usual development exception for
host-only `Secure` cookies; insecure remote responses cannot overwrite or
delete an overlapping Secure cookie.

Every redirect response updates the jar before the next destination request is
prepared. Cookies are selected again for each destination URL, so a
cross-origin redirect receives only cookies independently eligible for that
host and path. Cookies from completed redirect hops remain stored even if a
later hop fails or automatic redirection is disabled.

## Control concurrent requests

Each user's **Options > Defaults > HTTP cookies** section selects how that
user's requests enter a shared jar:

- **Optimistic** is the default and admits the request alongside other
  optimistic requests. It reads atomic cookie snapshots and applies each
  response atomically; concurrently completed responses are merged in commit
  order.
- **Serialized** requests exclusive admission for the complete request and
  redirect chain. Queue time counts toward the request's overall execution
  timeout.

Different jars can always run concurrently. Admission uses a fair shared and
exclusive queue: a queued serialized request waits for earlier work, then
blocks later optimistic requests until it finishes. This preserves a user's
serialized guarantee even though the jar and its other users remain shared.
