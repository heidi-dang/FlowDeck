/* eslint-disable no-eval */
// oxlint-disable no-eval
export function executeDynamicCode(code: string) {
  // biome-ignore lint/security/noGlobalEval: fixture testing eval unknown trigger
  // eslint-disable-next-line no-eval
  return (0, eval)(code);
}
