import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("generates provenance bound to the workflow, source tag, and commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apinteract-provenance-"));
  const output = join(directory, "provenance.json");
  try {
    await execute(process.execPath, [
      fileURLToPath(
        new URL("./generate-release-provenance.mjs", import.meta.url),
      ),
      output,
      "example/apinteract",
      "refs/tags/v1.2.3-rc1",
      "a".repeat(40),
      "1.2.3-rc1",
      "https://github.com/example/apinteract/actions/runs/12/attempts/1",
    ]);
    const predicate = JSON.parse(await readFile(output, "utf8"));

    assert.equal(
      predicate.builder.id,
      "https://github.com/example/apinteract/.github/workflows/publish-aio.yml@refs/tags/v1.2.3-rc1",
    );
    assert.deepEqual(predicate.invocation.parameters, { version: "1.2.3-rc1" });
    assert.deepEqual(predicate.materials, [
      {
        uri: "git+https://github.com/example/apinteract",
        digest: { sha1: "a".repeat(40) },
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
