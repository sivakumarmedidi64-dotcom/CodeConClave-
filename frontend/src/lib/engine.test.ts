import { describe, expect, it } from 'vitest';
import { engineLabel } from './engine';

describe('engineLabel', () => {
  it('names our own models and never a provider brand', () => {
    expect(engineLabel('resident', 'SaharshMedidi/codeconclave-coder-lite')).toBe('CodeConClave AI · coder-lite');
    for (const p of ['anthropic', 'openai', 'google', 'mistral', 'grok']) {
      const label = engineLabel(p, 'some-model-v3');
      expect(label).toBe('CodeConClave AI · cloud engine');
      expect(label.toLowerCase()).not.toContain(p);
    }
  });
});
