# Development Container

The default APInteract development image contains Node.js 24, pnpm, and the
Linux build toolchain used by native dependencies. Source code is mounted into
the container while dependency directories and the pnpm store remain in named
Docker volumes.

Chromium and its system libraries are isolated in an optional browser-testing
image. Ordinary development does not pull or build that larger image.

## Start The Workspace

The maintained development command reads checked-in defaults from
`.env.defaults` and then applies values from the ignored `.env.local` file when
it exists. Shell environment values can override both files.

Build, start, and install dependencies:

```sh
deploy/scripts/development bootstrap
```

Create the first local-password administrator. The command prompts for the
password without echoing it:

```sh
deploy/scripts/development init-admin
```

Start the proxy, backend, and Vite frontend in the foreground:

```sh
deploy/scripts/development dev
```

The login page is then available at
`http://localhost:5173/web-ui/#/login`. When the frontend host port is changed
through `.env.local`, use that port in the URL. The generated backend
configuration uses the same value for exact origin validation.

Common lifecycle commands are:

```sh
deploy/scripts/development build
deploy/scripts/development up
deploy/scripts/development rebuild
deploy/scripts/development down
deploy/scripts/development ps
deploy/scripts/development prepare
deploy/scripts/development init-admin
deploy/scripts/development dev
deploy/scripts/development shell
deploy/scripts/development typecheck
deploy/scripts/development test
deploy/scripts/development check
```

The complete command list is available by running the command without an
argument.

After `bootstrap`, a normal verification sequence is:

```sh
deploy/scripts/development ps
deploy/scripts/development typecheck
deploy/scripts/development test
deploy/scripts/development check
```

`check` is the complete repository gate and includes formatting, public
contract validation, linting, type checking, and tests. A focused package
command can be run without opening a shell:

```sh
deploy/scripts/development exec \
  pnpm --filter @apinteract/proxy test
```

## Environment Files

`.env.defaults` contains non-secret, checked-in Docker development defaults.
`.env.local` is ignored and holds machine-specific overrides such as occupied
host ports or a preferred APT mirror. `.env.local.example` documents all
currently supported values.

For an HTTPS APT mirror, set `APT_MIRROR_URL` to the mirror's Debian repository
URL. The corresponding security repository is expected at the same URL with
the `-security` suffix, matching the standard Debian mirror layout:

```sh
APT_MIRROR_URL=https://mirror.example/debian
```

When `APT_MIRROR_URL` is empty or unset, the image uses Debian's official APT
repositories.

These variables configure Docker build and host-port publication. They are not
APInteract application configuration overrides. Component configuration
continues to use strict YAML under `/etc/apinteract/`.

## Local Mutable State

The ignored repository-root `var/` directory is reserved for local mutable
state generated while developing:

```text
var/config/       generated local component YAML
var/data/         SQLite, blobs, audit records, and migration backups
var/cache/        disposable proxy transfer cache
var/logs/         optional local file logs
var/playwright/   browser-test reports and traces
```

`var/` is not deployment configuration and is never included in production
images. It may be deleted when its local state is no longer needed. Named
Docker volumes remain in use for dependency directories and the pnpm store
because those artifacts are container-specific.

## Browser Tests

Build and run the optional Playwright service only when browser verification is
needed:

```sh
deploy/scripts/development browser-test
```

Optional Playwright arguments can select a focused file or browser project:

```sh
deploy/scripts/development browser-test \
  e2e/request-workflow.spec.ts --project=mobile-chromium
```

This command pulls the pinned Playwright image on first use. The browser
service starts an isolated proxy, backend, and Vite server with disposable
state. It verifies rejected credentials, successful login, refresh-cookie
session restoration, logout, and protected-route redirection. Reports and
failure traces are written to the ignored repository directory
`var/playwright/` so they remain available after the disposable browser
container exits.

## Exposed Ports

```text
Variable                                  Default  Container  Service
APINTERACT_DEV_BACKEND_PORT               8080     8080       backend
APINTERACT_DEV_PROXY_PORT                 8081     8081       proxy
APINTERACT_DEV_FRONTEND_PORT              5173     5173       Vite frontend
APINTERACT_DEV_FIXTURE_PORT               8090     8090       target fixture
APINTERACT_DEV_PLAYWRIGHT_REPORT_PORT     9323     9323       Playwright report
```

The variables select host ports only. Container ports and APInteract component
configuration remain unchanged. For example, to publish the backend on host
port `18080`:

```sh
APINTERACT_DEV_BACKEND_PORT=18080 \
  docker compose -f deploy/development/compose.yaml up -d
```

The same values can be placed in a shell environment or in a Compose `.env`
file beside the command invocation.

These separate ports are development-only. Production deployment uses the
all-in-one or standalone component images.
