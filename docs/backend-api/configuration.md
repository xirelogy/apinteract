# Backend Configuration

The backend reads one strict YAML 1.2 document. The canonical container path is
`/etc/apinteract/backend.yaml`; `--config <path>` selects another file. The
configuration is validated before application services start, and unknown
host-owned properties are rejected.

The standalone backend requires the `proxy` section because it must authenticate
to one proxy. Every other section has the defaults shown below:

```yaml
configVersion: 1

server:
  host: 0.0.0.0
  port: 8080
  publicOrigin: http://localhost:8080

persistence:
  databasePath: /data/apinteract.sqlite3
  migrationBackupDirectory: /data/backups

blobs:
  rootPath: /data/blobs
  stagingPath: /data/blob-staging

audit:
  rootPath: /data/audit

proxy:
  endpoint: https://proxy.example.com
  bearerToken: "replace-with-a-high-entropy-token"

sessions:
  secureCookie: true
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

Replace the proxy endpoint and token for a standalone deployment. The AIO image
generates them and overrides the corresponding administrator values.

## Key Reference

### Root and server

| Key                   | Accepted value              | Default                 | Meaning                                                                                |
| --------------------- | --------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `configVersion`       | Integer `1`                 | Required                | Selects the configuration contract.                                                    |
| `server.host`         | Non-empty string            | `0.0.0.0`               | Listener address.                                                                      |
| `server.port`         | Integer from 1 to 65535     | `8080`                  | Listener TCP port.                                                                     |
| `server.publicOrigin` | Non-empty exact HTTP origin | `http://localhost:8080` | Browser origin accepted by authentication and WebSocket checks. Do not include a path. |

Use the exact origin visible to browsers. Production browser access should use
HTTPS. The AIO initializer enforces HTTPS except for loopback-local origins and
derives cookie security from this value.

### Persistence, blobs, and audit

| Key                                    | Accepted value | Default                    | Meaning                                        |
| -------------------------------------- | -------------- | -------------------------- | ---------------------------------------------- |
| `persistence.databasePath`             | Non-empty path | `/data/apinteract.sqlite3` | SQLite database file.                          |
| `persistence.migrationBackupDirectory` | Non-empty path | `/data/backups`            | Backup destination used before migrations.     |
| `blobs.rootPath`                       | Non-empty path | `/data/blobs`              | Durable response and attachment blob storage.  |
| `blobs.stagingPath`                    | Non-empty path | `/data/blob-staging`       | Temporary staging area for atomic blob writes. |
| `audit.rootPath`                       | Non-empty path | `/data/audit`              | Durable audit evidence directory.              |

The database, blobs, backups, and audit records form one persistence boundary.
Paths must be writable by the backend process and should be backed up together.

### Proxy connection

| Key                 | Accepted value   | Default  | Meaning                                                                |
| ------------------- | ---------------- | -------- | ---------------------------------------------------------------------- |
| `proxy.endpoint`    | Non-empty URL    | Required | Base URL of the selected proxy. Use HTTPS across an untrusted network. |
| `proxy.bearerToken` | Non-empty string | Required | Credential mapped to the backend principal by the proxy.               |

The token is plaintext configuration secret material. Protect the file, avoid
placing it in source control or logs, and rotate both component configurations
together. AIO owns this complete section and generates a private local token.

### Sessions

| Key                                       | Accepted value        | Default   | Meaning                                         |
| ----------------------------------------- | --------------------- | --------- | ----------------------------------------------- |
| `sessions.secureCookie`                   | Boolean               | `true`    | Adds the `Secure` attribute to refresh cookies. |
| `sessions.accessLifetimeSeconds`          | Positive safe integer | `900`     | Access-token lifetime.                          |
| `sessions.refreshIdleLifetimeSeconds`     | Positive safe integer | `604800`  | Refresh session idle timeout.                   |
| `sessions.refreshAbsoluteLifetimeSeconds` | Positive safe integer | `2592000` | Maximum refresh session lifetime.               |

AIO derives `secureCookie`: HTTPS origins use `true`; loopback HTTP uses
`false`. Changing any session lifetime affects newly issued credentials and
requires a component restart.

### Frontend and plugin paths

| Key                   | Accepted value | Default                    | Meaning                                           |
| --------------------- | -------------- | -------------------------- | ------------------------------------------------- |
| `frontend.distPath`   | Non-empty path | `/opt/apinteract/frontend` | Compiled web application served under `/web-ui/`. |
| `plugins.builtinPath` | Non-empty path | `/opt/apinteract/plugins`  | Trusted built-in plugin packages.                 |
| `plugins.userPath`    | Non-empty path | `/data/plugins`            | Administrator-installed user plugin packages.     |

AIO owns `frontend.distPath` and uses the packaged built-in and persistent user
plugin locations. Its administrator overlay does not accept the `plugins`
section.

### Authentication

| Key                                        | Accepted value                          | Default                               | Meaning                                                                       |
| ------------------------------------------ | --------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| `authentication.webBootstrap`              | Boolean                                 | `true`                                | Allows the one-time first-user web setup while the database is uninitialized. |
| `authentication.providers`                 | Non-empty array                         | One `builtin.local-password` instance | Ordered login-provider instances. Supplying the array replaces the default.   |
| `authentication.providers[].id`            | Unique identifier, up to 128 characters | Required                              | Stable instance identifier used by login and credential administration.       |
| `authentication.providers[].plugin`        | Identifier, up to 128 characters        | Required                              | Built-in authentication plugin ID.                                            |
| `authentication.providers[].label`         | Non-empty string, up to 200 characters  | Required                              | User-facing login label.                                                      |
| `authentication.providers[].description`   | Non-empty string, up to 1000 characters | Omitted                               | Optional user-facing explanation.                                             |
| `authentication.providers[].configuration` | Bounded JSON-compatible value           | `{}`                                  | Provider-owned configuration validated again by the selected plugin.          |

Provider and instance identifiers use lowercase letters and digits separated
by `.` or `-`. Provider configuration permits JSON-compatible scalars, arrays,
and objects, with a maximum depth of 8, 128 entries per container, 4096
characters per string, and 100 characters per property name.

The AIO image currently ships `builtin.local-password`. Set `webBootstrap` to
`false` before first startup when the first administrator must be created only
through the command line. Its `configuration` is an empty object; other built-in
providers document their own accepted properties. See
[Authentication provider plugins](../plugins/authentication-providers.md) for
the provider lifecycle and trust boundary.

### Script variable writes

| Key                                    | Accepted value                                                                                 | Default         | Meaning                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `scripts.variableWrites.allowedScopes` | Unique array containing `request`, `parent-collection`, `workspace`, or `selected-environment` | All four scopes | Upper bound on persistent destinations available to response scripts. An empty array disables persistent writes. |
| `scripts.variableWrites.allowSecrets`  | Boolean                                                                                        | `true`          | Allows scripts to queue secret values for an otherwise permitted scope.                                          |

This policy never grants workspace or resource access that the executing user
does not already have.

## All-In-One Behavior

The AIO image reads an optional administrator overlay from
`/etc/apinteract/backend.yaml`, recursively merges it over AIO defaults, and
writes private effective configuration to `/run/apinteract/backend.yaml`.
Arrays, including `authentication.providers` and `allowedScopes`, replace the
complete default array.

AIO overrides the backend listener, local proxy endpoint and token, compiled
frontend path, and cookie security. `APINTERACT_AIO_PUBLIC_ORIGIN` supplies the
default public origin, while an explicitly mounted `server.publicOrigin` wins.
`APINTERACT_AIO_WEB_BOOTSTRAP`, when set to `true` or `false`, overrides the
mounted authentication value. See the
[AIO deployment guide](../../deploy/aio/README.md#administrator-configuration)
for mount examples and the complete precedence rules.
