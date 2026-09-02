# All-In-One Deployment

The APInteract all-in-one image contains the compiled frontend, backend, and a
loopback-only request proxy. It is the maintained one-host deployment for
self-managed APInteract installations and verifies the same public component
boundaries used by separated deployments.

APInteract is actively developed toward its `0.1.0-alpha1` public release. The
image can currently be built from source; published registry images and
cross-version upgrade guarantees are not yet available. Run the complete build
and runtime verification before relying on a source revision in a persistent
deployment.

## Start APInteract

Docker Engine with the Compose plugin is required. A production deployment can
use a small Compose file independent of the source repository:

```yaml
services:
  apinteract:
    image: apinteract/aio:0.1.0-alpha1
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

Start it with:

```sh
docker compose up -d
```

The image must already be available locally or replaced with the registry
reference for the release being deployed. The loopback binding above is a
safe default for placing a TLS-terminating reverse proxy in front of
APInteract. Opening the port beyond loopback requires an appropriate ingress
and an HTTPS `publicOrigin`; see [Network Exposure](#network-exposure).

Open the configured public origin followed by `/web-ui/` and sign in with the
administrator you create. Opening the origin root redirects to that canonical
UI path.

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
  apinteract/aio:0.1.0-alpha1
```

If you use an ingress or reverse proxy, publish the container only on a
private interface and set `publicOrigin` to the external HTTPS origin. The
value must not include a path (for example, use `https://example.com`, not
`https://example.com/apinteract`). Recreate the container after changing it;
the effective configuration is generated during startup.

## Administrator Configuration

The image has safe AIO defaults and does not require an administrator
configuration mount. To customize the supported configuration subset, copy
the examples and include the read-only Compose override:

```sh
cp -R deploy/aio/configuration /path/to/apinteract-configuration
docker compose \
  -f deploy/aio/compose.yaml \
  -f deploy/aio/compose.configuration.example.yaml \
  up -d --build
```

Adjust the override's host path if the configuration directory is outside
`deploy/aio/`. Configuration files are strict YAML 1.2 and begin with
`configVersion: 1`.

The initializer always owns these AIO-specific values:

- backend listener `0.0.0.0:8080`;
- local proxy endpoint and generated bearer credential;
- proxy listener `127.0.0.1:8081` and recognized local principal;
- compiled frontend path; and
- refresh-cookie security derived from the exact public origin.

This prevents an administrator file from exposing the internal proxy or
replacing its runtime-owned identity. Other supported backend storage,
session, origin, proxy cache, resource-limit, and outbound target-policy
settings merge over the packaged defaults. Private and unique-local targets are
denied by default. Set `targetPolicy.privateNetworkAccess` to `allow` for LAN or
sibling-container targets; loopback and link-local targets remain denied.

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
