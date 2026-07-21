import { spawn } from "node:child_process";

const processes = [
  ["proxy", ["--filter", "@apinteract/proxy", "dev"]],
  ["backend", ["--filter", "@apinteract/backend", "dev"]],
  ["frontend", ["--filter", "@apinteract/frontend", "dev"]],
];

const children = processes.map(([name, arguments_]) => {
  const child = spawn("pnpm", arguments_, {
    cwd: new URL("../", import.meta.url),
    stdio: "inherit",
    env: process.env,
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      process.stderr.write(
        `${name} stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).\n`,
      );
      void stop(code ?? 1);
    }
  });
  return child;
});

let stopping = false;

async function stop(exitCode = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          child.once("exit", resolve);
          setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5000).unref();
        }),
    ),
  );
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
