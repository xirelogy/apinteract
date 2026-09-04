# `@apinteract/plugin-api`

Stable TypeScript contracts for APInteract plugins.

```sh
pnpm add --save-dev @apinteract/plugin-api
```

Import the registration contract from the package root and target-specific
providers from `@apinteract/plugin-api/frontend` or
`@apinteract/plugin-api/backend`:

```ts
import type { PluginRegistrationContext } from "@apinteract/plugin-api";
import type { FrontendPluginProviders } from "@apinteract/plugin-api/frontend";

export function register(
  context: PluginRegistrationContext<FrontendPluginProviders>,
): void {
  // Register the providers declared by apinteract-plugin.json.
}
```

The package contains declarations and the small runtime constants needed to
author a plugin. It does not depend on the APInteract application source tree.
Plugin packages should bundle every runtime dependency into their `dist/`
output.

See the [plugin development guide](https://github.com/xirelogy/apinteract/blob/main/docs/plugins/README.md)
for the package format, provider contracts, and compatibility rules.

## License

MIT
