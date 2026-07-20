# APInteract Plugins

APInteract plugins extend selected backend and proxy capabilities through
domain-specific contracts. All plugin packages use one registration mechanism,
while each extension point retains its own interface, compatibility rules, and
data exposure.

The plugin system is currently in the design stage. Detailed executable
manifests and TypeScript interfaces will be published with the component
implementations.

## Package Layout

External plugins are self-contained packages loaded from an administrator-
controlled, read-only volume:

```text
/opt/apinteract/extensions/
  example-extension/
    apinteract-extension.json
    dist/
      entrypoint
```

The package manifest declares:

```text
package identity and version
compatible APInteract versions
target component
component entrypoints
extension interfaces provided
interface contract versions
host services requested
configuration schema
optional integrity metadata
```

One package can provide more than one implementation. Each implementation is
registered and configured separately.

## Common Registration

Every component entrypoint exports the same registration function:

```text
registerExtension(registrar)
```

Each registration identifies:

```text
interface ID
interface contract version
implementation ID and version
descriptor
requested host services
factory
```

Examples of interface IDs include:

```text
authentication.provider
payload.codec
blob.store
delivery.provider
content.importer
persistence.adapter
script.runtime
secret.store
logging.sink
proxy.selector
```

The interface ID selects a dedicated typed contract. A codec and a persistence
adapter therefore use the same registration mechanism without sharing a
business interface.

Registration describes factories and dependencies. Network connections,
database access, background work, and domain processing begin only after the
host validates and initializes a configured implementation.

## Host Services

Plugins request explicit versioned host services such as secure randomness,
cryptography, outbound HTTP, configuration-secret access, delivery, scoped
credential reading, structured logging, or metrics.

These declarations document intended access, keep plugins independent from
component internals, and support future out-of-process isolation. In-process
plugins remain trusted code and are not sandboxed by the declaration system.

## Sensitivity

APInteract assigns sensitivity from the registered interface and requested
services. A plugin can request additional access but cannot classify itself
below the interface baseline.

The operator-visible summary uses:

```text
standard
sensitive
critical
```

The detailed report also identifies data exposure, operational authority, and
failure impact. Examples include access to payload bytes, authentication
evidence, secrets, complete persistence, outbound networking, or startup-
critical services.

Sensitivity reporting provides deployment visibility rather than a security
sandbox. Write access to a plugin volume remains equivalent to code-execution
access in the target component.

## Lifecycle

Plugins follow one component-owned lifecycle:

```text
manifest discovery
compatibility validation
registration
configuration validation
initialization
health reporting
shutdown
```

MVP components load plugins at startup. Optional plugin failure disables the
affected implementation. A configured startup-critical implementation, such
as the selected persistence adapter, prevents startup when unavailable or
incompatible.

## Plugin Contracts

### Authentication Providers

[Authentication provider plugins](authentication-providers.md) define
declarative login interactions, credential data, external-provider
communication, and provider assertions. User linkage and session management
remain core backend services.

### Payload Codecs

Payload codecs transform or analyze raw and structured request and response
data. The backend retains ownership of payload modes, media types,
authoritative bytes, and execution behavior.

### Blob Stores

Blob stores stream immutable bytes to local filesystems or external object
storage. The backend owns identifiers, authorization, references, quotas,
retention, and garbage collection.

### Delivery Providers

Delivery providers transmit email, SMS, and similar messages. Authentication
providers own challenge generation and verification; delivery plugins only
transmit prepared messages.

### Content Importers

Importers parse external formats into neutral import plans and diagnostics.
The backend presents conflicts and commits accepted plans transactionally.

### Persistence Adapters

Persistence adapters implement repositories, transactions, migrations, and
health for supported databases. They preserve backend domain behavior rather
than defining database-specific product rules.

### Script Runtimes

Script runtimes compile and execute supported languages. APInteract retains
control of the SDK, sandbox policy, resource limits, secret access, and
execution phases.

### Secret Stores

Secret stores can integrate local encryption, external vaults, or key-
management systems. Variable scope, aliases, access control, and secret taint
remain backend behavior.

### Logging Sinks

Logging sinks export pre-redacted structured operational records. They do not
change log policy, request unredacted data, or define audit events.

### Proxy Selectors

Proxy selectors choose among configured proxy nodes using backend-provided
metadata and health. They do not perform target requests or replace the public
proxy component contract.

## Core Behavior

Plugins do not replace APInteract users, session policy, authorization,
workspace hierarchy, variable precedence, request versioning, execution state,
audit definitions, or public component protocols.

