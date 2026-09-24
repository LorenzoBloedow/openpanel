/**
 * RFC 9562 UUIDv7: 48-bit Unix epoch milliseconds, then random bits.
 *
 * Event ids are minted at ingestion (API / Durable-Object-free path) and used
 * as part of the events primary key; time-ordered ids keep B-tree inserts
 * append-mostly instead of scattering them like v4 does.
 */
export function uuidv7(timestampMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const ms = Math.max(0, Math.floor(timestampMs));
  // 48-bit big-endian timestamp. Bitwise ops are 32-bit, so split the value.
  const high = Math.floor(ms / 2 ** 16);
  const low = ms % 2 ** 16;
  bytes[0] = (high >>> 24) & 0xff;
  bytes[1] = (high >>> 16) & 0xff;
  bytes[2] = (high >>> 8) & 0xff;
  bytes[3] = high & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;

  // Version 7 in the high nibble of byte 6, RFC 4122 variant in byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds encoded in a UUIDv7. */
export function uuidv7Timestamp(uuid: string): number {
  return Number.parseInt(uuid.replace(/-/g, '').slice(0, 12), 16);
}
