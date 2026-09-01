import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateProxyRuntimeContract } from "./generate-proxy-runtime-contract.mjs";

const root = new URL("../", import.meta.url);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "apinteract-contracts-"));

const contracts = [
  [
    "docs/backend-api/openapi.json",
    "packages/api-contracts/src/backend.generated.ts",
  ],
  [
    "docs/proxy-api/openapi.json",
    "packages/api-contracts/src/proxy.generated.ts",
  ],
];

try {
  for (const [source, generated] of contracts) {
    const output = join(temporaryDirectory, generated.split("/").at(-1));
    execFileSync("pnpm", ["exec", "openapi-typescript", source, "-o", output], {
      cwd: root,
      stdio: "inherit",
    });
    execFileSync("pnpm", ["exec", "prettier", "--write", output], {
      cwd: root,
      stdio: "inherit",
    });

    if (
      readFileSync(new URL(`../${generated}`, import.meta.url), "utf8") !==
      readFileSync(output, "utf8")
    ) {
      throw new Error(
        `${generated} is stale. Run pnpm contracts:generate and commit the result.`,
      );
    }
  }

  const runtimeOutput = join(temporaryDirectory, "proxy.runtime.generated.ts");
  await generateProxyRuntimeContract(
    new URL("../docs/proxy-api/openapi.json", import.meta.url),
    runtimeOutput,
  );
  execFileSync("pnpm", ["exec", "prettier", "--write", runtimeOutput], {
    cwd: root,
    stdio: "inherit",
  });
  if (
    readFileSync(
      new URL(
        "../apps/proxy/src/transport/proxy-runtime.generated.ts",
        import.meta.url,
      ),
      "utf8",
    ) !== readFileSync(runtimeOutput, "utf8")
  ) {
    throw new Error(
      "apps/proxy/src/transport/proxy-runtime.generated.ts is stale. Run pnpm contracts:generate and commit the result.",
    );
  }

  execFileSync(
    "pnpm",
    [
      "exec",
      "redocly",
      "lint",
      "docs/backend-api/openapi.json",
      "docs/proxy-api/openapi.json",
    ],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
