# APInteract Documentation

This directory contains the public documentation for APInteract.

## Documentation Areas

- [Architecture](architecture/README.md): component responsibilities,
  communication boundaries, request flow, and deployment topologies.
- [Component API contracts](api/README.md): the index and governance rules for
  public APIs used between APInteract components.
- [Backend component API](backend-api/README.md): browser authentication,
  sessions, commands, events, and response-body transfer.
- [Proxy component API](proxy-api/README.md): the proxy protocol specification
  and supporting documentation.
- [Plugins](plugins/README.md): common registration, sensitivity reporting,
  lifecycle, and domain-specific extension contracts.
- [Scripting](scripting/README.md): write pre-request and post-response
  JavaScript scripts and understand their available helpers and limits.
- [Request targets](requests/README.md): compose request URLs from workspace
  base URLs, nested collection paths, variables, and request-local paths.
- [Response inspection](responses/README.md): inspect raw, structured, HTML,
  image, and binary response content safely.
- [All-in-one deployment](../deploy/aio/README.md): source-built container
  operation, storage, configuration, and verification.
- [Release supply-chain verification](../deploy/release/README.md): dependency,
  secret, license, package, image, SBOM, signature, and provenance release
  gates.

APInteract is actively developed as a public alpha.
Published documents describe current product behavior and mark proposed or
evolving contracts explicitly. Additional security, operations, user, and
contributor guides will be added as their release processes mature.
