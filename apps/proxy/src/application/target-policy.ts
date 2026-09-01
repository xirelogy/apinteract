import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";

import type { ProxyTargetPolicyConfiguration } from "../config.js";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** DNS boundary used to make address-policy behavior deterministic in tests. */
export interface TargetAddressResolver {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
}

export interface ApprovedTarget {
  readonly lookup: LookupFunction;
}

/** Boundary consumed by execution orchestration after URL materialization. */
export interface TargetApprover {
  approve(url: URL): Promise<ApprovedTarget>;
}

/** A safe target failure that can be exposed through the proxy stream contract. */
export class TargetResolutionError extends Error {
  readonly code: "dns_resolution_failed" | "target_policy_denied";
  readonly phase = "dns" as const;
  readonly retryable: boolean;

  constructor(
    code: TargetResolutionError["code"],
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const HARD_DENIED_IPV4 = Object.freeze([
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
]);
const HARD_DENIED_IPV6 = Object.freeze([
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/32",
  "2001:2::/48",
  "2001:10::/28",
  "2001:20::/28",
  "2001:db8::/32",
  "2002::/16",
  "fe80::/10",
  "ff00::/8",
]);
const PRIVATE_IPV4 = Object.freeze([
  "10.0.0.0/8",
  "100.64.0.0/10",
  "172.16.0.0/12",
  "192.168.0.0/16",
]);
const PRIVATE_IPV6 = Object.freeze(["fc00::/7"]);

/** Uses the operating-system resolver and returns every candidate address. */
class SystemTargetAddressResolver implements TargetAddressResolver {
  /** Resolves all A and AAAA answers without allowing the HTTP client to re-resolve. */
  async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    }));
  }
}

/**
 * Resolves and authorizes outbound targets before socket creation.
 *
 * Hard-denied non-unicast, loopback, and link-local ranges cannot be enabled by
 * administrator rules. Explicit deny rules then override explicit allows, and
 * the private-network mode controls remaining RFC-private candidates. Every DNS
 * answer must pass so fallback order cannot cross the policy boundary.
 */
export class TargetPolicy implements TargetApprover {
  readonly #configuration: ProxyTargetPolicyConfiguration;
  readonly #resolver: TargetAddressResolver;
  readonly #hardDenied = cidrBlockList([
    ...HARD_DENIED_IPV4,
    ...HARD_DENIED_IPV6,
  ]);
  readonly #private = cidrBlockList([...PRIVATE_IPV4, ...PRIVATE_IPV6]);
  readonly #allowed: BlockList;
  readonly #denied: BlockList;

  constructor(
    configuration: ProxyTargetPolicyConfiguration,
    resolver: TargetAddressResolver = new SystemTargetAddressResolver(),
  ) {
    this.#configuration = configuration;
    this.#resolver = resolver;
    this.#allowed = cidrBlockList(configuration.allowCidrs);
    this.#denied = cidrBlockList(configuration.denyCidrs);
  }

  /** Resolves, authorizes, and pins one final HTTP or HTTPS target. */
  async approve(url: URL): Promise<ApprovedTarget> {
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      throw new TargetResolutionError(
        "target_policy_denied",
        "The target URL is not permitted by outbound policy.",
        false,
      );
    }

    const hostname = unbracketHostname(url.hostname);
    const literalFamily = isIP(hostname);
    let candidates: readonly ResolvedAddress[];
    try {
      candidates =
        literalFamily === 0
          ? await this.#resolver.resolve(hostname)
          : [{ address: hostname, family: literalFamily as 4 | 6 }];
    } catch {
      throw new TargetResolutionError(
        "dns_resolution_failed",
        "The target hostname could not be resolved.",
        true,
      );
    }
    const normalized = uniqueAddresses(candidates);
    if (normalized.length === 0) {
      throw new TargetResolutionError(
        "dns_resolution_failed",
        "The target hostname did not resolve to an IP address.",
        true,
      );
    }
    if (normalized.some((candidate) => !this.#permits(candidate))) {
      throw new TargetResolutionError(
        "target_policy_denied",
        "The resolved target address is denied by outbound policy.",
        false,
      );
    }
    return { lookup: pinnedLookup(normalized[0] as ResolvedAddress) };
  }

  /** Applies hard-deny, administrator, and private-network precedence. */
  #permits(candidate: ResolvedAddress): boolean {
    const family = candidate.family === 4 ? "ipv4" : "ipv6";
    if (
      this.#hardDenied.check(candidate.address, family) ||
      this.#denied.check(candidate.address, family)
    ) {
      return false;
    }
    if (this.#allowed.check(candidate.address, family)) {
      return true;
    }
    return !(
      this.#private.check(candidate.address, family) &&
      this.#configuration.privateNetworkAccess === "deny"
    );
  }
}

/** Builds one address matcher from already validated configuration CIDRs. */
function cidrBlockList(cidrs: readonly string[]): BlockList {
  const blockList = new BlockList();
  for (const cidr of cidrs) {
    const separator = cidr.lastIndexOf("/");
    const address = cidr.slice(0, separator);
    const prefix = Number(cidr.slice(separator + 1));
    blockList.addSubnet(address, prefix, isIP(address) === 4 ? "ipv4" : "ipv6");
  }
  return blockList;
}

/** Removes URL brackets from an IPv6 hostname before address classification. */
function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** Rejects malformed resolver output and removes duplicate addresses. */
function uniqueAddresses(
  candidates: readonly ResolvedAddress[],
): readonly ResolvedAddress[] {
  const unique = new Map<string, ResolvedAddress>();
  for (const candidate of candidates) {
    const family = isIP(candidate.address);
    if (family !== candidate.family) {
      continue;
    }
    unique.set(`${candidate.family}:${candidate.address}`, candidate);
  }
  return [...unique.values()];
}

/** Supplies the approved address directly so the HTTP client cannot re-resolve it. */
function pinnedLookup(candidate: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [candidate]);
      return;
    }
    callback(null, candidate.address, candidate.family);
  };
}
