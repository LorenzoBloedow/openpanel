import dns from 'node:dns/promises';
import net from 'node:net';
import { BlockedUrlError, isBlockedIp } from './safe-fetch';

/**
 * Node-only SSRF helpers for clients whose transport we don't own (the AWS
 * SDK in the S3 export adapter). Not part of the `@openpanel/common/server`
 * barrel: the Cloudflare build doesn't ship those integrations, and Workers
 * have no private-network egress to guard (see ./safe-fetch).
 */

/** Resolve a hostname, rejecting it entirely if any address is non-public. */
async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  // WHATWG URL keeps the brackets around IPv6 literals ("[::1]").
  const host =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;

  // A bare IP in the URL never hits DNS, so check it directly.
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new BlockedUrlError(`Refusing to connect to ${host}`);
    }
    return [host];
  }

  let addresses: { address: string }[];
  try {
    // `lookup` rather than `resolve4`/`resolve6` so /etc/hosts and the system
    // resolver are honoured the same way the real connection would.
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }

  if (addresses.length === 0) {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }

  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new BlockedUrlError(
        `Refusing to connect to ${host} (resolves to a non-public address)`,
      );
    }
  }

  return addresses.map((entry) => entry.address);
}

/**
 * Guard a stored, tenant-supplied URL we are about to connect to with a
 * client we don't control the transport of. Returns every validated address,
 * or `null` when the check was skipped (self-hosted: a single tenant already
 * owns the network). The caller MUST pin its connection to one of them with
 * {@link createPinnedLookup}: validating alone is check-then-connect, and a
 * client that re-resolves the hostname can be steered elsewhere by a DNS
 * answer that flips in between (rebinding).
 */
export async function assertSafeUrlResolved(
  rawUrl: string,
): Promise<string[] | null> {
  // Compare explicitly: bare truthiness would treat SELF_HOSTED="false" as
  // self-hosted and silently drop the guard on the cloud.
  if (
    process.env.SELF_HOSTED === 'true' ||
    process.env.SELF_HOSTED === '1'
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('Only http/https URLs are allowed');
  }
  return resolvePublicAddresses(url.hostname);
}

/**
 * A `lookup` that resolves every hostname to `address`, so a socket cannot
 * end up anywhere other than the address we just validated.
 * Signature-compatible with `net.LookupFunction`; call sites cast.
 */
export function createPinnedLookup(address: string) {
  const family = net.isIPv6(address) ? 6 : 4;
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      err: null,
      addressOrList: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}
