# APInteract Plugins

APInteract plugins extend explicitly registered frontend or backend providers.
The shared TypeScript contract is published by `@apinteract/plugin-api`; each
provider retains its own data, lifecycle, and security boundary.

The registration API and the first content/import providers are implemented.
Automatic package discovery, administrator configuration, integrity checks,
and external runtime loading remain planned. Installed source plugins are
currently selected by the application composition root.

## One Package, One Target

One plugin package targets exactly one runtime:

```ts
type PluginTarget = "frontend" | "backend";
```

A frontend plugin cannot register backend providers, and a backend plugin
cannot register frontend providers. Both use the same package signature:

```ts
interface APInteractPlugin<TTarget, TProviders> {
  manifest: {
    apiVersion: 1;
    id: string;
    name: string;
    version: string;
    target: TTarget;
  };
  register(context: PluginRegistrationContext<TProviders>): void;
}
```

The package root convention is to export one `plugin` value. A package can
register several contributions, but all contributions must belong to its one
target runtime.

```ts
import type { FrontendPlugin } from "@apinteract/plugin-api/frontend";

export const plugin: FrontendPlugin = {
  manifest: {
    apiVersion: 1,
    id: "example.yaml",
    name: "YAML content support",
    version: "1.0.0",
    target: "frontend",
  },
  register(context) {
    // Typed frontend contributions belong here.
  },
};

export default plugin;
```

Plugin IDs use lowercase alphanumeric segments separated by dots or hyphens.
Versions use semantic `major.minor.patch` form. The target host validates the
manifest and rejects duplicate package IDs before completing startup.

## Implemented Providers

| Target   | Provider ID        | Contribution role                           |
| -------- | ------------------ | ------------------------------------------- |
| Frontend | `request.content`  | Request body recognition, editor, formatter |
| Frontend | `response.content` | Response classification and safe projection |
| Backend  | `request.import`   | Request and collection import plans         |

Built-in JSON/XML/HTML/image/text support and built-in OpenAPI/HAR importers
register through these same contracts.

### Request Content

`request.content` maps media types to an existing wire-level request body kind
and a host-owned editor primitive. A text contribution may also provide an
explicit formatter:

```ts
context.register("request.content", {
  id: "yaml",
  label: { default: "YAML" },
  bodyKind: "text",
  defaultContentType: "application/yaml",
  mediaTypes: ["application/yaml", "*+yaml"],
  textLanguage: "plain",
  format(source) {
    try {
      return { valid: true, value: formatYaml(source) };
    } catch {
      return { valid: false, error: "The request body is not valid YAML." };
    }
  },
});
```

Formatting runs only after the user activates **Format body**. Invalid input is
left unchanged and the returned error is rendered as text. A formatter never
changes the canonical request body kind or sends bytes by itself.

The current host editor languages are `plain` and `json`. Adding YAML syntax
highlighting requires a new host-supported language primitive; plugins cannot
inject arbitrary Vue components or markup through this provider.

Media-type patterns support exact values (`application/json`), structured
suffixes (`*+json`), type wildcards (`text/*`), and the universal wildcard
(`*/*`). Exact, suffix, type, and universal matches are considered in that
order; an explicit numeric priority resolves deliberate overrides.

### Response Content

`response.content` receives bounded response evidence after deterministic
media-type selection. It returns only host-recognized presentation kinds and
optional structured JSON/XML text. It does not return HTML components.

HTML preview remains network-inert and sandboxed by the host. Raster images
remain subject to host-owned byte and dimension limits. SVG is parsed as XML
and is not rendered as an image.

The current API is suitable for built-in or trusted source plugins. Future
externally loaded frontend plugins need an explicit trust and integrity model;
registration itself is not a JavaScript sandbox.

### Request And Collection Imports

`request.import` is backend-only. A provider receives one bounded text source,
probes it without mutation, and parses it into a canonical import plan:

```text
source
  -> provider probe
  -> requests, collection hierarchy, variables, diagnostics
  -> host validation
  -> user preview and selection
  -> atomic persistence
```

The backend owns source size limits, provider selection, plan validation,
authorization, attachment policy, and the persistence transaction. Provider
IDs are stable validated strings rather than a closed built-in enum, so an
installed provider can be selected through the existing component API.

Imported captured responses currently retain HAR-specific persistence rules.
The general extension boundary in this iteration covers requests and
collections; generalizing capture provenance is a separate contract change.

## Registration Lifecycle

The implemented lifecycle is intentionally small:

```text
manifest validation
registration against typed providers
provider-specific conflict validation
service/UI consumption
```

Registration happens during component bootstrap. Plugins must not start
network connections, background work, or persistent mutation from their
registration function. Discovery, configuration, initialization, health, and
shutdown hooks will be added when external package loading is implemented.

Frontend and backend plugins are trusted code in their respective processes.
Provider contracts constrain coupling and output shape; they do not sandbox a
plugin.

## Planned Provider Contracts

Authentication providers, blob stores, delivery providers, persistence
adapters, script runtimes, secret stores, logging sinks, and proxy selectors
remain planned extension points. They should reuse the same single-target
package signature while defining their own typed provider contracts.

[Authentication provider plugins](authentication-providers.md) describe the
planned authentication boundary. [Translation packs](translations.md) remain
data-only frontend extensions rather than executable plugins.
