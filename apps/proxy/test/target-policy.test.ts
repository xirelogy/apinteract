import { describe, expect, it, vi } from "vitest";

import {
  TargetPolicy,
  type TargetAddressResolver,
} from "../src/application/target-policy.js";

const lookupResult = { lookup: expect.any(Function) as unknown };

describe("TargetPolicy", () => {
  it("allows public DNS results and rejects mixed public-private answers", async () => {
    const resolver: TargetAddressResolver = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
        .mockResolvedValueOnce([
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ]),
    };
    const policy = new TargetPolicy(defaultPolicy(), resolver);

    await expect(
      policy.approve(new URL("https://example.test/")),
    ).resolves.toEqual(lookupResult);
    await expect(
      policy.approve(new URL("https://mixed.example.test/")),
    ).rejects.toMatchObject({ code: "target_policy_denied", phase: "dns" });
  });

  it("never permits loopback or link-local addresses", async () => {
    const policy = new TargetPolicy({
      privateNetworkAccess: "allow",
      allowCidrs: ["127.0.0.0/8", "169.254.0.0/16", "::1/128"],
      denyCidrs: [],
    });

    await expect(
      policy.approve(new URL("http://127.0.0.1/")),
    ).rejects.toMatchObject({ code: "target_policy_denied" });
    await expect(
      policy.approve(new URL("http://169.254.169.254/latest/meta-data/")),
    ).rejects.toMatchObject({ code: "target_policy_denied" });
    await expect(
      policy.approve(new URL("http://[::1]/")),
    ).rejects.toMatchObject({ code: "target_policy_denied" });
    await expect(
      policy.approve(new URL("http://[::ffff:7f00:1]/")),
    ).rejects.toMatchObject({ code: "target_policy_denied" });
  });

  it("allows selected private CIDRs while explicit denies retain precedence", async () => {
    const resolver: TargetAddressResolver = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce([{ address: "10.20.4.8", family: 4 }])
        .mockResolvedValueOnce([{ address: "10.20.5.8", family: 4 }]),
    };
    const policy = new TargetPolicy(
      {
        privateNetworkAccess: "deny",
        allowCidrs: ["10.20.0.0/16"],
        denyCidrs: ["10.20.5.0/24"],
      },
      resolver,
    );

    await expect(
      policy.approve(new URL("http://allowed.example.test/")),
    ).resolves.toEqual(lookupResult);
    await expect(
      policy.approve(new URL("http://denied.example.test/")),
    ).rejects.toMatchObject({ code: "target_policy_denied" });
  });

  it("allows private and unique-local destinations only in LAN mode", async () => {
    const denied = new TargetPolicy(
      defaultPolicy(),
      resolverFor("192.168.1.25", 4),
    );
    const allowed = new TargetPolicy(
      {
        privateNetworkAccess: "allow",
        allowCidrs: [],
        denyCidrs: [],
      },
      resolverFor("fd12:3456::25", 6),
    );

    await expect(
      denied.approve(new URL("http://lan.example.test/")),
    ).rejects.toMatchObject({ code: "target_policy_denied" });
    await expect(
      allowed.approve(new URL("http://lan-v6.example.test/")),
    ).resolves.toEqual(lookupResult);
  });

  it("reports resolver failure without exposing its internal message", async () => {
    const policy = new TargetPolicy(defaultPolicy(), {
      resolve: vi
        .fn()
        .mockRejectedValue(new Error("sensitive resolver detail")),
    });

    await expect(
      policy.approve(new URL("https://missing.example.test/")),
    ).rejects.toMatchObject({
      code: "dns_resolution_failed",
      message: "The target hostname could not be resolved.",
      retryable: true,
    });
  });
});

/** Returns the secure packaged target-policy default. */
function defaultPolicy() {
  return {
    privateNetworkAccess: "deny" as const,
    allowCidrs: [],
    denyCidrs: [],
  };
}

/** Returns a deterministic one-address DNS resolver. */
function resolverFor(address: string, family: 4 | 6): TargetAddressResolver {
  return { resolve: vi.fn().mockResolvedValue([{ address, family }]) };
}
