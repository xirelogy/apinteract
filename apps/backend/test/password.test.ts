import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/foundation/password.js";

describe("local password hashing", () => {
  it("verifies the original password and rejects a different password", async () => {
    const encoded = await hashPassword("correct horse battery staple");

    await expect(
      verifyPassword("correct horse battery staple", encoded),
    ).resolves.toBe(true);
    await expect(
      verifyPassword("incorrect horse battery staple", encoded),
    ).resolves.toBe(false);
  });

  it("uses a unique salt for each encoded credential", async () => {
    const first = await hashPassword("same password value");
    const second = await hashPassword("same password value");

    expect(first).toMatch(/^scrypt\$/);
    expect(second).toMatch(/^scrypt\$/);
    expect(first).not.toBe(second);
  });

  it("rejects short passwords and unsupported encoded formats", async () => {
    await expect(hashPassword("too-short")).rejects.toThrow(
      "Password must contain at least 10 characters",
    );
    await expect(
      verifyPassword("long enough password", "unsupported$credential"),
    ).resolves.toBe(false);
  });
});
