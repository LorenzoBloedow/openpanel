/**
 * PHC strings produced by @node-rs/argon2 2.x with the production options
 * (m=19456, t=2, p=1, 32-byte output). Both the Node tests and the workerd
 * compat suite verify them, proving hashes stored before the move to
 * WebAssembly keep working.
 */
export const NATIVE_ARGON2_VECTORS = [
  {
    password: 'correct horse battery staple',
    hash: '$argon2id$v=19$m=19456,t=2,p=1$zCC2bCkVPhB8taXLmR8bxg$7YljCiLqkGw4/dMu5rP8ZlVdRh80N3zlajKWd3HQMdA',
  },
  {
    password: 'pässwörd-ünïcode',
    hash: '$argon2id$v=19$m=19456,t=2,p=1$zG8xSvivY8olw1Mqr4JCwg$CJXb5rcXM+7tRPqSR4j4+IXin01WXFM0BbYFNNRidOM',
  },
  {
    password: '🔐 emoji 🔑',
    hash: '$argon2id$v=19$m=19456,t=2,p=1$EAoO0tvK5TGsmwQZqxkZIg$kaSPgR1V9dFtWcdNHiT5KnrLXRiyRnRZ74w4wnN8GG8',
  },
  {
    password: '',
    hash: '$argon2id$v=19$m=19456,t=2,p=1$H7SmPQs9fTaPFCz/E0kTcA$Bgv19hvo+fH0AMXWZPAYThkT+q2agZ9BJqZd0rPp5HY',
  },
] as const;
