# APInteract All-In-One

APInteract is a free and open-source, self-hosted API client for designing,
organizing, executing, and reviewing REST API requests. This image packages the
Vue frontend, Node.js backend, and loopback request proxy into a single-container
deployment.

APInteract is currently in public alpha. Interfaces, deployment guidance, and
upgrade expectations may change between releases.

## Start APInteract

Choose a published version tag and create a Compose file:

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

Replace `VERSION` with a version listed under the repository's **Tags** tab,
then start the service and create the first administrator:

```sh
docker compose up -d
docker compose exec --user 10001:10001 apinteract apinteract-admin init
```

Open <http://127.0.0.1:8080/web-ui/> and sign in. The administrator command
reads the password interactively and does not place it in a command argument or
environment variable.

The loopback port binding is a safe default. Before exposing APInteract through
a reverse proxy, configure its exact HTTPS public origin and review the network
and proxy trust boundaries in the
[all-in-one deployment guide](https://github.com/xirelogy/apinteract/blob/main/deploy/aio/README.md).

## Persistent Data

- `/data` contains the SQLite database, response blobs, signing state, backups,
  and audit evidence. Back up this volume as one consistency boundary.
- `/cache` contains disposable proxy transfer state and can be recreated.

The backend and request proxy run as the unprivileged `apinteract` account. The
recommended deployment configuration also supports a read-only root
filesystem.

## Image Tags

- Published version tags are immutable. Pin one for predictable deployments.
- `latest` follows every release, including public alpha and other prerelease
  versions.
- When choosing an image to run, use a version tag, `latest`, or an immutable
  digest. Digest-derived `.sig` and `.att` entries are attached Cosign
  verification metadata rather than APInteract image variants.

The image currently supports `linux/amd64`. For the strongest deployment
identity, pin it by its `sha256` digest.

## Supply-Chain Verification

Each release passes dependency, license, secret, vulnerability, repository,
runtime, and artifact-identity checks. The published digest is signed through
GitHub OIDC and carries SLSA provenance and an SPDX JSON image SBOM.

See the
[release verification guide](https://github.com/xirelogy/apinteract/blob/main/deploy/release/README.md)
for digest-qualified Cosign verification instructions.

## Project Links

- [Source and project documentation](https://github.com/xirelogy/apinteract)
- [Deployment documentation](https://github.com/xirelogy/apinteract/blob/main/deploy/aio/README.md)
- [Issue tracker](https://github.com/xirelogy/apinteract/issues)
- [MIT License](https://github.com/xirelogy/apinteract/blob/main/LICENSE)
