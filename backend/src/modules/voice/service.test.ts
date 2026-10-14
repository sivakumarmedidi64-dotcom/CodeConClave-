/**
 * CodeConclave — voice service tests (no network, no key needed).
 */
import { describe, expect, it } from 'vitest';
import { voiceConfigured } from './service.js';

describe('voice service', () => {
  it('reports unconfigured without a key', () => {
    const prev = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    expect(voiceConfigured()).toBe(false);
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
  });

  it('rejects empty text before any network call', async () => {
    const prev = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'sk_test_12345678';
    const { speakText } = await import('./service.js');
    await expect(speakText('   ')).rejects.toThrow('voice_empty_text');
    if (prev === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prev;
  });
});
