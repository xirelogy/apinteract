<p align="center">
  <img src="logo.png" alt="APInteract logo" width="840">
</p>

# APInteract

[![Docker image](https://img.shields.io/github/v/tag/xirelogy/apinteract?filter=v%2A&include_prereleases&sort=semver&label=docker%20image)](https://hub.docker.com/r/xirelogy/apinteract/tags)
[![Docker pulls](https://img.shields.io/docker/pulls/xirelogy/apinteract)](https://hub.docker.com/r/xirelogy/apinteract)
[![License](https://img.shields.io/github/license/xirelogy/apinteract)](LICENSE)

APInteract is a free and open-source, self-hosted API client for designing,
organizing, executing, and reviewing API requests. It provides a professional
workspace for individuals and teams without placing core capabilities behind
proprietary services.

APInteract is actively developed. Versioned container releases are built,
tested, scanned, signed, and published with provenance and software bills of
materials so deployments can be pinned and independently verified.

## Features

APInteract:

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

## Quick Start

The all-in-one container is the recommended deployment. It includes the web
application, backend, and request proxy. Docker Engine with the Compose plugin
is required.

Choose a version from the
[Docker Hub tag list](https://hub.docker.com/r/xirelogy/apinteract/tags) and
create a Compose file:

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

Replace `VERSION` with a version shown in the Docker Hub tag list. The `latest`
alias follows new releases, while a version or immutable digest keeps
deployments predictable.

Start the service and create its first administrator:

```sh
docker compose up -d
docker compose exec --user 10001:10001 apinteract apinteract-admin init
```

Open <http://127.0.0.1:8080/web-ui/> and sign in. See the
[all-in-one deployment guide](deploy/aio/README.md) for immutable digest
pinning, public-origin configuration, reverse-proxy networking, storage,
backup, and verification guidance.

## Develop From Source

Source development uses a dedicated container with the repository mounted and
the Vite development server enabled. This environment is separate from the
all-in-one deployment image.

Build and initialize the development environment, then start APInteract:

```sh
deploy/scripts/development bootstrap
deploy/scripts/development init-admin
deploy/scripts/development dev
```

The development wrapper also provides type checking, unit tests, full
repository checks, browser tests, logs, and shell access. See the
[development container guide](deploy/development/README.md) for the complete
workflow and local configuration options.

## Architecture

APInteract consists of three independently defined components:

- a Vue 3 and TypeScript frontend built with Vite;
- a Node.js backend for business logic, persistence, orchestration, and
  scripting; and
- a proxy service that performs outbound API requests.

The frontend and backend communicate through WebSocket. The backend reaches
the proxy through its authenticated REST API whether both components share the
all-in-one container or are deployed across a network boundary. SQLite is the
default persistent store, with database-specific behavior kept behind a
portable persistence boundary.

The public [architecture overview](docs/architecture/README.md) describes
component ownership, request execution, communication planes, and deployment
topologies.

The [all-in-one deployment](deploy/aio/README.md) packages the compiled
frontend, backend, and loopback proxy in one container for straightforward
self-hosting while preserving those component boundaries.

## Documentation

Start with the [documentation index](docs/README.md) for architecture, API
contracts, scripting, plugins, request composition, and response inspection.

The [component API index](docs/api/README.md) lists the public contracts used
between APInteract components. Each independently deployed component owns its
canonical OpenAPI document; the proxy contract is available as
[OpenAPI JSON](docs/proxy-api/openapi.json).

## License

APInteract is licensed under the [MIT License](LICENSE).
