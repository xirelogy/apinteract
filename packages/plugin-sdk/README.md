# `@apinteract/plugin-sdk`

Optional authoring helpers for APInteract plugins.

```sh
pnpm add --save-dev @apinteract/plugin-api @apinteract/plugin-sdk
```

Helpers are grouped by target and purpose:

```ts
import { parseJsonObject } from "@apinteract/plugin-sdk/backend/import";
import { localize } from "@apinteract/plugin-sdk/frontend/localization";
```

The SDK is independently versioned from the plugin contract. Plugin builds
must bundle SDK runtime helpers into their own `dist/` output; an installed
plugin must not require this package at runtime.

See the [plugin development guide](https://github.com/xirelogy/apinteract/blob/main/docs/plugins/README.md)
for packaging and compatibility details.

## License

MIT
