# Translation Packs

APInteract ships `en-US`, `en-GB`, `zh-Hans`, and `zh-Hant`. A deployment can
add partial translations without rebuilding the frontend by replacing
`/web-ui/i18n/manifest.json` and serving same-origin JSON pack files.

## Manifest

The manifest declares the locales shown in the language selector:

```json
{
  "schemaVersion": 1,
  "packs": [
    {
      "locale": "fr-CA",
      "name": "Français (Canada)",
      "direction": "ltr",
      "path": "fr-CA.json"
    }
  ]
}
```

Pack paths resolve relative to the manifest. Cross-origin paths are ignored.
An external locale cannot replace an officially bundled locale.

## Pack

Each pack repeats its identity and provides any subset of the English catalog:

```json
{
  "schemaVersion": 1,
  "locale": "fr-CA",
  "name": "Français (Canada)",
  "direction": "ltr",
  "fallback": "en-US",
  "messages": {
    "common": {
      "actions": {
        "cancel": "Annuler"
      }
    },
    "header": {
      "logout": "Déconnecter {name}"
    }
  }
}
```

Missing messages fall back to the declared officially bundled locale, or US
English when that locale is unavailable. Pack loading rejects unknown keys,
invalid BCP 47 locale identifiers, and translations whose interpolation
placeholders differ from the English source. A missing or invalid manifest or
pack does not prevent the application from starting.

Translation packs are data only. They cannot contain executable JavaScript or
HTML messages.

## Locale matching for plugin text

Frontend plugins own their labels and runtime text. Use the SDK helper rather
than asking the host to translate plugin strings:

```ts
import { localize } from "@apinteract/plugin-sdk/frontend/localization";

const label = localize(
  "Preview",
  { "zh-CN": "预览", "zh-TW": "預覽" },
  current.locale,
);
```

Resolution is ordered and script-safe:

1. exact and canonical BCP 47 matches;
2. a likely-subtag-compatible locale using the runtime's CLDR data;
3. the plugin's supplied fallback text.

This means `zh-Hans` can use `zh-CN` when no `zh-Hans` translation exists, and
`zh-Hant` can use `zh-TW`. The matcher compares language and likely script
before considering region, so `sr-Latn` will not fall back to `sr-RS` when that
tag implies Cyrillic Serbian. Region differences within the same language and
script are allowed as a lower-priority fallback.

The resolver memoizes canonical tags, likely-subtag profiles, translation-map
indexes, and locale-set decisions. Plugin authors do not need to manage or
invalidate these caches. Translation maps should be treated as immutable after
registration; changing a map in place is unsupported.

The matcher is a best-fit fallback, not a promise that regional terminology is
identical. Provide an exact key whenever a region-specific wording matters.
