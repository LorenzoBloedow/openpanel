// Stand-in for `prettier/standalone` (see the alias in wrangler.jsonc):
// @react-email/render only calls it for `pretty: true`, which we never pass.
export function format(): never {
  throw new Error('prettier is not bundled; render emails without { pretty: true }');
}

export default { format };
