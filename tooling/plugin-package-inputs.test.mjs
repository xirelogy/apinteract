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

  test(`${manifest.name} has an independent trusted-publishing workflow`, () => {
    assert.match(workflow, new RegExp(`${definition.tagPrefix}\\*`));
    assert.match(workflow, /^\s*id-token: write$/m);
    assert.match(workflow, /^\s*environment: npm$/m);
    assert.match(
      workflow,
      /npm view "\$\{PACKAGE_NAME\}@\$\{VERSION\}" version --registry https:\/\/registry\.npmjs\.org/u,
    );
    assert.match(
      workflow,
      /npm version already exists and will not be overwritten/u,
    );
    assert.match(workflow, /grep -Eq 'E404\|404 Not Found'/u);
    assert.match(workflow, /run: pnpm check/);
    assert.match(workflow, /pnpm --dir packages\//);
    assert.match(workflow, /npm_tag="oidc"/u);
    assert.match(workflow, /npm_tag="next"/u);
    assert.match(workflow, /npm_tag="latest"/u);
    assert.match(
      workflow,
      /npm publish .* --access public --tag "\$\{NPM_TAG\}" --provenance/u,
    );
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./u);
    assert.ok(
      workflow.indexOf("Refuse to overwrite an immutable npm version") >
        workflow.indexOf("Pack the verified package"),
      "the npm existence guard must run after packing the verified package",
    );
    assert.ok(
      workflow.indexOf("Refuse to overwrite an immutable npm version") <
        workflow.indexOf("Publish to npm with provenance"),
      "the npm existence guard must run immediately before publishing",
    );
  });
}

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
  assert.match(rootManifest.scripts.lint, /^pnpm plugin-tooling:build/u);
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
