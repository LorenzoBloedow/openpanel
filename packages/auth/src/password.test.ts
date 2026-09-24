import { hash as nativeHash, verify as nativeVerify } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import { argon2idHash } from './argon2';
import { NATIVE_ARGON2_VECTORS } from './argon2.vectors';
import {
  PASSWORD_HASH_OPTIONS,
  hashPassword,
  verifyPasswordHash,
} from './password';

const PHC_REGEX =
  /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

describe('argon2 (WebAssembly)', () => {
  it('writes the same PHC format as before', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(PHC_REGEX);
    expect(await hashPassword('correct horse battery staple')).not.toBe(hash);
  });

  it('verifies hashes written by @node-rs/argon2', async () => {
    for (const { password, hash } of NATIVE_ARGON2_VECTORS) {
      expect(await verifyPasswordHash(hash, password)).toBe(true);
      expect(await verifyPasswordHash(hash, `${password}x`)).toBe(false);
    }
  });

  it('writes hashes @node-rs/argon2 accepts', async () => {
    for (const { password } of NATIVE_ARGON2_VECTORS) {
      const hash = await hashPassword(password);
      expect(await nativeVerify(hash, password)).toBe(true);
      expect(await nativeVerify(hash, `${password}x`)).toBe(false);
    }
  });

  it('hashes the full UTF-8 bytes of non-ASCII passwords', async () => {
    // @phi-ag/argon2's own class passes the UTF-16 length, which would
    // hash only a prefix of these.
    const salt = new Uint8Array(16).fill(7);
    const ours = await argon2idHash('pässwörd', { ...PASSWORD_HASH_OPTIONS, salt });
    const native = await nativeHash('pässwörd', {
      ...PASSWORD_HASH_OPTIONS,
      salt: Buffer.from(salt),
    });
    expect(ours).toBe(native);
    expect(await verifyPasswordHash(ours, 'pässwör')).toBe(false);
  });

  it('rejects malformed hashes', async () => {
    await expect(verifyPasswordHash('not-a-hash', 'x')).rejects.toThrow(
      /argon2/,
    );
    await expect(
      verifyPasswordHash('$argon2id$v=19$m=19456,t=2,p=1$broken', 'x'),
    ).rejects.toThrow(/argon2/);
  });

  it('survives many sequential hashes (recovery codes)', async () => {
    const hashes = await Promise.all(
      Array.from({ length: 10 }, (_, i) => hashPassword(`code-${i}`)),
    );
    expect(await verifyPasswordHash(hashes[9]!, 'code-9')).toBe(true);
  });
});
