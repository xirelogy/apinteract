import { readFile, writeFile } from "node:fs/promises";

/** Emits runtime JSON Schemas from the canonical proxy OpenAPI document. */
export async function generateProxyRuntimeContract(sourcePath, outputPath) {
  const document = JSON.parse(await readFile(sourcePath, "utf8"));
  const contract = {
    schemas: document.components.schemas,
    parameters: document.components.parameters,
  };
  const output = `/**
 * This file is generated from docs/proxy-api/openapi.json.
 * Do not edit it directly; the OpenAPI document is the canonical source.
 */
export const proxyRuntimeContract = ${JSON.stringify(contract, null, 2)} as const;
`;
  await writeFile(outputPath, output, "utf8");
}

if (process.argv[1] === import.meta.filename) {
  const [, , sourcePath, outputPath] = process.argv;
  if (sourcePath === undefined || outputPath === undefined) {
    throw new Error("Usage: generate-proxy-runtime-contract SOURCE OUTPUT");
  }
  await generateProxyRuntimeContract(sourcePath, outputPath);
}
