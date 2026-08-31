# APInteract Plugins

APInteract plugins are independently compiled packages discovered at startup.
Each package targets exactly one runtime—frontend or backend—and registers one
or more implementations through typed providers from `@apinteract/plugin-api`.

Frontend plugins and backend plugins execute in different environments and
cannot contribute across that boundary. They use the same package format.

## Package Format

Every discovery-root child is one self-contained package:

```text
example-plugin/
  package.json
  apinteract-plugin.json
  dist/
    index.mjs
    optional-support-files.js
```

`package.json` must have a non-empty package name, use `"type": "module"`,
and repeat the same version as the plugin manifest. Dependencies needed at
runtime must be bundled into `dist/` or emitted there as package-relative
assets; a plugin package cannot import application source files, sibling
plugins, or unresolved workspace packages. `@apinteract/plugin-sdk` provides
optional authoring helpers that plugin builds bundle into their own artifacts.

`apinteract-plugin.json` is the canonical package metadata:

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "example.yaml-content",
  "name": "YAML content",
  "version": "1.0.0",
  "weight": 10,
  "target": "frontend",
  "entrypoint": "dist/index.mjs",
  "providers": ["request.content", "response.content"]
}
```

`schemaVersion` is the whole-number manifest format generation. `apiVersion`
is the whole-number host/plugin compatibility generation and changes only when
that contract breaks. It is deliberately not SemVer: the independently
released `@apinteract/plugin-api` and `@apinteract/plugin-sdk` packages use
SemVer for compatible and incompatible package releases.

IDs use lowercase alphanumeric segments separated by dots or hyphens. Versions
use semantic `major.minor.patch` form. Entrypoints must remain below `dist/` and
cannot escape the package through traversal or symbolic links. Symbolic links
anywhere in `dist/` are rejected. Each distribution asset is limited to 8 MiB,
and the complete distribution is limited to 32 MiB. `weight` is an optional
safe integer from -10000 to 10000; higher weights are presented first, with
discovery order as the stable tie-breaker.

An entrypoint exports registration, not another copy of its manifest:

```ts
import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type { FrontendPluginProviders } from "@apinteract/plugin-api/frontend";

export function register(
  context: PluginRegistrationContext<FrontendPluginProviders>,
): void {
  // Register typed frontend contributions here.
}
```

A package can register multiple implementations, including several
implementations for the same provider. Every used provider must be declared in
the manifest, and every declared provider must receive a contribution.
Registration is atomic: conflict or validation failure excludes the whole
package rather than leaving some contributions installed.

## Discovery And Trust

The backend scans two roots with the same validator:

| Default root              | Source shown in Options |
| ------------------------- | ----------------------- |
| `/opt/apinteract/plugins` | Built-in                |
| `/data/plugins`           | User                    |

The directory is the only built-in/user distinction. Duplicate package IDs
across roots are rejected. Invalid optional packages are logged and excluded.
After loading, hosts validate required provider capabilities without depending
on specific package IDs.

Backend entrypoints are trusted code in the backend process. Frontend
entrypoints are trusted browser code. Frontend packages are listed through a
same-origin catalog and loaded from SHA-256 content-addressed immutable URLs
before the Vue application mounts. The hash covers every path and byte below
`dist/`, and the backend serves relative JavaScript, CSS, JSON, WASM, and image
assets below the same immutable package URL. Provider result types constrain
coupling; they are not a security sandbox.

Successfully loaded packages are considered enabled. The read-only
**Options → Plugins** view lists their name, version, target, and source.

## Implemented Providers

| Target   | Provider ID        | Contribution role                          |
| -------- | ------------------ | ------------------------------------------ |
| Frontend | `request.content`  | Request recognition and executable editing |
| Frontend | `response.content` | Response recognition, parsing, and display |
| Backend  | `request.import`   | Request and collection import plans        |

The built-in packages use the same public contracts as user packages:

- Basic HTTP content, JSON content, XML content, HTML response preview, and
  raster image preview are frontend packages.
- OpenAPI import and HAR import are backend packages.

Core application modules know provider contracts, canonical HTTP wire bodies,
and host-owned mechanisms, not content implementations such as JSON parsing or
HAR document structure.

Import providers may attach bounded Markdown `documentation` to each request
body option. The host appends only the selected option's documentation to the
request notes when applying or opening the import; providers therefore keep
media-type and schema details out of the request's common notes.

### Request Content

`request.content` owns recognition, initialization, editing, validation, and
formatting for one content option. The core retains only the canonical HTTP
wire body needed to save and execute the request. A contribution mounts an
executable, framework-neutral editor into an `HTMLElement` and publishes wire
body changes through its context:

```ts
import { localize } from "@apinteract/plugin-sdk/frontend/localization";

context.register("request.content", {
  id: "yaml",
  label: {
    default: "YAML",
    translations: { "zh-CN": "YAML", "zh-TW": "YAML" },
  },
  mediaTypes: ["application/yaml", "*+yaml"],
  order: 25,
  createBody(previous) {
    return {
      kind: "text",
      contentType: "application/yaml",
      text: previous.kind === "text" ? previous.text : "",
    };
  },
  isDefaultFor() {
    return false;
  },
  effectiveContentType(body) {
    return body.kind === "text" ? body.contentType : null;
  },
  mountEditor(container, initial) {
    const optionsFor = (current: typeof initial) => ({
      body: current.body,
      wireKind: "text" as const,
      label: localize(
        "YAML request body",
        { "zh-CN": "YAML 请求体", "zh-TW": "YAML 請求本文" },
        current.locale,
      ),
      disabled: current.disabled,
      variablePreviews: current.variablePreviews,
      codeLanguage: "plain" as const,
      contentTypePlaceholder: "application/yaml",
      format(source: string) {
        try {
          return { valid: true as const, value: formatYaml(source) };
        } catch {
          return {
            valid: false as const,
            error: localize(
              "The request body is not valid YAML.",
              {
                "zh-CN": "请求体不是有效的 YAML。",
                "zh-TW": "請求本文不是有效的 YAML。",
              },
              current.locale,
            ),
          };
        }
      },
      onChange: current.updateBody,
    });
    const editor = initial.ui.mountWireBodyEditor(
      container,
      optionsFor(initial),
    );
    return {
      update(current) {
        editor.update(optionsFor(current));
      },
      destroy() {
        editor.destroy();
      },
    };
  },
});
```

`kind` in this example is the canonical HTTP wire representation, not a
content implementation selected by core. A plugin may instead own its DOM or
use `mountCodeEditor` directly. Plugins do not import Vue components or
application source. The host currently supplies generic CodeMirror, canonical
wire-body, sandboxed-document, and bounded-image mechanisms.

Contribution IDs are local to their package. The host qualifies them as
`<plugin-id>/<contribution-id>` before exposing them to UI state, so two
packages may both register an implementation named `json` without an identity
collision. Labels and other content-specific messages belong to the package.
Contexts include the active locale, and labels may provide package-owned
translations with a stable `default` fallback.

The mount returns an `update()`/`destroy()` handle. The host can update the
canonical body, disabled state, variable previews, attachment service, or
response evidence without recreating the contribution. A plugin must release
listeners, object URLs, and other resources from `destroy()`.

Request options are presented by descending package `weight`, then ascending
contribution `order`, with registration order as the stable final tie-breaker.
Formatting invoked through the wire-body mechanism runs only when the user
activates **Format body**; invalid input remains unchanged.

Media-type patterns support exact values (`application/json`), structured
suffixes (`*+json`), type wildcards (`text/*`), and the universal wildcard
(`*/*`). Selection prefers exact, suffix, type, then universal matches. Numeric
`priority` resolves deliberate matches at the same specificity; an unresolved
tie is rejected. Parameters and case are normalized, so
`Application/Problem+JSON; charset=utf-8` matches `*+json`. The host uses the
declared Content-Type and does not sniff body bytes.

Editor language identifiers are open strings. A plugin may request a language
that a newer host supports without changing the plugin API; a host that does
not recognize the identifier renders plain text. Plugins that need their own
parser or editor may render their own DOM instead of using the shared editor.

### Response Content

`response.content` receives bounded response evidence after media-type
selection. The contribution decides availability, whether its view should be
selected by default, how to parse the content, and what to mount:

```ts
import { localize } from "@apinteract/plugin-sdk/frontend/localization";

context.register("response.content", {
  id: "yaml",
  label: {
    default: "YAML",
    translations: { "zh-CN": "YAML", "zh-TW": "YAML" },
  },
  mediaTypes: ["application/yaml", "*+yaml"],
  isAvailable: ({ execution }) => execution.bodyPreview !== undefined,
  isDefault: ({ execution, previewComplete }) =>
    previewComplete &&
    execution.bodyPreview !== undefined &&
    isValidYaml(execution.bodyPreview),
  mountView(container, initial) {
    const optionsFor = (current: typeof initial) => ({
      document: formatYaml(current.execution.bodyPreview ?? ""),
      label: localize(
        "Structured YAML response body",
        { "zh-CN": "结构化 YAML 响应体", "zh-TW": "結構化 YAML 回應本文" },
        current.locale,
      ),
      readOnly: true,
    });
    const viewer = initial.ui.mountCodeEditor(container, optionsFor(initial));
    return {
      update(current) {
        viewer.update(optionsFor(current));
      },
      destroy() {
        viewer.destroy();
      },
    };
  },
});
```

JSON, XML, YAML, CSV, GraphQL, PDF, or another content implementation therefore
belongs in its plugin package. Adding one does not require a core enum, Vue
branch, or parser switch. A package may register several contributions,
including several for one provider. Local contribution IDs must be unique
inside that package; overlapping media patterns require explicit priorities so
selection is deterministic.

Frontend plugins are trusted executable browser code, but request and response
content is untrusted input. A plugin must not insert response markup into the
application document. HTML display uses the host's network-inert sandbox.
Raster images remain subject to host-owned byte, dimension, and pixel limits.
The raster plugin owns supported media types and header parsing, then supplies
an `inspect(mediaType, boundedHeaderBytes)` callback to the generic image
mechanism. The host verifies the plugin-reported dimensions against the browser
decoder before display. SVG is parsed as XML and is not rendered as an image.
The host owns response byte retention, download, bounded previews, and lazy
blob retrieval.

### Request And Collection Imports

`request.import` is backend-only. A provider probes one bounded text source and
parses it into a canonical, mutation-free import plan. The backend owns source
limits, selection, plan validation, authorization, attachment policy, and the
atomic persistence transaction.

A request may expose bounded, labeled request-body alternatives together with
one deterministic default. An option may include a provider-defined
`selectionKey`; when the same keys are available across requests, the preview
offers one import-wide choice and applies the corresponding option to each
request. Otherwise it falls back to per-request choices. The generic import
preview presents those labels and returns selected option IDs when applying the
plan; neither host knows the source format's media-type or schema rules.
Providers may also return
multiple labeled response captures for one request. The host validates and
persists every capture as imported history rather than an APInteract
execution.

Recorded responses returned by a provider do not contain provenance. The host
stamps the selected provider ID after parsing, so one plugin cannot claim that
another provider produced a capture.

JSON import helpers shared by the built-in HAR and OpenAPI packages live in
`@apinteract/plugin-sdk/backend/import`. Their library builds include those
helpers in each plugin artifact, leaving no runtime dependency on the workspace
SDK package. Format-specific mapping remains in the individual plugin.

## Lifecycle Rules

Registration occurs during startup and must not start background work, mutate
persistent state, or open network connections. Package discovery and
registration complete before services or views consume contributions.

Authentication providers, blob stores, delivery providers, persistence
adapters, script runtimes, secret stores, logging sinks, and proxy selectors
remain future extension points. They can reuse the same single-target package
format while defining their own typed provider contracts.
