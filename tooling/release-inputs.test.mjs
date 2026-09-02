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
