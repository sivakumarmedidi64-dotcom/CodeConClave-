/**
 * RESPONSE_READY sound (§6) — exactly once, only when armed, preference-gated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeAudioContext {
  state: 'running' | 'suspended' = 'running';
  currentTime = 0;
  resume = vi.fn(async () => {
    this.state = 'running';
  });
}

function installWindow() {
  let localStorageData: Record<string, string> = {};
  vi.stubGlobal('window', {
    AudioContext: FakeAudioContext,
    localStorage: {
      getItem: (k: string) => localStorageData[k] ?? null,
      setItem: (k: string, v: string) => {
        localStorageData[k] = v;
      },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

beforeEach(() => {
  installWindow();
});

describe('RESPONSE_READY sound', () => {
  it('plays exactly once per response — armed single-shot (rerender/reconnect dedupe)', async () => {
    const mod = await import('../lib/responseSound');
    const calls: string[] = [];
    mod.__setSoundProducerForTests(() => calls.push('ring'));
    mod.armResponseSound();
    mod.playResponseReadySound();
    mod.playResponseReadySound();
    mod.playResponseReadySound();
    expect(calls).toHaveLength(1);
  });

  it('never plays without an explicit arm — page load / resume / sync stay silent', async () => {
    const mod = await import('../lib/responseSound');
    const calls: string[] = [];
    mod.__setSoundProducerForTests(() => calls.push('ring'));
    mod.playResponseReadySound();
    mod.playResponseReadySound();
    expect(calls).toHaveLength(0);
  });

  it('respects the Sound OFF preference', async () => {
    const mod = await import('../lib/responseSound');
    const calls: string[] = [];
    mod.__setSoundProducerForTests(() => calls.push('ring'));
    mod.setResponseSoundEnabled(false);
    mod.armResponseSound();
    mod.playResponseReadySound();
    expect(calls).toHaveLength(0);
  });

  it('defaults ON when the browser permits audio', async () => {
    vi.resetModules();
    const mod = await import('../lib/responseSound');
    const calls: string[] = [];
    mod.__setSoundProducerForTests(() => calls.push('ring'));
    mod.armResponseSound();
    mod.playResponseReadySound();
    expect(calls).toHaveLength(1);
  });
});