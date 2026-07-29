#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";

import { createApplication } from "./bootstrap/application.js";
import { loadBackendConfiguration } from "./config.js";
import { InstanceAlreadyInitializedError } from "./identity/identity-service.js";

const [area, command, ...commandArguments] = process.argv.slice(2);
if (area !== "admin" || (command !== "init" && command !== "reset-password")) {
  process.stderr.write(
    "Usage: apinteract admin init [--username NAME] [--display-name NAME] [--config PATH]\n" +
      "       apinteract admin reset-password --user NAME [--config PATH]\n",
  );
  process.exitCode = 2;
} else {
  const { values } = parseArgs({
    args: commandArguments,
    options: {
      config: { type: "string", default: "/etc/apinteract/backend.yaml" },
      username: { type: "string", default: "admin" },
      "display-name": { type: "string", default: "Administrator" },
      user: { type: "string" },
    },
  });
  const password = await readPassword();
  const configuration = await loadBackendConfiguration(values.config);
  const application = await createApplication(configuration);
  try {
    if (command === "init") {
      try {
        const user = await application.identity.initializeAdministrator(
          values.username,
          values["display-name"],
          password,
        );
        await application.audit.publishPending();
        stdout.write(`Initialized administrator ${user.username}.\n`);
      } catch (cause) {
        if (!(cause instanceof InstanceAlreadyInitializedError)) {
          throw cause;
        }
        // Re-running deployment initialization must not replace credentials or
        // turn an already healthy instance into a failed rollout.
        stdout.write("APInteract is already initialized.\n");
      }
    } else {
      if (values.user === undefined) {
        throw new Error("--user is required for reset-password");
      }
      await application.identity.resetPassword(values.user, password);
      await application.audit.publishPending();
      stdout.write(`Reset password for ${values.user}.\n`);
    }
  } finally {
    await application.close();
  }
}

/** Reads a password from the terminal without echoing its characters. */
async function readPassword(): Promise<string> {
  const input = stdin as unknown as AsyncIterable<Uint8Array>;
  if (!stdin.isTTY) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8").trimEnd();
  }

  try {
    // readline does not expose a portable masked prompt, so terminal echo is
    // disabled while the secret is collected.
    stdin.setRawMode?.(true);
    stdout.write("Password: ");
    let password = "";
    for await (const chunk of input) {
      const text = Buffer.from(chunk).toString("utf8");
      if (text === "\r" || text === "\n") {
        stdout.write("\n");
        return password;
      }
      if (text === "\u0003") {
        throw new Error("Password input cancelled");
      }
      if (text === "\u007f") {
        password = password.slice(0, -1);
      } else {
        password += text;
      }
    }
    return password;
  } finally {
    stdin.setRawMode?.(false);
  }
}
