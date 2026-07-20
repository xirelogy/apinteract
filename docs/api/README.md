# Component API Contracts

Each APInteract component maintains its own canonical OpenAPI JSON document.
That document is the single source of truth for the component's public API.
Implementations, contract tests, generated clients, and published references
use the owning component's specification as their authoritative contract.

## Available Contracts

- [Proxy component API](../proxy-api/README.md): backend-to-proxy request
  execution, streaming, authentication, and cancellation.

## Contract Model

- Each component API has one canonical OpenAPI JSON document.
- The contract covers component-to-component operations, payloads, events, and
  errors.
- Documented OpenAPI extensions describe transport features, including
  WebSocket messaging, that OpenAPI does not represent directly.
- Independently deployed component APIs remain in separate specifications.
- Handwritten documentation provides context without creating a competing
  contract.
- Compatible additions and breaking changes are identified explicitly.
- Component API version changes follow explicit maintainer approval.
- Continuous integration validates each specification once the build system is
  established.
