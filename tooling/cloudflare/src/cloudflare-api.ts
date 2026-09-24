/**
 * A small client for the Cloudflare REST API (v4) — just what setup needs.
 * Authenticates with an API token (CLOUDFLARE_API_TOKEN) scoped to one
 * account (CLOUDFLARE_ACCOUNT_ID).
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
  result_info?: { page?: number; total_pages?: number };
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(message);
  }
}

export class CloudflareApi {
  constructor(
    readonly accountId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** `path` is relative to /accounts/{account_id}. */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ result: T; resultInfo?: Envelope<T>['result_info'] }> {
    const url = `${API_BASE}/accounts/${this.accountId}${path}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let envelope: Envelope<T> | undefined;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      envelope = undefined;
    }
    if (!(response.ok && envelope?.success)) {
      const messages = envelope?.errors?.map((error) => `${error.message} (${error.code})`);
      throw new CloudflareApiError(
        `${method} ${path}: ${response.status} ${messages?.join('; ') || text.slice(0, 300)}`,
        response.status,
        envelope?.errors?.map((error) => error.code) ?? [],
      );
    }
    return { result: envelope.result, resultInfo: envelope.result_info };
  }

  /** Every page of a paginated list endpoint. */
  async list<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ ...params, page: String(page), per_page: '100' });
      const { result, resultInfo } = await this.request<T[]>('GET', `${path}?${query}`);
      items.push(...result);
      if (!resultInfo?.total_pages || page >= resultInfo.total_pages || result.length === 0) {
        return items;
      }
    }
  }
}

export function apiFromEnv(env = process.env, fetchImpl?: typeof fetch): CloudflareApi {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!(accountId && token)) {
    throw new Error(
      'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (see tooling/cloudflare/DEPLOY.md for the token permissions)',
    );
  }
  return new CloudflareApi(accountId, token, fetchImpl);
}
