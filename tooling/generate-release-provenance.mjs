import { writeFile } from "node:fs/promises";

/**
 * Writes the SLSA v0.2 predicate attached to one tag-triggered AIO build.
 *
 * Cosign supplies the immutable image subject when it wraps this predicate in
 * an in-toto statement. GitHub identity and source coordinates remain explicit
 * here so verification can bind the artifact to the release workflow and tag.
 */
async function main() {
  const [outputPath, repository, ref, commit, version, invocationId] =
    process.argv.slice(2);
  if (
    [outputPath, repository, ref, commit, version, invocationId].some(
      (value) => value === undefined || value.length === 0,
    )
  ) {
    throw new Error(
      "Usage: generate-release-provenance.mjs OUTPUT REPOSITORY REF COMMIT VERSION INVOCATION_ID",
    );
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("REPOSITORY must be a GitHub owner/repository pair");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+)?$/.test(version)) {
    throw new Error("VERSION is not an APInteract release version");
  }
  if (ref !== `refs/tags/v${version}`) {
    throw new Error("REF must be the tag for VERSION");
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("COMMIT must be a full Git commit SHA");
  }
  const invocationUrl = new URL(invocationId);
  if (invocationUrl.protocol !== "https:") {
    throw new Error("INVOCATION_ID must be an HTTPS URL");
  }

  const sourceUri = `git+https://github.com/${repository}`;
  const workflowUri = `https://github.com/${repository}/.github/workflows/publish-aio.yml@${ref}`;
  const predicate = {
    builder: { id: workflowUri },
    buildType: "https://github.com/Attestations/GitHubActionsWorkflow@v1",
    invocation: {
      configSource: {
        uri: sourceUri,
        digest: { sha1: commit },
        entryPoint: ".github/workflows/publish-aio.yml",
      },
      parameters: { version },
      environment: { ref },
    },
    metadata: {
      buildInvocationId: invocationId,
      completeness: {
        parameters: true,
        environment: false,
        materials: true,
      },
      reproducible: false,
    },
    materials: [{ uri: sourceUri, digest: { sha1: commit } }],
  };
  await writeFile(outputPath, `${JSON.stringify(predicate, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

await main();
