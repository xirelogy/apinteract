# Release Supply-Chain Verification

APInteract uses a two-phase release workflow. The build phase examines a clean
source revision, produces a release-labelled all-in-one image, and verifies
that exact local image. The published-verification phase proves that an
immutable registry image is the approved local image and verifies its
signature and attestations.

This process currently covers the AIO release artifact. A future standalone
proxy image must pass the same image-level checks independently.

`VERSION` in the commands and paths below is a placeholder for the product
version without a leading `v`. The corresponding Git release tag is
`vVERSION`.

## Prerequisites

The release host requires Git, Node.js, pnpm, Docker Engine, and network access
to the package and container registries used by the project. The script runs
Gitleaks, Trivy, Syft, and Cosign from exact versioned container images and
records their resolved registry digests with the evidence. Tool-image pulls
retry brief registry failures three times before the gate fails closed.

Run the gate only from a trusted release host. Scanner containers receive
read-only repository or image-archive mounts; they are not added to the
APInteract runtime image.

The AIO Dockerfile pins the multi-platform Node base-image index by digest and
pins each supported s6 archive by its upstream SHA-256 value. Updating Node or
s6 requires reviewing and updating those immutable inputs; tests reject a
return to a floating base tag or unchecked supervisor archive.

## Prepare And Build A Release Candidate

Prepare the release version from a clean worktree:

```sh
deploy/scripts/release prepare VERSION
```

This updates only the root, backend, frontend, and proxy package manifests plus
the Dockerfile and Compose AIO version defaults. It requires all six sources to
start on one version, verifies all written values, and leaves the changes
uncommitted for review. It deliberately does not change the independently
versioned backend API, proxy API, plugin contracts, or plugin packages.

Review and commit the release metadata together with all intended source
changes. From the resulting clean worktree, run:

```sh
deploy/scripts/release build VERSION
```

The version must exactly match all four product package manifests and both AIO
defaults. The worktree must be clean. If `vVERSION` already exists, it must
point to the release commit; the tag may also be created after this
pre-publication build.

The release build:

- force-materializes the exact locked dependency graph without running
  dependency lifecycle scripts, so installed-package audits do not depend on
  stale or incomplete local pnpm metadata;
- runs full and production-only pnpm vulnerability audits with fetch retries,
  three command attempts, exponential backoff, and a five-minute request
  timeout for transient registry transport failures (the release host still
  selects the registry);
- inventories full and production dependency licenses and enforces the
  reviewed policy in [`license-policy.json`](license-policy.json);
- scans Git history for secrets with redacted findings;
- scans repository dependencies and configuration for high or critical
  findings;
- emits an SPDX JSON source SBOM;
- installs the locked dependencies with their required native build steps only
  after the dependency and source gates pass;
- runs the repository's format, generated-contract, source-documentation,
  lint, type, and test checks and confirms they left the worktree clean;
- builds the AIO image with exact version and source-revision labels;
- runs the complete isolated AIO runtime verification against that image;
- records all high or critical image findings, including findings for which
  the pinned distribution currently provides no fix;
- fails when a high or critical image finding has an available fix, ensuring
  the pinned base or affected dependency must then be refreshed;
- scans the same image archive for secrets; and
- retains that exact Docker image archive and emits an SPDX JSON image SBOM,
  image metadata, tool digests, and checksums. SBOM files are moved into place
  only after Syft succeeds and produces non-empty output; the corresponding
  `source.spdx.log` and `image.spdx.log` files retain its diagnostics. Syft gets
  an isolated writable temporary filesystem while its source mount remains
  read-only, allowing its unprivileged process to unpack image archives.

Evidence is written to `var/release/VERSION/`, which is ignored by Git. An
existing evidence directory is never overwritten. Preserve a failed attempt
for diagnosis or move it before rerunning the gate.

The dependency, license, and source gates run before the image build. A failed
gate leaves diagnostic evidence but no release image. The image is complete
only when the command prints `Release image built and verified`.

The resulting approved image remains in the local Docker image store as
`apinteract/aio:VERSION`. A portable copy is retained at
`var/release/VERSION/apinteract-aio-VERSION.tar`; `docker load` can
restore the same tag and image ID on another host. The command prints both the
immutable local image ID and archive path.

The script itself does not authenticate to a registry, push an image, create a
Git tag, or sign anything. In the GitHub repository, pushing a matching release
tag starts [the AIO publication workflow](../../.github/workflows/publish-aio.yml):

```sh
git tag vVERSION
git push origin vVERSION
```

The tag must be `v` followed by a version accepted by the release script, and
the commit's product manifests and AIO defaults must contain that exact version.
The workflow runs this complete release build on `linux/amd64`. It publishes
the verified image to `docker.io/xirelogy/apinteract` with both the version
without its leading `v` and `latest`, and refuses to overwrite an existing
version tag.
Pre-release tags intentionally advance `latest`; pin the version tag or digest
when deployments must not follow that moving alias.

The published digest is signed through GitHub's OIDC identity. The workflow
also attaches its SLSA provenance and the release build's SPDX image SBOM, then
retains the remaining release evidence as a workflow artifact for 30 days.
After the release gates pass but before any image tag is pushed, the workflow
publishes the Docker Hub repository description and overview from the root
[`README.DockerHub.md`](../../README.DockerHub.md). Keeping this metadata update
before the first registry mutation means an authentication or Docker Hub API
failure leaves the immutable version safe to retry.
The Cosign container runs with the runner's numeric user and group so it can
read the runner-owned, mode-restricted temporary Docker credential directory.
Its home, cache, and temporary paths use a separate runner-owned writable bind
mount that persists across the signature and both attestation commands; the
credential and release-evidence mounts remain read-only. This is required
because the pinned distroless Cosign image normally runs as a different
unprivileged user, while keyless signing caches Sigstore trust metadata below
the invoking user's home directory.
Configure a GitHub Actions repository secret named `DOCKERHUB_TOKEN` with a
Docker Hub personal access token with read, write, and delete permissions for
the `xirelogy/apinteract` repository. The metadata action requires all three
permissions; the workflow uses the same token to push the image. The Docker Hub
repository controls whether anonymous users can pull the published image.

## Publish Plugin Development Packages

`@apinteract/plugin-api` and `@apinteract/plugin-sdk` are released independently
from the product image. Update their package manifests and release assertions,
run `deploy/scripts/development check`, then commit and push the verified source
before creating either release tag.

Pull requests run the unprivileged `Verify plugin packages` workflow for both
packages. It runs the complete repository gate, packs the public packages,
performs an offline npm publication dry run without provenance or credentials,
records SHA-256 checksums, and retains the tarballs as a seven-day workflow
artifact. The dry run deliberately avoids npm's version lookup so an unchanged,
already-published companion package can still be revalidated; the tagged
publish job separately fails if its selected version already exists.
After the workflow exists on the default branch, it can also be run manually
against a selected Git ref for both packages or either package individually.
Treat a successful run for the release commit as a prerequisite for tagging.

The tag must exactly match the selected package and manifest version:

- `plugin-api-vVERSION` publishes `@apinteract/plugin-api@VERSION`.
- `plugin-sdk-vVERSION` publishes `@apinteract/plugin-sdk@VERSION`.

Push the API tag first whenever the SDK peer range requires that API release.
Wait until the API version is available from npm before pushing the SDK tag.
Each tag workflow invokes the same unprivileged verifier, then passes the
resulting immutable GitHub artifact and its SHA-256 through to a separate
publish job. Only that final job receives the `npm` environment and GitHub OIDC
permission. It checks the downloaded artifact, package identity, exact release
tag, and npm version availability without checking out or executing repository
code or package lifecycle scripts, then publishes that exact tarball with
provenance. Stable versions use the `latest` npm dist-tag, OIDC test versions
use `oidc`, and other prereleases use `next`.

npm trusted publishing must authorize `publish-plugin-api.yml` and
`publish-plugin-sdk.yml` separately for the `xirelogy/apinteract` repository
and the `npm` GitHub environment. Both trusted publishers require npm publish
permission and public publishing access. The packages have completed their
one-time initialization, so routine releases do not use an npm token or the
manual initialization workflow.

## License Policy

The policy is intentionally an allowlist. A new or missing license expression
fails the release even when the dependency otherwise builds successfully.
Ambiguous license declarations may be approved only for a specific package
name and version through `packageExceptions`.

Updating the policy is a maintainer review decision. Confirm the dependency's
actual license text, distribution obligations, notices, and compatibility with
the APInteract artifact before recording an approval. Do not treat package
metadata or an SBOM as legal review by itself.

Trivy misconfiguration exceptions are similarly narrow and documented in
[`trivy-ignore.yaml`](trivy-ignore.yaml). They are scoped to exact paths and
retained as suppressed findings in the scan evidence. Adding or widening an
exception requires review of the affected runtime privilege boundary.

## Verify The Published Image

After publishing, signing, and attaching provenance and SPDX SBOM attestations,
use the registry-provided immutable digest:

```sh
APINTERACT_COSIGN_CERTIFICATE_IDENTITY='https://github.com/OWNER/REPOSITORY/.github/workflows/publish-aio.yml@refs/tags/vVERSION' \
APINTERACT_COSIGN_CERTIFICATE_OIDC_ISSUER='https://token.actions.githubusercontent.com' \
deploy/scripts/release verify-published \
  'docker.io/xirelogy/apinteract@sha256:DIGEST' \
  VERSION
```

For key-based signing, provide `APINTERACT_COSIGN_PUBLIC_KEY` instead of the
certificate identity and issuer. The public key is mounted read-only into the
Cosign container.

Published verification:

- requires a digest-qualified image reference;
- compares its OCI config digest, architecture, version, and source revision
  with the locally approved image;
- rescans the pulled image and emits another SPDX SBOM; and
- verifies the Cosign signature, SLSA provenance attestation, and SPDX JSON
  SBOM attestation.

The attestation types default to `slsaprovenance` and `spdxjson`. Registries or
release systems using different Cosign predicate names may set
`APINTERACT_PROVENANCE_TYPE` and `APINTERACT_SBOM_TYPE` explicitly.

The config-digest comparison is architecture-specific. A future multi-platform
release must run and retain the release build separately for every supported
platform or extend the evidence format to record each platform manifest.

## Failure Policy

The gate fails closed for detected secrets, unapproved licenses, audit
failures, high or critical Trivy findings, runtime-verification failures,
artifact mismatches, or missing signature and attestations. A scanner database
or registry outage also fails the gate because a release must not be approved
from incomplete evidence.

Any vulnerability exception should be public, narrowly scoped to the exact
package or image component and advisory, justified by reachability and impact,
assigned an expiry, and reviewed again for every release. The script does not
silently suppress findings.
