import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";

const processIds = (await readdir("/proc")).filter((entry) =>
  /^\d+$/u.test(entry),
);
const expected = new Set(["backend/dist/main.js", "proxy/dist/main.js"]);
for (const processId of processIds) {
  try {
    const command = (
      await readFile(`/proc/${processId}/cmdline`, "utf8")
    ).replaceAll("\0", " ");
    const component = [...expected].find((name) => command.includes(name));
    if (component === undefined) {
      continue;
    }
    const process = await stat(`/proc/${processId}`);
    if (process.uid !== 10001 || process.gid !== 10001) {
      throw new Error(`${component} is not running as the APInteract account`);
    }
    expected.delete(component);
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      throw cause;
    }
  }
}
if (expected.size !== 0) {
  throw new Error(`Missing supervised processes: ${[...expected].join(", ")}`);
}
const token = await stat("/run/apinteract/proxy-bearer-token");
if (
  (token.mode & 0o777) !== 0o600 ||
  token.uid !== 10001 ||
  token.gid !== 10001
) {
  throw new Error("Generated proxy credential does not have private ownership");
}
const auditFiles = (await readdir("/data/audit")).filter((name) =>
  name.endsWith(".jsonl"),
);
if (auditFiles.length === 0) {
  throw new Error("AIO verification did not publish an audit segment");
}
for (const auditFile of auditFiles) {
  const audit = await stat(`/data/audit/${auditFile}`);
  if (
    (audit.mode & 0o777) !== 0o600 ||
    audit.uid !== 10001 ||
    audit.gid !== 10001
  ) {
    throw new Error(
      `Audit segment ${auditFile} is not privately application-owned`,
    );
  }
}
for (const sourcePath of [
  "/opt/apinteract/backend/src",
  "/opt/apinteract/backend/test",
  "/opt/apinteract/proxy/src",
  "/opt/apinteract/proxy/test",
]) {
  try {
    await access(sourcePath);
    throw new Error(`Production image contains source path ${sourcePath}`);
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      throw cause;
    }
  }
}
await access("/opt/apinteract/LICENSE");
await access("/command/s6-svc");
try {
  await writeFile("/opt/apinteract/runtime-write-check", "unexpected");
  throw new Error("The AIO root filesystem is writable");
} catch (cause) {
  if (cause?.code !== "EROFS") {
    throw cause;
  }
}
process.stdout.write(
  "AIO ownership, credential mode, runtime contents, and read-only root verified.\n",
);
