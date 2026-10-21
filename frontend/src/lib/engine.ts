/**
 * "Only our AI": the product-facing name for whatever engine answered.
 * CodeConClave's own tuned models are named (coder-lite, scout…); any other
 * engine behind the gateway is a "cloud engine" — never a provider brand.
 */
export function engineLabel(providerId: string | null | undefined, modelId?: string | null): string {
  if (providerId === 'resident') {
    const name = (modelId ?? '').split('/').pop()?.replace(/^codeconclave-/, '') || 'own model';
    return `CodeConClave AI · ${name}`;
  }
  return 'CodeConClave AI · cloud engine';
}
