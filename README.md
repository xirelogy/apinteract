<p align="center">
  <img src="logo.png" alt="APInteract logo" width="840">
</p>

# APInteract

APInteract is a free and open-source API client for developers. It is intended
to provide a professional, self-hostable workspace for designing, organizing,
executing, and reviewing API requests without placing core capabilities behind
proprietary services.

## Project Status

APInteract is an actively developed product in public alpha. Its core
self-hosted workflow is operational across the Vue frontend, backend, request
proxy, authentication, persistence, scripting, and outbound request-execution
boundaries.

The project is usable from source today. During active alpha development,
interfaces, deployment guidance, and upgrade expectations may continue to
evolve and will be documented with each release.

## Current Capabilities

APInteract currently:

- supports REST API request design, execution, and response inspection;
- organizes versioned requests into nested collections and workspaces;
- provides workspace environments, variables, secret values, and variable
  aliases;
- resolves inherited collection headers and scoped variables explicitly;
- runs sandboxed pre-request and post-response scripts through a documented
  SDK;
- supports username-and-password authentication and isolated user sessions;
- imports OpenAPI and HAR request definitions through built-in plugins;
- presents raw, structured, HTML, image, and binary response content through
  bounded viewers; and
- runs as a verified all-in-one container for straightforward self-hosting.

## Run APInteract

The maintained deployment is the all-in-one container. Docker Engine with the
Compose plugin is required. A production Compose file can be kept separately
from this source repository:

```yaml
services:
  apinteract:
    image: xirelogy/apinteract:VERSION
    restart: unless-stopped
    ports:
      - 127.0.0.1:8080:8080
    volumes:
      - apinteract-data:/data
      - apinteract-cache:/cache

volumes:
  apinteract-data:
  apinteract-cache:
```

Replace `VERSION` with a published Docker image version without the Git tag's
leading `v`. The `latest` alias is available, but a version or immutable digest
keeps deployments predictable.

Start the service and create its first administrator:

```sh
docker compose up -d
docker compose exec --user 10001:10001 apinteract apinteract-admin init
```

Open the configured public origin followed by `/web-ui/` and sign in. See the
[all-in-one deployment guide](deploy/aio/README.md) for immutable digest
pinning, public-origin configuration, reverse-proxy networking, storage,
backup, and verification guidance.

## Develop From Source

Contributor workflows use a separate development container with mounted source
and a Vite frontend. They are intentionally distinct from the production AIO
deployment:

```sh
deploy/scripts/development bootstrap
deploy/scripts/development dev
```

See the [development container guide](deploy/development/README.md) for tests,
browser checks, and local development settings.

## Architecture

APInteract consists of three independently defined components:

- a Vue 3 and TypeScript frontend built with Vite;
- a Node.js backend for business logic, persistence, orchestration, and
  scripting; and
- a proxy service that performs outbound API requests.

The frontend and backend communicate through WebSocket. The backend reaches
the proxy through its authenticated REST API whether both components share the
all-in-one container or are deployed across a network boundary. SQLite is the
current persistent store; database-specific behavior remains behind a portable
persistence boundary.

The public [architecture overview](docs/architecture/README.md) describes
component ownership, request execution, communication planes, and deployment
topologies.

The source-built [all-in-one deployment](deploy/aio/README.md) packages the
compiled frontend, backend, and loopback proxy in one container for local
self-hosting and full-boundary verification.

The current alpha release supports the all-in-one topology only.
A standalone proxy image is planned shortly afterward for deployments that
need outbound requests to originate from another network. In that topology,
the frontend and backend still run from the all-in-one image, while the backend
is configured with the remote proxy's address and bearer credential instead of
using its container-local proxy.

## Documentation

Public project documentation is maintained in [docs](docs/README.md).

The [component API index](docs/api/README.md) lists the public contracts used
between APInteract components. The proxy component's canonical
[OpenAPI JSON document](docs/proxy-api/openapi.json) currently defines the
`0.1.1` backend-to-proxy execution protocol.

The proposed
[authentication provider plugin contract](docs/plugins/authentication-providers.md)
describes how additional login methods can integrate without replacing
APInteract users, authorization, or session management.

## License

APInteract is licensed under the [MIT License](LICENSE).
