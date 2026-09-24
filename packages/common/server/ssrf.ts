import { assertPublicUrl } from './safe-fetch';

/**
 * Guard a stored, tenant-supplied URL before connecting to it. When the
 * request goes through `fetch`, prefer `safeFetch` from `./safe-fetch`: it
 * also re-checks every redirect hop.
 *
 * Returns the validated IP literal (if the host is one), or `null` when the
 * check was skipped.
 *
 * Skipped on self-hosted deployments: there's a single tenant who already
 * controls the network. The guard exists to stop cross-tenant SSRF on the
 * managed/multi-tenant cloud.
 */
export async function assertSafeUrl(rawUrl: string): Promise<string[] | null> {
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

  return assertPublicUrl(url);
}
