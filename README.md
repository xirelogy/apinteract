<p align="center">
  <img src="logo.png" alt="APInteract logo" width="840">
</p>

# APInteract

APInteract is a free and open-source API client for developers. It is intended
to provide a professional, self-hostable workspace for designing, organizing,
executing, and reviewing API requests without placing core capabilities behind
proprietary services.

## Project Status

APInteract is currently in the product and architecture design stage. The
repository structure, component contracts, security model, and technology
choices are being defined before implementation begins.

## Direction

The planned product will:

- support REST API workflows in its first release;
- organize requests into nested collections and workspaces;
- provide workspace environments, variables, secret values, and variable
  aliases;
- support inherited collection headers and versioned requests;
- provide sandboxed pre-request and post-response scripting through a small
  SDK;
- support multiple users with simple username and password authentication for
  the initial release;
- run in containers for straightforward self-hosting; and
- provide responsive interfaces for desktop and mobile devices.

## Planned Architecture

APInteract is expected to consist of three independently defined components:

- a Vue 3 and TypeScript frontend built with Vite;
- a Node.js backend for business logic, persistence, orchestration, and
  scripting; and
- a proxy service that performs outbound API requests.

The frontend and backend will communicate through WebSocket. Proxy nodes will
offer a small REST API and may run with the backend or as separate services.
SQLite will be the default database, with PostgreSQL and MySQL support designed
behind a portable persistence boundary.

The detailed boundaries and contracts are still under design.

The public [architecture overview](docs/architecture/README.md) describes
component ownership, request execution, communication planes, and deployment
topologies.

## Documentation

Public project documentation is maintained in [docs](docs/README.md).

The [component API index](docs/api/README.md) lists the public contracts used
between APInteract components. The proxy component's canonical
[OpenAPI JSON document](docs/proxy-api/openapi.json) currently defines the
`0.1.0` backend-to-proxy execution protocol.

The planned
[authentication provider plugin contract](docs/plugins/authentication-providers.md)
defines how additional login methods integrate without replacing APInteract
users, authorization, or session management.

## License

APInteract is licensed under the [MIT License](LICENSE).
