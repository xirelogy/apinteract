import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfile = await readFile(
  new URL("../deploy/aio/Dockerfile", import.meta.url),
  "utf8",
);
const releaseScript = await readFile(
  new URL("../deploy/scripts/release", import.meta.url),
  "utf8",
);
const trivyIgnorePolicy = await readFile(
  new URL("../deploy/release/trivy-ignore.yaml", import.meta.url),
  "utf8",
);
const administratorHelper = await readFile(
  new URL("../deploy/aio/apinteract-admin", import.meta.url),
  "utf8",
);
const publishWorkflow = await readFile(
  new URL("../.github/workflows/publish-aio.yml", import.meta.url),
  "utf8",
);

test("pins release build inputs and verifies downloaded supervisor archives", () => {
  assert.match(
    dockerfile,
    /^ARG NODE_IMAGE=node:24-bookworm-slim@sha256:[a-f0-9]{64}$/m,
  );
  assert.match(dockerfile, /^ARG S6_OVERLAY_NOARCH_SHA256=[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^ARG S6_OVERLAY_X86_64_SHA256=[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^ARG S6_OVERLAY_AARCH64_SHA256=[a-f0-9]{64}$/m);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/npm/);
  assert.match(dockerfile, /COPY --chmod=0755 deploy\/aio\/apinteract-admin/);
  assert.match(administratorHelper, /admin init/);
  assert.match(administratorHelper, /admin reset-password/);
});

test("uses exact scanner versions instead of floating latest tags", () => {
  assert.doesNotMatch(releaseScript, /_image="[^"]+:latest"/);
  for (const tool of ["gitleaks", "trivy", "syft", "cosign"]) {
    assert.match(
      releaseScript,
      new RegExp(`^${tool}_image="[^"]+:v?\\d+\\.\\d+\\.\\d+"$`, "m"),
    );
  }
});

test("retries transient tool pulls and writes SBOMs atomically", () => {
  const generateSbomFunction = releaseScript.match(
    /^generate_sbom\(\) \{[^]*?^\}$/m,
  );
  assert.ok(generateSbomFunction);
  assert.match(releaseScript, /^tool_image_pull_attempts=3$/m);
  assert.match(
    releaseScript,
    /for \(\(attempt = 1; attempt <= tool_image_pull_attempts; attempt\+\+\)\)/,
  );
  assert.match(
    releaseScript,
    /sleep "\$\{tool_image_pull_retry_delay_seconds\}"/,
  );
  assert.match(
    releaseScript,
    /--output spdx-json >"\$\{partial_output_path\}"/,
  );
  assert.match(generateSbomFunction[0], /--env HOME=\/tmp/);
  assert.match(generateSbomFunction[0], /--env XDG_CACHE_HOME=\/tmp\/\.cache/);
  assert.match(
    generateSbomFunction[0],
    /--tmpfs \/tmp:rw,nosuid,nodev,mode=1777/,
  );
  assert.match(releaseScript, /\[\[ ! -s "\$\{partial_output_path\}" \]\]/);
  assert.match(
    releaseScript,
    /mv -- "\$\{partial_output_path\}" "\$\{output_path\}"/,
  );
  assert.doesNotMatch(
    generateSbomFunction[0],
    /--volume "\$\{evidence_directory\}:\/reports"/,
  );
});

test("keeps Trivy exceptions path-scoped and visible in release evidence", () => {
  assert.match(
    releaseScript,
    /--ignorefile \/repo\/deploy\/release\/trivy-ignore\.yaml/,
  );
  assert.match(releaseScript, /--show-suppressed/);
  for (const path of [
    "deploy/aio/Dockerfile",
    "deploy/development/Dockerfile",
    "deploy/development/Dockerfile.browser",
  ]) {
    assert.match(trivyIgnorePolicy, new RegExp(`- "${path}"`));
  }
  assert.equal([...trivyIgnorePolicy.matchAll(/- id: AVD-DS-0002/g)].length, 3);
});

test("exposes the gated image operation as a release build", () => {
  assert.match(releaseScript, /deploy\/scripts\/release build VERSION/);
  assert.doesNotMatch(releaseScript, /deploy\/scripts\/release check VERSION/);
  assert.match(releaseScript, /^\s*build\)$/m);
  assert.match(
    releaseScript,
    /pnpm install --frozen-lockfile --ignore-scripts --force/,
  );
  assert.match(releaseScript, /pnpm install --frozen-lockfile --force/);
  assert.match(releaseScript, /pnpm check \|\| die/);
  assert.match(
    releaseScript,
    /local image_archive_name="apinteract-aio-\$\{version\}\.tar"/,
  );
  assert.match(
    releaseScript,
    /docker image save --output "\$\{evidence_directory\}\/\$\{image_archive_name\}"/,
  );
  assert.match(releaseScript, /Building and verifying the AIO image/);
  assert.match(releaseScript, /The AIO build or runtime verification failed/);
  assert.match(releaseScript, /trivy-image\.json[^]* 0/);
  assert.match(releaseScript, /trivy-image-gate\.json[^]* 1 --ignore-unfixed/);
});

test("publishes only validated version tags as immutable and latest images", () => {
  assert.match(
    publishWorkflow,
    /^\s+tags:\s*\n\s+- "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"\s*\n\s+- "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+-\[0-9A-Za-z\]\+"$/m,
  );
  assert.match(
    publishWorkflow,
    /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\(-\[0-9A-Za-z\]\+\)\?\$/,
  );
  assert.match(publishWorkflow, /deploy\/scripts\/release build/);
  assert.doesNotMatch(publishWorkflow, /run: pnpm check/);
  assert.match(publishWorkflow, /image="docker\.io\/xirelogy\/apinteract"/);
  assert.match(publishWorkflow, /secrets\.DOCKERHUB_TOKEN/);
  assert.match(publishWorkflow, /docker login docker\.io/);
  assert.doesNotMatch(publishWorkflow, /packages:\s*write/);
  assert.doesNotMatch(publishWorkflow, /\$\{\{\s*runner\.temp\s*\}\}/);
  assert.match(
    publishWorkflow,
    /mktemp -d "\$\{RUNNER_TEMP\}\/apinteract-docker\.XXXXXXXX"/,
  );
  assert.match(publishWorkflow, /Refuse to overwrite an immutable version tag/);
  assert.match(publishWorkflow, /docker push "\$\{IMAGE\}:\$\{VERSION\}"/);
  assert.match(publishWorkflow, /docker push "\$\{IMAGE\}:latest"/);
  assert.match(publishWorkflow, /cosign sign --yes/);
  assert.match(
    publishWorkflow,
    /--user "\$\(id -u\):\$\(id -g\)"[^]*--env DOCKER_CONFIG=\/docker-config[^]*--volume "\$\{DOCKER_CONFIG\}:\/docker-config:ro"/,
  );
  assert.match(
    publishWorkflow,
    /cosign_home="\$\(mktemp -d "\$\{RUNNER_TEMP\}\/apinteract-cosign\.XXXXXXXX"\)"/,
  );
  for (const writablePath of [
    "HOME=/cosign-home",
    "TMPDIR=/cosign-home/tmp",
    "XDG_CACHE_HOME=/cosign-home/.cache",
  ]) {
    assert.match(publishWorkflow, new RegExp(`--env ${writablePath}`));
  }
  assert.match(publishWorkflow, /--volume "\$\{cosign_home\}:\/cosign-home"/);
  assert.doesNotMatch(publishWorkflow, /\/root\/\.docker\/config\.json/);
  assert.match(
    publishWorkflow,
    /\[\[ -s "\$\{DOCKER_CONFIG\}\/config\.json" \]\]/,
  );
  assert.match(publishWorkflow, /--type slsaprovenance/);
  assert.match(publishWorkflow, /--type spdxjson/);
  assert.match(publishWorkflow, /\[\[ -d "var\/release\/\$\{VERSION\}" \]\]/);
  assert.match(
    publishWorkflow,
    /steps\.evidence\.outputs\.available == 'true'/,
  );
  assert.doesNotMatch(publishWorkflow, /uses:\s+[^\s]+@v\d+/);
  for (const action of ["checkout", "setup-node", "upload-artifact"]) {
    assert.match(
      publishWorkflow,
      new RegExp(`uses: actions/${action}@[a-f0-9]{40}`),
    );
  }
});
