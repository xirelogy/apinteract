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

test("pins release build inputs and verifies downloaded supervisor archives", () => {
  assert.match(
    dockerfile,
    /^ARG NODE_IMAGE=node:24-bookworm-slim@sha256:[a-f0-9]{64}$/m,
  );
  assert.match(dockerfile, /^ARG S6_OVERLAY_NOARCH_SHA256=[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^ARG S6_OVERLAY_X86_64_SHA256=[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^ARG S6_OVERLAY_AARCH64_SHA256=[a-f0-9]{64}$/m);
  assert.match(dockerfile, /sha256sum --check --strict/);
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
