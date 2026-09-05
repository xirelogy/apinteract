import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const packageDefinitions = [
  {
    directory: "packages/plugin-api",
    name: "@apinteract/plugin-api",
  },
  {
    directory: "packages/plugin-sdk",
    name: "@apinteract/plugin-sdk",
  },
];

/** Runs one bounded verification command and forwards its diagnostic output. */
async function run(command, arguments_, cwd, quiet = false) {
  try {
    const result = await execFileAsync(command, arguments_, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!quiet && result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.stdout;
  } catch (cause) {
    if (cause.stdout) process.stdout.write(String(cause.stdout));
    if (cause.stderr) process.stderr.write(String(cause.stderr));
    throw cause;
  }
}

/** Writes a UTF-8 fixture below the isolated consumer project. */
async function writeFixture(projectRoot, relativePath, content) {
  const destination = join(projectRoot, relativePath);
  await writeFile(destination, content, "utf8");
}

/** Returns the one tarball produced for the requested public package. */
async function findTarball(packDirectory, packageName) {
  const stem = `${packageName.replace("@", "").replace("/", "-")}-`;
  const matches = (await readdir(packDirectory)).filter(
    (entry) => entry.startsWith(stem) && entry.endsWith(".tgz"),
  );
  assert.equal(
    matches.length,
    1,
    `Expected one packed tarball for ${packageName}`,
  );
  return join(packDirectory, matches[0]);
}

/** Verifies that one packed manifest and archive expose only publishable files. */
async function inspectTarball(archive, expectedName) {
  const listing = (await run("tar", ["-tzf", archive], repositoryRoot, true))
    .trim()
    .split("\n");
  const manifest = JSON.parse(
    await run(
      "tar",
      ["-xOf", archive, "package/package.json"],
      repositoryRoot,
      true,
    ),
  );

  assert.equal(manifest.name, expectedName);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.provenance, true);
  assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org/");
  assert.doesNotMatch(JSON.stringify(manifest), /workspace:/u);
  assert.ok(listing.includes("package/LICENSE"));
  assert.ok(listing.includes("package/README.md"));
  assert.ok(listing.some((entry) => entry.endsWith(".d.ts")));
  assert.ok(listing.some((entry) => entry.endsWith(".js")));
  assert.ok(
    listing.every(
      (entry) =>
        entry === "package/LICENSE" ||
        entry === "package/README.md" ||
        entry === "package/package.json" ||
        entry.startsWith("package/dist/"),
    ),
    `${expectedName} contains files outside its public distribution`,
  );

  for (const exported of Object.values(manifest.exports)) {
    for (const target of Object.values(exported)) {
      assert.ok(
        listing.includes(`package/${target.replace(/^\.\//u, "")}`),
        `${expectedName} export ${target} is absent from its tarball`,
      );
    }
  }
  return manifest;
}

/** Materializes a plugin project that has no access to monorepo workspace links. */
async function createExternalConsumer(projectRoot, tarballs) {
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFixture(
    projectRoot,
    "package.json",
    `${JSON.stringify(
      {
        name: "apinteract-external-plugin-verification",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@8.15.0",
        scripts: {
          typecheck: "tsc --noEmit",
          "build:frontend": "vite build --config vite.frontend.config.mjs",
          "build:backend": "vite build --config vite.backend.config.mjs",
        },
        dependencies: {
          "@apinteract/plugin-api": `file:${tarballs.api}`,
          "@apinteract/plugin-sdk": `file:${tarballs.sdk}`,
        },
        devDependencies: {
          typescript: "5.9.3",
          vite: "7.3.6",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFixture(
    projectRoot,
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          isolatedModules: true,
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2023",
          verbatimModuleSyntax: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFixture(
    projectRoot,
    "vite.frontend.config.mjs",
    `import { defineConfig } from "vite";\n\nexport default defineConfig({\n  build: {\n    lib: { entry: "src/frontend.ts", formats: ["es"], fileName: () => "index.mjs" },\n    outDir: "dist/frontend",\n  },\n});\n`,
  );
  await writeFixture(
    projectRoot,
    "vite.backend.config.mjs",
    `import { defineConfig } from "vite";\n\nexport default defineConfig({\n  build: {\n    target: "node22",\n    lib: { entry: "src/backend.ts", formats: ["es"], fileName: () => "index.mjs" },\n    outDir: "dist/backend",\n    rollupOptions: { external: [/^node:/u] },\n  },\n});\n`,
  );
  await writeFixture(
    projectRoot,
    "src/frontend.ts",
    `import type { EnabledPlugin, PluginPackageManifest, PluginRegistrationContext, PluginTarget } from "@apinteract/plugin-api";\nimport type { FrontendPluginProviders } from "@apinteract/plugin-api/frontend";\nimport { localize } from "@apinteract/plugin-sdk/frontend/localization";\n\nexport function manifestEntrypoint(manifest: PluginPackageManifest): string {\n  return manifest.entrypoint;\n}\n\nexport function enabledPluginTarget(plugin: EnabledPlugin): PluginTarget {\n  return plugin.target;\n}\n\nexport function register(context: PluginRegistrationContext<FrontendPluginProviders>): void {\n  context.register("response.content", {\n    id: "external-text",\n    label: { default: localize("Text", {}, "en") },\n    mediaTypes: ["text/plain"],\n    isAvailable: ({ execution }) => execution.bodyPreview !== undefined,\n    mountView(container, initial) {\n      const output = document.createElement("pre");\n      const render = (current: typeof initial): void => {\n        output.textContent = current.execution.bodyPreview ?? "";\n      };\n      container.append(output);\n      render(initial);\n      return { update: render, destroy: () => output.remove() };\n    },\n  });\n}\n`,
  );
  await writeFixture(
    projectRoot,
    "src/backend.ts",
    `import type { PluginRegistrationContext } from "@apinteract/plugin-api";\nimport type { BackendPluginProviders } from "@apinteract/plugin-api/backend";\nimport { parseJsonObject } from "@apinteract/plugin-sdk/backend/import";\n\nexport function register(context: PluginRegistrationContext<BackendPluginProviders>): void {\n  context.register("request.import", {\n    manifest: {\n      id: "external.json", version: "1.0.0", label: "JSON",\n      acceptedExtensions: [".json"], acceptedMediaTypes: ["application/json"], inputKinds: ["file"],\n      capabilities: { multipleRequests: false, hierarchy: false, attachments: false, capturedResponses: false, responseExamples: false, variables: false },\n    },\n    probe: () => ({ confidence: 1, reason: "Fixture" }),\n    parse(source) {\n      parseJsonObject(source);\n      return { schemaVersion: 1, providerId: "external.json", providerVersion: "1.0.0", sourceName: source.name, suggestedName: "Imported", description: "", notes: "", pathPrefix: "", variables: [], collections: [], requests: [], diagnostics: [] };\n    },\n  });\n}\n`,
  );
  await writeFixture(
    projectRoot,
    "validate.mjs",
    `import assert from "node:assert/strict";\nimport { PLUGIN_API_VERSION, PLUGIN_MANIFEST_SCHEMA_VERSION } from "@apinteract/plugin-api";\nimport { register as registerFrontend } from "./dist/frontend/index.mjs";\nimport { register as registerBackend } from "./dist/backend/index.mjs";\n\nassert.equal(PLUGIN_API_VERSION, 1);\nassert.equal(PLUGIN_MANIFEST_SCHEMA_VERSION, 1);\nfor (const register of [registerFrontend, registerBackend]) {\n  const providers = [];\n  register({ register: (provider) => providers.push(provider) });\n  assert.equal(providers.length, 1);\n}\n`,
  );
}

/** Rejects bundles that retain monorepo-only APInteract runtime imports. */
async function inspectConsumerBundles(projectRoot) {
  for (const target of ["frontend", "backend"]) {
    const bundle = await readFile(
      join(projectRoot, "dist", target, "index.mjs"),
      "utf8",
    );
    assert.doesNotMatch(bundle, /(?:from\s*|import\s*\()["']@apinteract\//u);
  }
}

/** Packs, installs, type-checks, bundles, and loads the public plugin packages. */
async function verifyPluginPackages() {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "apinteract-plugin-packages-"),
  );
  const packDirectory = join(temporaryRoot, "packs");
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerRoot, { recursive: true });
  let succeeded = false;

  try {
    for (const definition of packageDefinitions) {
      await run(
        "pnpm",
        [
          "--dir",
          definition.directory,
          "pack",
          "--pack-destination",
          packDirectory,
        ],
        repositoryRoot,
      );
    }
    const apiTarball = await findTarball(
      packDirectory,
      "@apinteract/plugin-api",
    );
    const sdkTarball = await findTarball(
      packDirectory,
      "@apinteract/plugin-sdk",
    );
    const apiManifest = await inspectTarball(
      apiTarball,
      "@apinteract/plugin-api",
    );
    const sdkManifest = await inspectTarball(
      sdkTarball,
      "@apinteract/plugin-sdk",
    );
    assert.equal(apiManifest.dependencies, undefined);
    assert.equal(
      sdkManifest.peerDependencies?.["@apinteract/plugin-api"],
      "^1.0.0",
    );

    await createExternalConsumer(consumerRoot, {
      api: apiTarball,
      sdk: sdkTarball,
    });
    await run(
      "pnpm",
      [
        "install",
        "--prefer-offline",
        "--ignore-scripts",
        "--no-frozen-lockfile",
        "--reporter=append-only",
      ],
      consumerRoot,
    );
    await run("pnpm", ["typecheck"], consumerRoot);
    await run("pnpm", ["build:frontend"], consumerRoot);
    await run("pnpm", ["build:backend"], consumerRoot);
    await inspectConsumerBundles(consumerRoot);
    await run("node", ["validate.mjs"], consumerRoot);
    process.stdout.write(
      "Verified packed plugin packages with an isolated external consumer.\n",
    );
    succeeded = true;
  } finally {
    if (succeeded) {
      await rm(temporaryRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(
        `Plugin package verification files remain at ${temporaryRoot}.\n`,
      );
    }
  }
}

await verifyPluginPackages();
