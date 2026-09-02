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
records their resolved registry digests with the evidence.

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
- runs full and production-only pnpm vulnerability audits;
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
  image metadata, tool digests, and checksums.

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
Configure a GitHub Actions repository secret named `DOCKERHUB_TOKEN` with a
Docker Hub personal access token that can write to the `xirelogy/apinteract`
repository. The Docker Hub repository controls whether anonymous users can pull
the published image.

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
