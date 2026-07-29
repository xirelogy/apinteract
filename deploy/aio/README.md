# All-In-One Deployment

The APInteract all-in-one image contains the compiled frontend, backend, and a
loopback-only request proxy. It is intended for one-host self-managed
deployments and for verifying the complete component boundary before a
release image is published.

The image is not yet a release artifact. Build and runtime verification should
be completed on every supported target architecture before production use.

## Start APInteract

Docker Engine with the Compose plugin is required. From the repository root:

```sh
deploy/scripts/aio up
deploy/scripts/aio init-admin
```

Open `http://localhost:8080/web-ui/` and sign in with the administrator just
created. The administrator command reads the password interactively and does
not place it in a command argument or environment variable.

The maintained wrapper provides these operations:

```text
deploy/scripts/aio build
deploy/scripts/aio up
deploy/scripts/aio down
deploy/scripts/aio ps
deploy/scripts/aio logs
deploy/scripts/aio init-admin
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
administrator configuration, logs, or persistent data.

s6 stops the backend before the proxy, allowing the backend to stop accepting
new work and close its resources before the data plane is terminated.

## Network Exposure

The Compose deployment publishes port 8080 on host loopback by default. Change
the host binding only when an ingress or firewall provides the intended access
boundary:

```sh
APINTERACT_AIO_BIND_ADDRESS=0.0.0.0 deploy/scripts/aio up
```

If `APINTERACT_AIO_PORT` changes the browser-visible port, provide an
administrator `publicOrigin` containing that exact port. Host publication does
not silently rewrite the backend's origin security policy.

Direct cleartext access is permitted only for a loopback public origin. A
deployment exposed through a reverse proxy should terminate TLS and provide a
backend administrator configuration whose `publicOrigin` is the exact HTTPS
origin shown to browsers.

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
session, origin, and proxy cache settings merge over the packaged defaults.

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
