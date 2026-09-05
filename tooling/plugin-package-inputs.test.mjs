import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageDefinitions = [
  {
    directory: "plugin-api",
    tagPrefix: "plugin-api-v",
    workflow: "publish-plugin-api.yml",
  },
  {
    directory: "plugin-sdk",
    tagPrefix: "plugin-sdk-v",
    workflow: "publish-plugin-sdk.yml",
  },
];
const rootManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const bootstrapWorkflow = await readFile(
  new URL(
    "../.github/workflows/initialize-plugin-package.yml",
    import.meta.url,
  ),
  "utf8",
);
const verificationWorkflow = await readFile(
  new URL("../.github/workflows/verify-plugin-packages.yml", import.meta.url),
  "utf8",
);

for (const definition of packageDefinitions) {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        `../packages/${definition.directory}/package.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const workflow = await readFile(
    new URL(`../.github/workflows/${definition.workflow}`, import.meta.url),
    "utf8",
  );

  test(`${manifest.name} is a public compiled package`, () => {
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.publishConfig?.access, "public");
    assert.equal(manifest.publishConfig?.provenance, true);
    assert.equal(
      manifest.publishConfig?.registry,
      "https://registry.npmjs.org/",
    );
    assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE"]);
    assert.match(manifest.scripts.build, /tsc -p tsconfig\.build\.json/u);
    assert.doesNotMatch(JSON.stringify(manifest.exports), /\/src\//u);
    assert.match(JSON.stringify(manifest.exports), /\/dist\//u);
  });

  test(`${manifest.name} publishes only a reusable verifier artifact`, () => {
    assert.match(workflow, new RegExp(`${definition.tagPrefix}\\*`));
    assert.match(
      workflow,
      /uses: \.\/\.github\/workflows\/verify-plugin-packages\.yml/u,
    );
    assert.match(workflow, new RegExp(`package: ${definition.directory}`));
    assert.match(workflow, /^ {2}publish:$/mu);
    assert.match(workflow, /^ {4}needs: verify$/mu);
    assert.match(workflow, /^\s*id-token: write$/m);
    assert.match(workflow, /^\s*environment: npm$/m);
    assert.equal(workflow.match(/id-token: write/gu)?.length, 1);
    assert.equal(workflow.match(/environment: npm/gu)?.length, 1);
    assert.doesNotMatch(workflow, /actions\/checkout/u);
    assert.doesNotMatch(workflow, /pnpm (?:install|check|run|--dir)/u);
    assert.match(workflow, /actions\/download-artifact@[a-f0-9]{40}/u);
    assert.match(workflow, /needs\.verify\.outputs\.artifact_name/u);
    assert.match(workflow, /needs\.verify\.outputs\.tarball_sha256/u);
    assert.match(workflow, /sha256sum --check SHA256SUMS/u);
    assert.match(workflow, /actual_sha256/u);
    assert.match(workflow, /EXPECTED_TARBALL_SHA256/u);
    assert.match(
      workflow,
      /npm view "\$\{PACKAGE_NAME\}@\$\{VERSION\}" version --registry https:\/\/registry\.npmjs\.org/u,
    );
    assert.match(
      workflow,
      /npm version already exists and will not be overwritten/u,
    );
    assert.match(workflow, /grep -Eq 'E404\|404 Not Found'/u);
    assert.match(workflow, /npm_tag="oidc"/u);
    assert.match(workflow, /npm_tag="next"/u);
    assert.match(workflow, /npm_tag="latest"/u);
    assert.match(
      workflow,
      /npm publish "\$\{TARBALL\}" --ignore-scripts --access public --tag "\$\{NPM_TAG\}" --provenance/u,
    );
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./u);
    assert.ok(
      workflow.indexOf("Download the verified package artifact") <
        workflow.indexOf("Validate the artifact, release tag, and npm tag"),
      "the downloaded artifact must be validated before publication",
    );
    assert.ok(
      workflow.indexOf("Refuse to overwrite an immutable npm version") <
        workflow.indexOf("Publish to npm with provenance"),
      "the npm existence guard must run immediately before publishing",
    );
  });
}

test("plugin package verification is reusable and unprivileged", () => {
  assert.match(verificationWorkflow, /pull_request:/u);
  assert.match(verificationWorkflow, /workflow_dispatch:/u);
  assert.match(verificationWorkflow, /workflow_call:/u);
  assert.match(verificationWorkflow, /^permissions:\n {2}contents: read$/mu);
  assert.doesNotMatch(verificationWorkflow, /id-token: write/u);
  assert.doesNotMatch(
    verificationWorkflow,
    /environment: npm|NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./u,
  );
  assert.match(verificationWorkflow, /run: pnpm install --frozen-lockfile/u);
  assert.match(verificationWorkflow, /run: pnpm check/u);
  assert.match(verificationWorkflow, /^\s+all\)$/mu);
  assert.match(verificationWorkflow, /^\s+plugin-api\)$/mu);
  assert.match(verificationWorkflow, /^\s+plugin-sdk\)$/mu);
  assert.match(
    verificationWorkflow,
    /pnpm --dir "\$\{package_directory\}" pack/u,
  );
  assert.match(
    verificationWorkflow,
    /npm publish "\$\{tarball\}" --dry-run --offline --ignore-scripts/u,
  );
  assert.match(verificationWorkflow, /--provenance=false/u);
  assert.match(verificationWorkflow, /sha256sum -- \*\.tgz > SHA256SUMS/u);
  assert.match(verificationWorkflow, /tarball_sha256=/u);
  assert.match(verificationWorkflow, /actions\/upload-artifact@[a-f0-9]{40}/u);
  assert.match(verificationWorkflow, /retention-days: 7/u);
});

test("the plugin API package has no private contract dependency", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../packages/plugin-api/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.dependencies, undefined);
});

test("the plugin SDK declares the plugin API as a compatible peer", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../packages/plugin-sdk/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.peerDependencies?.["@apinteract/plugin-api"], "^1.0.0");
});

test("repository gates exercise packed packages and contract compatibility", () => {
  assert.match(rootManifest.scripts["format:check"], /"!var\/\*\*"/u);
  assert.match(rootManifest.scripts.lint, /^pnpm plugin-tooling:build/u);
  assert.match(
    rootManifest.scripts.test,
    /^pnpm plugin-tooling:build && pnpm plugins:build/u,
  );
  assert.match(rootManifest.scripts.test, /pnpm plugin-packages:verify/u);
  assert.match(rootManifest.scripts.typecheck, /pnpm plugin-contracts:check/u);
  assert.match(rootManifest.scripts.typecheck, /pnpm plugin-tooling:build/u);
});

test("bootstrap publication is manual, token-scoped, and non-overwriting", () => {
  assert.match(bootstrapWorkflow, /workflow_dispatch:/u);
  assert.match(bootstrapWorkflow, /environment: npm-bootstrap/u);
  assert.match(bootstrapWorkflow, /secrets\.NPM_TOKEN/u);
  assert.match(
    bootstrapWorkflow,
    /npm view "\$\{PACKAGE_NAME\}@\$\{VERSION\}" version/u,
  );
  assert.match(
    bootstrapWorkflow,
    /npm version already exists and will not be overwritten/u,
  );
  assert.match(bootstrapWorkflow, /--provenance=false/u);
  assert.match(bootstrapWorkflow, /\^0\\\.\[0-9\]\+\\\.\[0-9\]\+-bootstrap/u);
  assert.match(bootstrapWorkflow, /--tag bootstrap/u);
  assert.match(bootstrapWorkflow, /npm publish [\s\S]*--access public/u);
  assert.doesNotMatch(bootstrapWorkflow, /id-token: write/u);
});
