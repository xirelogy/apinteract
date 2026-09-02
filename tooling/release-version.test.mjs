import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkReleaseVersion,
  prepareReleaseVersion,
  readReleaseVersions,
  validateReleaseVersion,
} from "./release-version.mjs";

const manifestPaths = [
  "package.json",
  "apps/backend/package.json",
  "apps/frontend/package.json",
  "apps/proxy/package.json",
];

/** Creates the complete release-version source set in a private test tree. */
async function createFixture(version = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "apinteract-release-version-"));
  for (const path of manifestPaths) {
    const absolutePath = join(root, path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(
      absolutePath,
      `${JSON.stringify({ name: path, version, private: true }, null, 2)}\n`,
    );
  }
  await mkdir(join(root, "deploy/aio"), { recursive: true });
  await writeFile(
    join(root, "deploy/aio/Dockerfile"),
    `FROM scratch\nARG APINTERACT_VERSION=${version}\n`,
  );
  await writeFile(
    join(root, "deploy/aio/compose.yaml"),
    `args:\n  APINTERACT_VERSION: "\${APINTERACT_VERSION:-${version}}"\n`,
  );
  return root;
}

test("prepares and verifies every product release-version source", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const versions = await prepareReleaseVersion(root, "0.1.0-alpha1");

  assert.equal(versions.length, 6);
  assert.ok(versions.every(({ version }) => version === "0.1.0-alpha1"));
  await assert.doesNotReject(checkReleaseVersion(root, "0.1.0-alpha1"));
  assert.equal(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")).name,
    "package.json",
  );
});

test("refuses to rewrite an inconsistent starting state", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const frontendManifest = join(root, "apps/frontend/package.json");
  await writeFile(
    frontendManifest,
    `${JSON.stringify({ version: "0.1.0-beta" }, null, 2)}\n`,
  );

  await assert.rejects(
    prepareReleaseVersion(root, "0.1.0-alpha1"),
    /Refusing to rewrite inconsistent release version sources/,
  );
  assert.deepEqual(
    (await readReleaseVersions(root)).map(({ version }) => version),
    ["0.1.0", "0.1.0", "0.1.0-beta", "0.1.0", "0.1.0", "0.1.0"],
  );
});

test("accepts the project prerelease convention and rejects ambiguous forms", () => {
  for (const version of [
    "0.1.0-alpha",
    "0.1.0-alpha1",
    "0.1.0-beta",
    "0.1.0-rc2",
    "0.1.0",
  ]) {
    assert.doesNotThrow(() => validateReleaseVersion(version));
  }
  for (const version of ["01.0.0", "0.1.0-alpha.1", "0.1.0-alpha-1"]) {
    assert.throws(() => validateReleaseVersion(version));
  }
});
