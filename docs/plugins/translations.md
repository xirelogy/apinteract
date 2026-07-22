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
