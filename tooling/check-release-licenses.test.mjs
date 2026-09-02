import assert from "node:assert/strict";
import test from "node:test";

import { findUnapprovedPackages } from "./check-release-licenses.mjs";

const policy = {
  allowedLicenseExpressions: ["MIT"],
  packageExceptions: {
    "legacy-license@1.0.0": "BSD",
  },
};

test("accepts reviewed license expressions and exact package exceptions", () => {
  assert.deepEqual(
    findUnapprovedPackages(policy, {
      MIT: [{ name: "permissive", version: "2.0.0", license: "MIT" }],
      BSD: [{ name: "legacy-license", version: "1.0.0", license: "BSD" }],
    }),
    [],
  );
});

test("fails closed for new expressions and upgraded package exceptions", () => {
  assert.deepEqual(
    findUnapprovedPackages(policy, {
      "GPL-3.0-only": [
        {
          name: "new-license",
          version: "1.0.0",
          license: "GPL-3.0-only",
        },
      ],
      BSD: [{ name: "legacy-license", version: "1.0.1", license: "BSD" }],
    }),
    [
      { identity: "legacy-license@1.0.1", expression: "BSD" },
      { identity: "new-license@1.0.0", expression: "GPL-3.0-only" },
    ],
  );
});
