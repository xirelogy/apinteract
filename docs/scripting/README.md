# Write request scripts

> **Status:** Request scripts are available from the request editor and run in
> the backend sandbox when you send a saved or temporary request.

Request scripts help you prepare a request and check the response that comes
back. A script is written in JavaScript and uses the `asdk` object to
work with the current execution.

There are two script phases:

- A **pre-request script** runs after APInteract has prepared the request and
  before it sends anything to the target. Use it to add headers, build a body,
  or set execution-local values.
- A **post-response script** runs after a target response has been received.
  Use it to check the status and body, record test results, or set
  execution-local values for the rest of the execution.

Scripts are evaluated by the backend in a restricted environment. The browser
editor never has access to your script's authoritative execution context, and
the outbound proxy only receives the final request. This gives the same result
when you use APInteract from different frontends.

## Add scripts to a request

Open a saved or temporary request and select **Pre-request script** or
**Post-response script** in the request tabs. Each phase has its own editor. A
blank editor disables that phase. The editor highlights JavaScript syntax and
provides line numbers, indentation, bracket matching, and undo and redo without
running the code in the browser.

Select **Save** to persist scripts with a saved request, or select **Send** to
save and run the current request. Temporary requests can run scripts without
being saved first.

After an execution finishes, open **Scripts** in the response panel. Structured
logs, named test results, and any sanitized script error appear as one stream
of cards in the order they were produced. Each card identifies its script
phase and its log level, test status, or error code. A failed pre-request script
prevents the outbound request. A failed post-response script is shown beside
the response that was already received.

The card type, phase, level, status, known SDK failure codes, and default
assertion messages follow the interface language. Log messages, test names,
and messages written or thrown by your JavaScript remain exactly as authored
so their diagnostic meaning is preserved.

## A request's script lifecycle

When you run a request, APInteract follows this sequence:

1. It loads the selected request and inherited headers.
2. It prepares the variable context and runs the pre-request script.
3. It resolves variable references, including secret references, and checks the
   resulting URL, headers, and body.
4. It sends that checked request through the configured proxy.
5. It runs the post-response script against the target response.
6. It shows the response, script logs, and test results together.

A pre-request error stops the request before it is sent. A post-response error
does not remove a response that was already received; APInteract reports the
script error beside that response.

Target `4xx` and `5xx` responses are still normal responses and can be checked
by a post-response script. Proxy, network, cancellation, and malformed HTTP
failures do not produce a normal response for the post-response phase.

## The `asdk` object

The only APInteract-specific global available to a script is `asdk`. It
provides these helpers:

| Helper      | Available in  | What it is for                                            |
| ----------- | ------------- | --------------------------------------------------------- |
| `phase`     | Both          | Identifies `"pre-request"` or `"post-response"`.          |
| `execution` | Both          | Safe `id` and `startedAt` values for this execution.      |
| `request`   | Both          | Read the request; mutate it only in pre-request scripts.  |
| `response`  | Post-response | Read response status, headers, and a bounded body.        |
| `variables` | Both          | Read ordinary variables and create safe references.       |
| `local`     | Both          | Share small, temporary values between the two phases.     |
| `log`       | Both          | Add bounded, structured messages to the execution result. |
| `test`      | Post-response | Record a named response test.                             |
| `assert`    | Post-response | Fail a test when a condition is not met.                  |
| `time`      | Both          | Read the fixed time for this execution.                   |
| `encoding`  | Both          | Convert text, bytes, Base64, and hexadecimal values.      |
| `limits`    | Both          | See the effective size and time limits.                   |

The available object is a copy of the current execution data. It is not a
handle to APInteract's database, services, or network connections.

## Prepare a request

Use `request` to change the working request in a pre-request script.

```js
const customerId = asdk.variables.require("customerId");

asdk.request.setMethod("POST");
asdk.request.headers.set("X-Customer-Id", customerId);
asdk.request.body.setText(
  JSON.stringify({
    customerId,
    sentAt: asdk.time.now(),
  }),
);
```

### Read and change the URL

Read the current URL with `asdk.request.url.get()` and replace it with
`asdk.request.setUrl(value)`. APInteract checks a changed URL again before
sending the request. The proxy resolves every final hostname, applies its
loopback, link-local, private-network, and administrator CIDR policy, and pins
an approved address into the connection. Redirects remain manual.

Changing the target origin is a separate permission. A script cannot use a
request mutation to bypass an administrator's network policy.

### Work with headers

Header names are matched without regard to case. `set` replaces all values for
that name, `append` adds another value, and `remove` removes the name.

```js
asdk.request.headers.set("Accept", "application/json");
asdk.request.headers.append("X-Trace-Id", asdk.execution.id);

const contentTypes = asdk.request.headers.getAll("Content-Type");
if (contentTypes.length === 0) {
  asdk.request.headers.set("Content-Type", "application/json");
}
```

APInteract derives framing headers such as `Host` and `Content-Length` when it
sends the request. Scripts cannot use the SDK to provide or override those
transport details. Hop-by-hop headers are rejected or removed according to the
normal request policy.

### Work with a body

`request.body` reports whether the body is absent, text, or binary. Use
`text()` for a readable text body and `bytes()` for a binary body. Both methods
return copies. `setText`, `setBytes`, and `clear` replace the working body.

```js
if (asdk.request.body.kind === "text") {
  const payload = JSON.parse(asdk.request.body.text());
  payload.client = "apinteract";
  asdk.request.body.setText(JSON.stringify(payload));
}
```

Reading a body that is too large for the script's limit, or reading a body
marked as secret-derived, raises a script error. APInteract does not silently
truncate a value returned by `text()` or `bytes()`.

## Use variables safely

`asdk.variables.get(name)` reads an ordinary resolved variable.
`require(name)` does the same but reports a clear error when the variable is
missing, unset, or cannot be resolved. Use `has` and `describe` when you need
to inspect availability or kind without reading a value.

```js
if (asdk.variables.has("region")) {
  asdk.request.headers.set("X-Region", asdk.variables.require("region"));
}
```

### Secret variables

Secret and secret-derived values are never returned as JavaScript strings by
the initial SDK. Calling `get` or `require` for one raises
`sensitive_value_unavailable`.

To use a secret in a request, insert an unresolved reference instead:

```js
const token = asdk.variables.reference("accessToken");
asdk.request.headers.set("Authorization", `Bearer ${token}`);
```

The backend replaces that reference after the pre-request script completes.
The script can therefore choose where the secret is used without learning the
secret itself. This is intentional: a script that could both read a secret and
change the outbound request could send that secret to an arbitrary target.

Secret-aware signing and other operations that need to use a secret without
revealing it may be added later as separate, explicitly permissioned helpers.

## Share temporary values

`asdk.local` is an execution-only key/value store. It is useful when a
pre-request script calculates a value that the post-response script needs.
Values are strings, bounded in size, and discarded when the execution ends.
They do not change workspace, environment, collection, or request variables.

```js
// Pre-request script
asdk.local.set("startedAt", asdk.time.now());
```

```js
// Post-response script
const startedAt = asdk.local.get("startedAt");
if (startedAt !== undefined) {
  asdk.log.info("Request completed", { startedAt });
}
```

Do not put credentials or secret-derived text in the local store. The initial
SDK has no secret local-variable type.

## Check a response

The post-response `response` object contains the status and headers, plus the
body when it fits the configured script-body limit.

```js
asdk.test("returns JSON", () => {
  asdk.assert.ok(
    asdk.response.headers.get("Content-Type")?.includes("json"),
    "The response is not JSON",
  );
});

asdk.test("contains an ID", () => {
  asdk.assert.ok(asdk.response.body.available);
  const payload = JSON.parse(asdk.response.body.text());
  asdk.assert.ok(typeof payload.id === "string");
});
```

Tests are reported as passed, failed, or errored. A failed test does not turn a
valid target response into a network failure. If the body is unavailable,
check `response.body.available` before calling `text()` or `bytes()`.

The authoritative response is read-only. A post-response script can create
tests, logs, and local values, but cannot rewrite response bytes or headers.

## Log useful diagnostics

Use the structured logger instead of `console`:

```js
asdk.log.debug("Request script completed", {
  phase: asdk.phase,
});
```

Log messages, fields, and test details are size-limited. APInteract redacts
known sensitive values before showing or storing results, but redaction cannot
reliably identify a secret after arbitrary transformations. Never deliberately
log credentials, tokens, or request bodies containing secrets.

## Limits and unavailable features

Every script has limits for source size, input and output size, body size, log
entries, local values, memory, and execution time. The effective values are
available through `asdk.limits`; a script cannot increase them.

The scripting environment does not provide:

- `fetch`, `XMLHttpRequest`, WebSockets, or any other network client;
- filesystem, subprocess, operating-system, environment-variable, or database
  access;
- `require`, module imports, package installation, or dynamic code loading;
- timers or an ambient system clock; or
- access to backend services, proxy credentials, sessions, or host objects.

The request sent by APInteract is the only outbound network operation. Because
a pre-request script can change that request, the final materialized URL is
still subject to the proxy's full target and SSRF policy after every script.

## Script errors

When a script cannot finish, APInteract reports a category such as:

```text
syntax_error
runtime_error
sdk_invalid_argument
sdk_permission_denied
sensitive_value_unavailable
response_body_unavailable
cpu_limit_exceeded
memory_limit_exceeded
time_limit_exceeded
output_limit_exceeded
cancelled
```

Diagnostics may include the script line and column, but never host paths,
credentials, stack traces from the backend, or secret values.

## Keeping scripts working

Scripts are saved with their language, SDK version, phase, permissions, and a
source revision. APInteract keeps those details with the execution so a later
upgrade does not silently change the behavior of an earlier request version.

For portable scripts:

1. Use documented `asdk` helpers instead of undocumented globals.
2. Check `response.body.available` before reading a response body.
3. Keep logs and local values small and non-sensitive.
4. Treat a missing or unset variable as an expected case where appropriate.
5. Do not depend on a script changing response bytes after the request ends.

The SDK may gain new helpers in compatible releases. Removing a helper or
changing its result requires a new SDK major version and a migration note.
