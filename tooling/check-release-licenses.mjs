/**
 * Enforces the reviewed release-license policy against pnpm's dependency
 * inventory. New license expressions fail closed until a maintainer reviews
 * and records them in the policy.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Returns parsed JSON from one required filesystem path. */
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Returns a stable package identity for a pnpm license entry. */
function packageIdentity(packageEntry) {
  return `${packageEntry.name}@${packageEntry.version}`;
}

/** Validates the shape needed from the checked-in release policy. */
function validatePolicy(policy) {
  if (
    !Array.isArray(policy.allowedLicenseExpressions) ||
    policy.allowedLicenseExpressions.some(
      (expression) => typeof expression !== "string" || expression.length === 0,
    ) ||
    policy.packageExceptions === null ||
    typeof policy.packageExceptions !== "object" ||
    Array.isArray(policy.packageExceptions)
  ) {
    throw new Error("The release license policy has an invalid shape.");
  }
}

/**
 * Returns packages whose reported license has not been explicitly reviewed.
 * A package exception is intentionally scoped to both name and version so an
 * upgrade cannot inherit an ambiguous-license approval silently.
 */
export function findUnapprovedPackages(policy, inventory) {
  validatePolicy(policy);
  const allowed = new Set(policy.allowedLicenseExpressions);
  const failures = [];

  for (const [expression, packages] of Object.entries(inventory)) {
    if (!Array.isArray(packages)) {
      throw new Error(`License inventory entry ${expression} is not an array.`);
    }
    for (const packageEntry of packages) {
      if (
        typeof packageEntry.name !== "string" ||
        typeof packageEntry.version !== "string" ||
        packageEntry.license !== expression
      ) {
        throw new Error(`License inventory entry ${expression} is malformed.`);
      }
      const identity = packageIdentity(packageEntry);
      if (
        !allowed.has(expression) &&
        policy.packageExceptions[identity] !== expression
      ) {
        failures.push({ identity, expression });
      }
    }
  }

  return failures.sort((left, right) =>
    left.identity.localeCompare(right.identity),
  );
}

/** Checks one pnpm license report and prints a concise policy result. */
export async function checkReleaseLicenses(policyPath, inventoryPath) {
  const [policy, inventory] = await Promise.all([
    readJson(policyPath),
    readJson(inventoryPath),
  ]);
  const failures = findUnapprovedPackages(policy, inventory);
  if (failures.length > 0) {
    const details = failures
      .map(({ identity, expression }) => `  ${identity}: ${expression}`)
      .join("\n");
    throw new Error(
      `Unapproved dependency licenses were found:\n${details}\nReview them before updating deploy/release/license-policy.json.`,
    );
  }

  const packageCount = Object.values(inventory).reduce(
    (count, packages) => count + packages.length,
    0,
  );
  process.stdout.write(
    `Release license policy accepted ${packageCount} dependency entries.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , policyPath, inventoryPath] = process.argv;
  if (policyPath === undefined || inventoryPath === undefined) {
    process.stderr.write(
      "Usage: node tooling/check-release-licenses.mjs POLICY INVENTORY\n",
    );
    process.exitCode = 2;
  } else {
    await checkReleaseLicenses(policyPath, inventoryPath).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
