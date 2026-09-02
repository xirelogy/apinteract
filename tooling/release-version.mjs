/**
 * Keeps APInteract product manifests and AIO image defaults on one release
 * version without changing independently versioned API or plugin contracts.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT_MANIFESTS = [
  "package.json",
  "apps/backend/package.json",
  "apps/frontend/package.json",
  "apps/proxy/package.json",
];
const AIO_DOCKERFILE = "deploy/aio/Dockerfile";
const AIO_COMPOSE_FILE = "deploy/aio/compose.yaml";
const RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:[A-Za-z][0-9A-Za-z]*|0|[1-9][0-9]*))?$/;

/** Rejects versions outside APInteract's single-identifier SemVer convention. */
export function validateReleaseVersion(version) {
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(
      "VERSION must look like 0.1.0, 0.1.0-alpha1, or 0.1.0-rc2.",
    );
  }
}

/** Returns exactly one capture from a release-version source. */
function requiredVersionMatch(contents, pattern, path) {
  const matches = [...contents.matchAll(pattern)];
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw new Error(`Expected exactly one release version in ${path}.`);
  }
  return matches[0][1];
}

/** Reads every product and AIO version source beneath one repository root. */
export async function readReleaseVersions(repositoryRoot) {
  const versions = [];
  for (const path of PRODUCT_MANIFESTS) {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, path), "utf8"),
    );
    if (typeof manifest.version !== "string") {
      throw new Error(`${path} does not declare a string version.`);
    }
    versions.push({ path, version: manifest.version });
  }

  const dockerfile = await readFile(
    join(repositoryRoot, AIO_DOCKERFILE),
    "utf8",
  );
  versions.push({
    path: AIO_DOCKERFILE,
    version: requiredVersionMatch(
      dockerfile,
      /^ARG APINTERACT_VERSION=([^\s]+)$/gm,
      AIO_DOCKERFILE,
    ),
  });

  const compose = await readFile(
    join(repositoryRoot, AIO_COMPOSE_FILE),
    "utf8",
  );
  versions.push({
    path: AIO_COMPOSE_FILE,
    version: requiredVersionMatch(
      compose,
      /APINTERACT_VERSION:-([^}]+)}/g,
      AIO_COMPOSE_FILE,
    ),
  });
  return versions;
}

/** Throws with every release-version mismatch rather than only the first. */
export async function checkReleaseVersion(repositoryRoot, expectedVersion) {
  validateReleaseVersion(expectedVersion);
  const versions = await readReleaseVersions(repositoryRoot);
  const mismatches = versions.filter(
    ({ version }) => version !== expectedVersion,
  );
  if (mismatches.length > 0) {
    const details = mismatches
      .map(({ path, version }) => `  ${path}: ${version}`)
      .join("\n");
    throw new Error(
      `Release version sources do not match ${expectedVersion}:\n${details}`,
    );
  }
  return versions;
}

/** Replaces one pattern only after confirming that it has one current match. */
function replaceVersion(contents, pattern, replacement, path) {
  requiredVersionMatch(contents, pattern, path);
  return contents.replace(pattern, replacement);
}

/**
 * Updates the complete product-version source set from one consistent prior
 * version and verifies the written result. Protocol and plugin versions are
 * deliberately outside this operation.
 */
export async function prepareReleaseVersion(repositoryRoot, targetVersion) {
  validateReleaseVersion(targetVersion);
  const currentVersions = await readReleaseVersions(repositoryRoot);
  const uniqueVersions = new Set(currentVersions.map(({ version }) => version));
  if (uniqueVersions.size !== 1) {
    const details = currentVersions
      .map(({ path, version }) => `  ${path}: ${version}`)
      .join("\n");
    throw new Error(
      `Refusing to rewrite inconsistent release version sources:\n${details}`,
    );
  }

  for (const path of PRODUCT_MANIFESTS) {
    const absolutePath = join(repositoryRoot, path);
    const manifest = JSON.parse(await readFile(absolutePath, "utf8"));
    manifest.version = targetVersion;
    await writeFile(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const dockerfilePath = join(repositoryRoot, AIO_DOCKERFILE);
  const dockerfile = await readFile(dockerfilePath, "utf8");
  await writeFile(
    dockerfilePath,
    replaceVersion(
      dockerfile,
      /^ARG APINTERACT_VERSION=([^\s]+)$/gm,
      `ARG APINTERACT_VERSION=${targetVersion}`,
      AIO_DOCKERFILE,
    ),
  );

  const composePath = join(repositoryRoot, AIO_COMPOSE_FILE);
  const compose = await readFile(composePath, "utf8");
  await writeFile(
    composePath,
    replaceVersion(
      compose,
      /APINTERACT_VERSION:-([^}]+)}/g,
      `APINTERACT_VERSION:-${targetVersion}}`,
      AIO_COMPOSE_FILE,
    ),
  );

  return checkReleaseVersion(repositoryRoot, targetVersion);
}

/** Runs the release-version helper as a strict command-line tool. */
async function main() {
  const [, , command, version] = process.argv;
  if ((command !== "check" && command !== "prepare") || version === undefined) {
    throw new Error(
      "Usage: node tooling/release-version.mjs <check|prepare> VERSION",
    );
  }
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const versions =
    command === "prepare"
      ? await prepareReleaseVersion(repositoryRoot, version)
      : await checkReleaseVersion(repositoryRoot, version);
  process.stdout.write(
    `${command === "prepare" ? "Prepared" : "Verified"} ${version} in:\n${versions
      .map(({ path }) => `  ${path}`)
      .join("\n")}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
