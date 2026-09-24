import { loadArgon2Module } from '#argon2-wasm';

/**
 * Argon2 on the static WebAssembly build shipped by `@phi-ag/argon2`.
 *
 * Workers can't load native addons (`@node-rs/argon2`) and refuse to compile
 * WebAssembly from bytes at runtime, so on workerd the module is a static
 * `.wasm` import (argon2-wasm.workerd.ts); Node compiles it from disk.
 *
 * The C exports are called directly instead of through the package's
 * `Argon2` class. That class passes `password.length` (UTF-16 code units) as
 * the byte length of the UTF-8 encoded password, so it hashes a truncated
 * prefix of every non-ASCII password — weaker, and incompatible with the
 * hashes `@node-rs/argon2` wrote. The PHC strings read and written here are
 * the same `$argon2id$v=19$m=…,t=…,p=…$salt$hash` format.
 */

interface Argon2Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  free(pointer: number): void;
  argon2_hash(
    timeCost: number,
    memoryCost: number,
    parallelism: number,
    password: number,
    passwordLength: number,
    salt: number,
    saltLength: number,
    hash: number,
    hashLength: number,
    encoded: number,
    encodedLength: number,
    type: number,
    version: number,
  ): number;
  argon2_verify(
    encoded: number,
    password: number,
    passwordLength: number,
    type: number,
  ): number;
  argon2_encodedlen(
    timeCost: number,
    memoryCost: number,
    parallelism: number,
    saltLength: number,
    hashLength: number,
    type: number,
  ): number;
  argon2_error_message(code: number): number;
}

// argon2.h
const ARGON2_OK = 0;
const ARGON2_DECODING_FAIL = -32;
const ARGON2_VERIFY_MISMATCH = -35;
const ARGON2_VERSION_13 = 0x13;

const ARGON2_TYPES = {
  argon2d: 0,
  argon2i: 1,
  argon2id: 2,
} as const;

const SALT_LENGTH = 16;
const PHC_TYPE_REGEX = /^\$(argon2id|argon2i|argon2d)\$/;

export interface Argon2Options {
  /** Memory in KiB. */
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  /** Hash length in bytes. */
  outputLen: number;
  /** Only for tests; a random 16-byte salt is used otherwise. */
  salt?: Uint8Array;
}

export class Argon2Error extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`argon2: ${message}`);
    this.name = 'Argon2Error';
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let instance: Promise<Argon2Exports> | undefined;

async function instantiate(): Promise<Argon2Exports> {
  const module = await loadArgon2Module();
  const created = await WebAssembly.instantiate(module, {});
  const exports = created.exports as unknown as Argon2Exports;
  exports._initialize();
  return exports;
}

/**
 * One instance per isolate, created on first use (never at module scope).
 * Calls are synchronous, so requests sharing the isolate can't interleave
 * inside the module.
 */
function getArgon2(): Promise<Argon2Exports> {
  instance ??= instantiate().catch((error: unknown) => {
    instance = undefined;
    throw error;
  });
  return instance;
}

function readCString(exports: Argon2Exports, pointer: number): string {
  const heap = new Uint8Array(exports.memory.buffer);
  let end = pointer;
  while (end < heap.length && heap[end] !== 0) {
    end++;
  }
  return decoder.decode(heap.subarray(pointer, end));
}

function errorFor(exports: Argon2Exports, code: number): Argon2Error {
  return new Argon2Error(
    code,
    readCString(exports, exports.argon2_error_message(code)),
  );
}

/**
 * Runs `fn` with a heap allocator whose blocks are zeroed (they hold the
 * password) and freed afterwards. `argon2_hash` itself mallocs and may grow
 * memory, so views over `memory.buffer` are recreated after every call.
 */
function withHeap<T>(
  exports: Argon2Exports,
  fn: (alloc: (input: Uint8Array | number) => number) => T,
): T {
  const blocks: { pointer: number; size: number }[] = [];
  const alloc = (input: Uint8Array | number) => {
    const size = typeof input === 'number' ? input : input.length;
    const pointer = exports.malloc(Math.max(size, 1));
    if (pointer === 0) {
      throw new Argon2Error(-22, 'Memory allocation error');
    }
    blocks.push({ pointer, size });
    if (typeof input !== 'number') {
      new Uint8Array(exports.memory.buffer).set(input, pointer);
    }
    return pointer;
  };

  let trapped = false;
  try {
    return fn(alloc);
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      // A trap can leave the allocator inconsistent: drop this instance
      // and build a fresh one on the next call.
      trapped = true;
      instance = undefined;
    }
    throw error;
  } finally {
    if (!trapped) {
      const heap = new Uint8Array(exports.memory.buffer);
      for (const { pointer, size } of blocks) {
        heap.fill(0, pointer, pointer + size);
        exports.free(pointer);
      }
    }
  }
}

/** Hashes with Argon2id (v1.3) and returns the PHC string. */
export async function argon2idHash(
  password: string,
  options: Argon2Options,
): Promise<string> {
  const exports = await getArgon2();
  const { memoryCost, timeCost, parallelism, outputLen } = options;
  const salt =
    options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const passwordBytes = encoder.encode(password);
  const encodedLength = exports.argon2_encodedlen(
    timeCost,
    memoryCost,
    parallelism,
    salt.length,
    outputLen,
    ARGON2_TYPES.argon2id,
  );

  return withHeap(exports, (alloc) => {
    const passwordPointer = alloc(passwordBytes);
    const saltPointer = alloc(salt);
    const hashPointer = alloc(outputLen);
    const encodedPointer = alloc(encodedLength);
    const code = exports.argon2_hash(
      timeCost,
      memoryCost,
      parallelism,
      passwordPointer,
      passwordBytes.length,
      saltPointer,
      salt.length,
      hashPointer,
      outputLen,
      encodedPointer,
      encodedLength,
      ARGON2_TYPES.argon2id,
      ARGON2_VERSION_13,
    );
    if (code !== ARGON2_OK) {
      throw errorFor(exports, code);
    }
    return readCString(exports, encodedPointer);
  });
}

/**
 * Verifies a password against a PHC string (any Argon2 variant). Resolves
 * `false` on a mismatch and rejects on a malformed hash, like
 * `@node-rs/argon2`'s `verify`.
 */
export async function argon2Verify(
  encoded: string,
  password: string,
): Promise<boolean> {
  const variant = PHC_TYPE_REGEX.exec(encoded)?.[1] as
    | keyof typeof ARGON2_TYPES
    | undefined;
  if (!variant) {
    throw new Argon2Error(ARGON2_DECODING_FAIL, 'Decoding failed');
  }

  const exports = await getArgon2();
  const encodedBytes = encoder.encode(`${encoded}\0`);
  const passwordBytes = encoder.encode(password);

  return withHeap(exports, (alloc) => {
    const code = exports.argon2_verify(
      alloc(encodedBytes),
      alloc(passwordBytes),
      passwordBytes.length,
      ARGON2_TYPES[variant],
    );
    if (code === ARGON2_OK) {
      return true;
    }
    if (code === ARGON2_VERIFY_MISMATCH) {
      return false;
    }
    throw errorFor(exports, code);
  });
}
