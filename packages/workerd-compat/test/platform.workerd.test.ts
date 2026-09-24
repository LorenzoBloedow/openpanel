import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { NATIVE_ARGON2_VECTORS } from '@openpanel/auth/src/argon2.vectors';
import { hashPassword, verifyPasswordHash } from '@openpanel/auth/src/password';
import { generateQrDataUrl } from '@openpanel/auth/src/totp';
import {
  createHash,
  decrypt,
  decryptCredential,
  encrypt,
  encryptCredential,
  uuidv7,
  uuidv7Timestamp,
  verifyPassword,
} from '@openpanel/common/server';
import {
  BlockedUrlError,
  assertPublicUrl,
} from '@openpanel/common/server/safe-fetch';
import { templates } from '@openpanel/email/src/emails';
import { renderTemplate } from '@openpanel/email/src/render';
import { getGeoLocation } from '@openpanel/geo';
import {
  getServerIntegration,
  redactConfigSecrets,
} from '@openpanel/integrations/src/registry';
import { createLogger } from '@openpanel/logger';
import { FREE_PRODUCT_IDS, getProducts } from '@openpanel/payments';
import { cacheable } from '@openpanel/redis';
import {
  FeatureUnavailableError,
  getEnv,
  isFeatureAvailable,
  isWorkerd,
  runWithScope,
} from '@openpanel/runtime';

// Made in Node with ENCRYPTION_KEY=0f…0f (see wrangler.jsonc).
const NODE_VECTORS = {
  encrypt: {
    plaintext: 'totp-secret ✓ ünïcode',
    ciphertext: 'HrSYAVJ3AL8kKxOiGx0nm17FynctJTuRF1O6QpIdsbapoSkgP0j6QJRzuXQBSX2HjGbnvdY=',
  },
  encryptCredential: {
    plaintext: 'AKIA/secret+key',
    ciphertext: 'enc:8iPut0yZanY/Em5/rK+9/b03qQVGnWpP0pTyde9/F8aYKzYmLRPDRPULIA==',
  },
  scrypt: {
    password: 'sec_abc123',
    hash: '6fbeab7e2566ad32258c7a015458fe50.12ce9b2ac0e0a9597f98e01025ef305add7d9140f96d2d531e8d0336a225947b',
  },
  shake256: [
    { input: 'ua|1.2.3.4|salt', length: 16, hex: '25d2add7f6e985861752fce8d9565260' },
    { input: '', length: 16, hex: '46b9dd2b0ba88d13233b3feb743eeb24' },
    {
      input: 'ünïcode 🔑',
      length: 32,
      hex: '79b8ab7cfa882e589fd9e6d420edbf31d6ba3c281b6155bc5256663b840f7458',
    },
  ],
};

// The two templates without react-email PreviewProps.
const PREVIEW_DATA: Record<string, unknown> = {
  invite: { url: 'https://dashboard.example.com/invite/abc', organizationName: 'Acme' },
  'reset-password': { url: 'https://dashboard.example.com/reset/abc' },
};

describe('runtime', () => {
  it('runs inside workerd', () => {
    expect(isWorkerd()).toBe(true);
    expect(isFeatureAvailable('ai')).toBe(false);
  });

  it('exposes the Worker env through the scope', async () => {
    const value = await runWithScope({ env, route: 'hyperdrive' }, async () =>
      getEnv<{ SELF_HOSTED: string }>().SELF_HOSTED,
    );
    expect(value).toBe('true');
  });
});

describe('argon2 (static WebAssembly)', () => {
  it('verifies hashes written by @node-rs/argon2', async () => {
    for (const { password, hash } of NATIVE_ARGON2_VECTORS) {
      expect(await verifyPasswordHash(hash, password)).toBe(true);
      expect(await verifyPasswordHash(hash, `${password}x`)).toBe(false);
    }
  });

  it('hashes and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPasswordHash(hash, 'correct horse battery staple')).toBe(true);
  });
});

describe('node:crypto parity', () => {
  it('decrypts ciphertext made in Node', () => {
    expect(decrypt(NODE_VECTORS.encrypt.ciphertext)).toBe(NODE_VECTORS.encrypt.plaintext);
    expect(decryptCredential(NODE_VECTORS.encryptCredential.ciphertext)).toBe(
      NODE_VECTORS.encryptCredential.plaintext,
    );
  });

  it('round-trips encryption', () => {
    expect(decrypt(encrypt('hello'))).toBe('hello');
    expect(decryptCredential(encryptCredential('hello'))).toBe('hello');
  });

  it('verifies scrypt client secrets hashed in Node', async () => {
    const { password, hash } = NODE_VECTORS.scrypt;
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(`${password}x`, hash)).toBe(false);
  });

  it('derives the same shake256 device ids', () => {
    for (const { input, length, hex } of NODE_VECTORS.shake256) {
      expect(createHash(input, length)).toBe(hex);
    }
  });

  it('mints UUIDv7 ids', () => {
    const id = uuidv7(1_700_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7Timestamp(id)).toBe(1_700_000_000_000);
  });
});

describe('email', () => {
  it('renders every template', async () => {
    for (const [key, template] of Object.entries(templates)) {
      const preview =
        PREVIEW_DATA[key] ??
        (template.Component as { PreviewProps?: unknown }).PreviewProps;
      const props = template.schema.parse(preview);
      const rendered = await renderTemplate(key as keyof typeof templates, props as never);
      expect(rendered.subject.length, key).toBeGreaterThan(0);
      expect(rendered.html, key).toContain('<html');
      expect(rendered.text.length, key).toBeGreaterThan(0);
    }
  });
});

describe('platform packages', () => {
  it('renders TOTP QR codes as SVG data URLs', async () => {
    const url = await generateQrDataUrl('otpauth://totp/OpenPanel:a@example.com?secret=JBSWY3DPEHPK3PXP');
    expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('refuses private IP literals', async () => {
    await expect(assertPublicUrl(new URL('http://127.0.0.1/'))).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(
      assertPublicUrl(new URL('http://[::ffff:169.254.169.254]/')),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertPublicUrl(new URL('https://example.com/'))).resolves.toEqual([]);
  });

  it('geolocates from request.cf', async () => {
    const geo = await getGeoLocation('203.0.113.7', {
      cf: { country: 'SE', city: 'Stockholm' },
      connectingIp: '203.0.113.7',
    });
    expect(geo.country).toBe('SE');
  });

  it('logs through the console logger', () => {
    const logger = createLogger({ name: 'compat' });
    expect(() => logger.info({ password: 'hunter2' }, 'hello %s', 'world')).not.toThrow();
  });

  it('memoizes without timers', async () => {
    let calls = 0;
    const cached = cacheable('compat', async (id: string) => {
      calls++;
      return { id };
    }, 60);
    await cached('a');
    await cached('a');
    expect(calls).toBe(1);
  });
});

describe('out-of-scope features (workerd stubs)', () => {
  it('keeps secret redaction for stored integrations', () => {
    const config = {
      type: 'slack',
      access_token: 'xoxb-secret',
      incoming_webhook: { url: 'https://hooks.slack.com/x', channel: '#a' },
    };
    const redacted = redactConfigSecrets(config) as typeof config;
    expect(redacted.access_token).toBe('');
    expect(redacted.incoming_webhook.url).toBe('');
    expect(redacted.incoming_webhook.channel).toBe('#a');
  });

  it('throws FeatureUnavailableError from integration capabilities', () => {
    const slack = getServerIntegration('slack');
    expect(slack.notification).toBeUndefined();
    expect(() =>
      slack.validateConfig?.({} as Parameters<NonNullable<typeof slack.validateConfig>>[0]),
    ).toThrow(FeatureUnavailableError);
  });

  it('stubs Polar but keeps the price table', () => {
    expect(FREE_PRODUCT_IDS.length).toBeGreaterThan(0);
    expect(() => getProducts()).toThrow(FeatureUnavailableError);
  });
});
