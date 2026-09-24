import { createHash as nodeCreateHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHash, hashPassword, verifyPassword } from './crypto';
import { generateDeviceId } from './profileId';
import { uuidv7, uuidv7Timestamp } from './uuid';

describe('createHash (shake256)', () => {
  it.each([
    ['', 16],
    ['Mozilla/5.0:1.2.3.4:project:salt', 16],
    ['åäö unicode ✓', 16],
    ['x'.repeat(1000), 32],
  ])('matches node:crypto shake256 for %j', (input, len) => {
    const expected = nodeCreateHash('shake256', { outputLength: len })
      .update(input)
      .digest('hex');
    expect(createHash(input, len)).toBe(expected);
  });

  it('keeps device ids stable', () => {
    expect(
      generateDeviceId({
        salt: 'salt',
        ua: 'Mozilla/5.0',
        ip: '203.0.113.7',
        origin: 'project-1',
      }),
    ).toBe(
      nodeCreateHash('shake256', { outputLength: 16 })
        .update('Mozilla/5.0:203.0.113.7:project-1:salt')
        .digest('hex'),
    );
  });
});

describe('scrypt secrets', () => {
  it('round-trips and rejects wrong secrets', async () => {
    const hash = await hashPassword('sec_abc');
    expect(await verifyPassword('sec_abc', hash)).toBe(true);
    expect(await verifyPassword('sec_abd', hash)).toBe(false);
  });
});

describe('uuidv7', () => {
  it('produces RFC 9562 v7 ids carrying the timestamp', () => {
    const ts = Date.UTC(2026, 8, 24, 12, 0, 0, 123);
    const id = uuidv7(ts);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(uuidv7Timestamp(id)).toBe(ts);
  });

  it('sorts by time', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a < b).toBe(true);
  });
});
