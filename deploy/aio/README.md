# All-In-One Deployment

The APInteract all-in-one image contains the compiled frontend, backend, and a
loopback-only request proxy. It is the maintained one-host deployment for
self-managed APInteract installations and verifies the same public component
boundaries used by separated deployments.

APInteract is actively developed, and cross-version upgrade guarantees are not
yet available. Version-tagged AIO releases are built, verified, signed, and
published by GitHub Actions to `docker.io/xirelogy/apinteract`.

## Start APInteract

Docker Engine with the Compose plugin is required. A production deployment can
use a small Compose file independent of the source repository:

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

Administrator configuration is optional. When needed, mount either component
file or both as an individual read-only bind mount:

```yaml
volumes:
  - apinteract-data:/data
  - apinteract-cache:/cache
  - ./backend.yaml:/etc/apinteract/backend.yaml:ro
  - ./proxy.yaml:/etc/apinteract/proxy.yaml:ro
```

Remove either file line when only the other component needs customization. See
[Administrator Configuration](#administrator-configuration) for complete
mounting examples, expanded defaults, and every precedence rule.

Replace `VERSION` with a published image version without the Git tag's leading
`v`.

Start it with:

```sh
docker compose up -d
```

The loopback binding above is a safe default for placing a TLS-terminating
reverse proxy in front of APInteract. Opening the port beyond loopback requires
an appropriate ingress and an HTTPS `publicOrigin`; see
[Network Exposure](#network-exposure). Pinning an immutable digest provides the
strongest deployment identity; `latest` follows every release tag, including
pre-releases.

Open the configured public origin followed by `/web-ui/`. On a fresh data
volume, APInteract presents a setup form for the first administrator. After
creation, sign in with the username and password you just chose. Opening the
origin root redirects to the canonical UI path.

Web setup is available by default because it is the simplest onboarding path.
Creating the first user through either the web UI or command line permanently
closes it for that database. Complete setup before exposing a fresh deployment
to people who should not become its administrator.

### Hardened First-User Initialization

Deployments that require an operator-controlled initialization boundary can
disable web setup before first startup:

```sh
APINTERACT_AIO_WEB_BOOTSTRAP=false deploy/scripts/aio up
deploy/scripts/aio init-admin
```

For a mounted backend configuration, set the equivalent persistent option:

```yaml
configVersion: 1
authentication:
  webBootstrap: false
```

The administrator command reads the password interactively and does not place
it in a command argument or environment variable. If an administrator loses
access, reset the password as a break-glass operation.

The reset also revokes the user's active sessions. `init-admin` remains safe to
rerun and does not replace credentials after the instance is initialized.

In a productive deployment, run the concise helper shipped in the image.
Replace `apinteract` with the container name or ID assigned by your deployment:

```sh
docker exec -it --user 10001:10001 apinteract apinteract-admin init
```

The command reads the password interactively from the terminal. It only
creates the first administrator; it does not replace an initialized account.
Reset an existing account with:

```sh
docker exec -it --user 10001:10001 apinteract \
  apinteract-admin reset-password USER
```

The maintained wrapper provides these operations:

```text
deploy/scripts/aio build
deploy/scripts/aio up
deploy/scripts/aio down
deploy/scripts/aio ps
deploy/scripts/aio logs
deploy/scripts/aio init-admin
deploy/scripts/aio reset-password USER
deploy/scripts/aio verify
deploy/scripts/aio config
```

`down` preserves the named data and cache volumes. Removing the data volume is
an explicit operator action and is not provided by the wrapper.

### APT mirror

The AIO and development images share the `APT_MIRROR_URL` build setting. Set it
to the Debian repository URL to use the same nearby mirror for both workflows:

```sh
APT_MIRROR_URL=https://mirror.example/debian deploy/scripts/aio verify
```

The mirror's security repository is expected at the same URL with the
`-security` suffix, matching Debian's standard mirror layout. When the setting
is empty or unset, the image uses Debian's official APT repositories.

If Docker requires `sudo` and the local sudo policy does not preserve this
variable, pass it explicitly:

```sh
sudo env APT_MIRROR_URL=https://mirror.example/debian deploy/scripts/aio verify
```

## Runtime Model

The image uses s6-overlay as PID 1. It starts the local proxy on loopback and
then the backend on port 8080. The backend serves the compiled Vue application
under `/web-ui/`; there is no frontend process in the runtime image.

The backend and proxy run as the unprivileged `apinteract` account. The root
filesystem is read-only under the provided Compose configuration. Writable
state is limited to:

| Path              | Purpose                                                            | Lifetime          |
| ----------------- | ------------------------------------------------------------------ | ----------------- |
| `/data`           | SQLite, response blobs, signing state, backups, and audit evidence | persistent        |
| `/cache`          | Local proxy transfer state                                         | disposable        |
| `/run/apinteract` | Generated component configuration and credential                   | container runtime |
| `/tmp`            | Bounded process temporary space                                    | container runtime |

The initializer generates a random local bearer credential, writes it with
owner-only permissions, and places the same value into effective backend and
proxy configuration. The credential is not included in the image,
administrator configuration, logs, or persistent data. The effective proxy
configuration is generated at `/run/apinteract/proxy.yaml`; administrator
input remains read-only at `/etc/apinteract/proxy.yaml` when mounted.

s6 stops the backend before the proxy, allowing the backend to stop accepting
new work and close its resources before the data plane is terminated.

## Network Exposure

The Compose deployment publishes port 8080 on host loopback by default. Change
the host binding only when an ingress or firewall provides the intended access
boundary:

```sh
APINTERACT_AIO_BIND_ADDRESS=0.0.0.0 deploy/scripts/aio up
```

Changing `APINTERACT_AIO_PORT` also changes the default loopback browser origin,
so local login works on the published port without extra configuration:

```sh
APINTERACT_AIO_PORT=9980 deploy/scripts/aio up
```

Direct cleartext access is permitted only for a loopback public origin. A
deployment exposed through a reverse proxy should terminate TLS and provide a
backend administrator configuration whose `publicOrigin` is the exact HTTPS
origin shown to browsers.

For an image-only deployment, provide that value through the administrator
configuration mount (no source checkout is required). Create a host file such
as `/etc/apinteract/backend.yaml`:

```yaml
configVersion: 1
server:
  publicOrigin: https://apinteract.example.com
```

Mount it read-only when creating the container:

```sh
docker run -d --name apinteract \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v apinteract-data:/data \
  -v apinteract-cache:/cache \
  -v /etc/apinteract/backend.yaml:/etc/apinteract/backend.yaml:ro \
  xirelogy/apinteract:VERSION
```

If you use an ingress or reverse proxy, publish the container only on a
private interface and set `publicOrigin` to the external HTTPS origin. The
value must not include a path (for example, use `https://example.com`, not
`https://example.com/apinteract`). Recreate the container after changing it;
the effective configuration is generated during startup.

## Administrator Configuration

The image has safe defaults and needs no administrator configuration for a
normal local deployment. Mount a file only when its component needs a setting
changed. The canonical mounts are:

```text
backend.yaml -> /etc/apinteract/backend.yaml:ro
proxy.yaml   -> /etc/apinteract/proxy.yaml:ro
```

The host files must exist as regular readable files before creating the
container.

### Docker Compose mounts

Add one or both bind mounts directly to the service. This complete example uses
both:

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
      - ./backend.yaml:/etc/apinteract/backend.yaml:ro
      - ./proxy.yaml:/etc/apinteract/proxy.yaml:ro

volumes:
  apinteract-data:
  apinteract-cache:
```

For backend-only configuration, retain only the `backend.yaml` bind mount. For
proxy-only configuration, retain only `proxy.yaml`. Relative host paths are
resolved from the directory containing the Compose file.

The repository also includes `deploy/aio/compose.configuration.example.yaml`
as an optional two-file override for `deploy/aio/compose.yaml`. It is a
convenience, not a required configuration mechanism.

Operators who always manage both files together may instead mount their parent
directory read-only:

```yaml
volumes:
  - ./configuration:/etc/apinteract:ro
```

Individual file mounts are preferred because they make the active component
configuration explicit and allow either file to be omitted.

### `docker run` mounts

The equivalent image-only command is:

```sh
docker run -d --name apinteract \
  --restart unless-stopped \
  --read-only \
  --security-opt no-new-privileges \
  -p 127.0.0.1:8080:8080 \
  --mount type=volume,source=apinteract-data,target=/data \
  --mount type=volume,source=apinteract-cache,target=/cache \
  --mount type=bind,source=/etc/apinteract/backend.yaml,target=/etc/apinteract/backend.yaml,readonly \
  --mount type=bind,source=/etc/apinteract/proxy.yaml,target=/etc/apinteract/proxy.yaml,readonly \
  --tmpfs /run:size=16m,mode=0755,exec \
  --tmpfs /tmp:size=64m,mode=1777 \
  xirelogy/apinteract:VERSION
```

Remove either bind-mount line when only one file is present. Absolute host paths
make this command independent of a source checkout.

### Expanded AIO defaults

The following blocks show the complete effective default behavior. They include
AIO-owned values so operators can understand the running components; they are
not templates for replacing generated credentials. Component-level defaults
that the generated `/run/apinteract/*.yaml` files omit are filled by the
component loaders before startup.

Default backend behavior:

```yaml
configVersion: 1
server:
  host: 0.0.0.0
  port: 8080
  publicOrigin: http://localhost:8080
persistence:
  databasePath: /data/database/apinteract.sqlite3
  migrationBackupDirectory: /data/backups
blobs:
  rootPath: /data/blobs
  stagingPath: /data/blob-staging
audit:
  rootPath: /data/audit
proxy:
  endpoint: http://127.0.0.1:8081
  bearerToken: "<generated privately at startup>"
sessions:
  secureCookie: false
  accessLifetimeSeconds: 900
  refreshIdleLifetimeSeconds: 604800
  refreshAbsoluteLifetimeSeconds: 2592000
frontend:
  distPath: /opt/apinteract/frontend
authentication:
  webBootstrap: true
  providers:
    - id: local-password
      plugin: builtin.local-password
      label: Username and password
      description: Sign in with your APInteract username and password.
      configuration: {}
plugins:
  builtinPath: /opt/apinteract/plugins
  userPath: /data/plugins
scripts:
  variableWrites:
    allowedScopes:
      - request
      - parent-collection
      - workspace
      - selected-environment
    allowSecrets: true
```

Default proxy behavior:

```yaml
configVersion: 1
server:
  host: 127.0.0.1
  port: 8081
cache:
  path: /cache
  retentionMs: 900000
limits:
  maxMetadataBytes: 1048576
  maxRequestHeaderCount: 1024
  maxRequestBodyBytes: 786432
  maxResponseBodyBytes: 1073741824
  maxCacheBytesPerPrincipal: 2147483648
  maxConcurrentExecutionsPerPrincipal: 16
targetPolicy:
  privateNetworkAccess: deny
  allowCidrs: []
  denyCidrs: []
transportObservations:
  enabled: true
principals:
  - id: aio-backend
    bearerToken: "<same generated private credential>"
```

### Merge and precedence rules

Administrator files are strict YAML 1.2 documents beginning with
`configVersion: 1`. Unknown properties are rejected. Objects merge recursively
over the defaults, while arrays replace the complete default array. A file may
therefore contain `configVersion` and only the sections being changed.

Startup applies values in this order, from lowest to highest precedence:

1. packaged AIO defaults;
2. the environment-derived default public origin;
3. mounted administrator YAML; and
4. the explicit web-bootstrap environment override and security-sensitive
   AIO-owned values.

The environment conveniences are limited to:

| Variable                       | Purpose                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `APINTERACT_AIO_BIND_ADDRESS`  | Host address used by the maintained Compose port publication; it does not alter component YAML. |
| `APINTERACT_AIO_PORT`          | Host published port and the default loopback public origin used by the maintained Compose file. |
| `APINTERACT_AIO_PUBLIC_ORIGIN` | Default backend browser origin when mounted YAML does not set `server.publicOrigin`.            |
| `APINTERACT_AIO_WEB_BOOTSTRAP` | `true` or `false` override for first-user web setup.                                            |

Mounted `server.publicOrigin` wins over `APINTERACT_AIO_PUBLIC_ORIGIN`.
`APINTERACT_AIO_WEB_BOOTSTRAP` is applied after the mounted authentication
section. Other component properties have no environment-variable equivalent.

The initializer always owns and overrides:

- backend listener `0.0.0.0:8080`;
- local proxy endpoint and generated bearer credential;
- proxy listener `127.0.0.1:8081` and its single `aio-backend` principal;
- compiled frontend path; and
- refresh-cookie security, derived from the effective public origin.

It also derives the default durable backend paths from `/data` and the proxy
cache path from `/cache`. Administrator files may override those paths, unlike
the AIO-owned values above, but the replacements must remain writable inside
the container and durable data should stay on the `/data` volume.

Administrator input stays read-only under `/etc/apinteract`. The initializer
writes private effective files and the generated credential under
`/run/apinteract` with owner-only permissions. Do not mount, edit, or persist
`/run/apinteract`; it is regenerated when the container starts.

### Maintained sample files

Source checkouts provide safe, validated examples:

```text
deploy/aio/configuration/backend.yaml
deploy/aio/configuration/proxy.yaml
```

Copy either file to the host path used by the corresponding bind mount and edit
only the required values. The complete supported component keys, accepted
values, defaults, and AIO override behavior are documented separately:

- [Backend configuration reference](../../docs/backend-api/configuration.md)
- [Proxy configuration reference](../../docs/proxy-api/configuration.md)

### Common backend changes

Set the exact external HTTPS origin when a reverse proxy serves the UI:

```yaml
configVersion: 1
server:
  publicOrigin: https://apinteract.example.com
```

Disable browser-based first-user setup while retaining the default local
password provider:

```yaml
configVersion: 1
authentication:
  webBootstrap: false
```

Post-response scripts can save ordinary and secret variable values in all
available scopes by default. Administrators can narrow this automation policy
in `backend.yaml`; an empty `allowedScopes` list disables persistent writes:

```yaml
configVersion: 1
scripts:
  variableWrites:
    allowedScopes:
      - request
      - selected-environment
    allowSecrets: false
```

Supported scopes are `request`, `parent-collection`, `workspace`, and
`selected-environment`. This policy is an upper bound and does not bypass the
executing user's access to a workspace or resource.

Authentication methods are also selected by startup configuration. The image
currently includes the local-password provider; omitting this section enables
one default instance and first-user web setup:

```yaml
configVersion: 1
authentication:
  webBootstrap: true
  providers:
    - id: local-password
      plugin: builtin.local-password
      label: Username and password
      description: Sign in with your APInteract username and password.
      configuration: {}
```

The instance `id` is the switch used by login and credential administration.
Set `webBootstrap: false` to require command-line initialization. For Compose
deployments, `APINTERACT_AIO_WEB_BOOTSTRAP=false` overrides the generated
runtime value without changing the mounted administrator file.
See [Authentication provider plugins](../../docs/plugins/authentication-providers.md)
for the ownership and identity-linking model.

### Common proxy changes

Raise selected resource limits without repeating unchanged defaults:

```yaml
configVersion: 1
limits:
  maxRequestBodyBytes: 16777216
  maxResponseBodyBytes: 2147483648
  maxConcurrentExecutionsPerPrincipal: 32
```

Permit all ordinary private network targets while retaining one explicit
exclusion:

```yaml
configVersion: 1
targetPolicy:
  privateNetworkAccess: allow
  allowCidrs: []
  denyCidrs:
    - 192.168.20.0/24
```

Alternatively, keep private networks denied and allow only selected ranges:

```yaml
configVersion: 1
targetPolicy:
  privateNetworkAccess: deny
  allowCidrs:
    - 10.20.0.0/16
  denyCidrs:
    - 10.20.5.0/24
```

Loopback, link-local, unspecified, multicast, and other non-unicast
special-use ranges remain blocked even when `privateNetworkAccess` is `allow`
or an `allowCidrs` entry contains them.

Detailed connection and TLS observations are enabled by default. Disable them
with `transportObservations.enabled: false` in `proxy.yaml`; first-byte and
total timings remain available.

### Apply changes and troubleshoot startup

Recreate the container after changing a mounted file so the initializer can
merge and validate it again:

```sh
docker compose up -d --force-recreate
docker compose logs apinteract
```

For `docker run`, stop and remove the old container, then repeat the same
creation command. Named `/data` and `/cache` volumes remain separate from the
container lifecycle.

Common failures are:

- **The host source does not exist.** Create the file first. Docker's `-v`
  syntax may create a directory at a missing host path, which then fails when
  mounted over a file. Prefer `--mount` for `docker run` because it reports a
  missing bind source immediately.
- **Unknown key or wrong value type.** Read the first startup validation error,
  correct the strict YAML property or value, and recreate the container.
- **Invalid or duplicate YAML keys.** Use spaces, keep keys unique, and avoid
  YAML aliases. Both files must parse as one object with `configVersion: 1`.
- **Permission denied.** Make the host file readable by the container runtime;
  keep it read-only in the container and restrict host access when it contains
  secrets.
- **Changes appear ignored.** Confirm the file targets `/etc/apinteract`, not
  `/run/apinteract`, then recreate rather than merely signaling the running
  component.
- **A configured path is unwritable.** The supplied container has writable
  storage only at `/data`, `/cache`, `/run`, and `/tmp`. Durable backend paths
  should remain under `/data`; proxy cache belongs under `/cache`.

## Persistent Data And Backup

The `apinteract-data` volume contains all durable application state. Back up
the complete volume as one consistency boundary while the container is
stopped. In particular, do not copy only the SQLite file while omitting blobs,
audit records, or signing state.

The `apinteract-cache` volume contains disposable proxy transfer state. It is
not part of backend backup and can be recreated after the AIO container is
stopped.

## Verification

The isolated verification command builds the image and proves:

- backend and proxy readiness;
- administrator initialization and login;
- authenticated WebSocket workspace, collection, and request operations;
- persistent collection headers and inherited proxy delivery;
- execution through the local proxy against a deterministic target;
- exact response-body download;
- persistence across restart;
- structured target-execution failure;
- degraded backend health while the proxy is unavailable;
- non-root component ownership and private credential permissions; and
- graceful stop and subsequent start.

Run it from the repository root:

```sh
deploy/scripts/aio verify
```

Verification uses an isolated Compose project, temporary named volumes, and a
random high host port. Its cleanup removes only those verification resources.

Before publishing a release image, run the broader
[release supply-chain verification](../release/README.md). It applies the AIO
runtime checks to a release-labelled image and retains dependency, secret,
license, vulnerability, SBOM, and artifact-identity evidence.
