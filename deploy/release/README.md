# Release Supply-Chain Verification

APInteract uses a two-phase release gate. The first phase examines a clean
source revision and its locally built all-in-one image. The second phase proves
that an immutable published image is the image that passed the first phase and
verifies its signature and attestations.

This process currently covers the AIO release artifact. A future standalone
proxy image must pass the same image-level checks independently.

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

## Prepare And Check A Release Candidate

Prepare the release version from a clean worktree:

```sh
deploy/scripts/release prepare 0.1.0-alpha1
```

This updates only the root, backend, frontend, and proxy package manifests plus
the Dockerfile and Compose AIO version defaults. It requires all six sources to
start on one version, verifies all written values, and leaves the changes
uncommitted for review. It deliberately does not change the independently
versioned backend API, proxy API, plugin contracts, or plugin packages.

Review and commit the release metadata together with all intended source
changes. From the resulting clean worktree, run:

```sh
deploy/scripts/release check 0.1.0-alpha1
```

The version must exactly match all four product package manifests and both AIO
defaults. The worktree must be clean. If `v0.1.0-alpha1` already exists, it must
point to the checked commit; the tag may also be created after this
pre-publication check.

The command:

- runs full and production-only pnpm vulnerability audits;
- inventories full and production dependency licenses and enforces the
  reviewed policy in [`license-policy.json`](license-policy.json);
- scans Git history for secrets with redacted findings;
- scans repository dependencies and configuration for high or critical
  findings;
- emits an SPDX JSON source SBOM;
- builds the AIO image with exact version and source-revision labels;
- runs the complete isolated AIO runtime verification against that image;
- scans the same image archive for high or critical vulnerabilities and
  secrets; and
- emits an SPDX JSON image SBOM, image metadata, tool digests, and checksums.

Evidence is written to `var/release/0.1.0-alpha1/`, which is ignored by Git. An
existing evidence directory is never overwritten. Preserve a failed attempt
for diagnosis or move it before rerunning the gate.

The local approved image is tagged `apinteract/aio:0.1.0-alpha1`. Publication
is a separate, explicit operator action: this script does not authenticate to a
registry, push an image, create a Git tag, or sign anything.

## License Policy

The policy is intentionally an allowlist. A new or missing license expression
fails the release even when the dependency otherwise builds successfully.
Ambiguous license declarations may be approved only for a specific package
name and version through `packageExceptions`.

Updating the policy is a maintainer review decision. Confirm the dependency's
actual license text, distribution obligations, notices, and compatibility with
the APInteract artifact before recording an approval. Do not treat package
metadata or an SBOM as legal review by itself.

## Verify The Published Image

After publishing, signing, and attaching provenance and SPDX SBOM attestations,
use the registry-provided immutable digest:

```sh
APINTERACT_COSIGN_CERTIFICATE_IDENTITY='https://github.com/OWNER/REPOSITORY/.github/workflows/release.yml@refs/tags/v0.1.0-alpha1' \
APINTERACT_COSIGN_CERTIFICATE_OIDC_ISSUER='https://token.actions.githubusercontent.com' \
deploy/scripts/release verify-published \
  'REGISTRY/OWNER/apinteract@sha256:DIGEST' \
  0.1.0-alpha1
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
release must run and retain the pre-publication check separately for every
supported platform or extend the evidence format to record each platform
manifest.

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
