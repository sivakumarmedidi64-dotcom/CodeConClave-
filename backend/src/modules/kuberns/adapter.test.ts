/**
 * CodeConClave — Kuberns adapter boundary tests.
 *
 * Proves the boundary is honest: disabled by default, CONFIGURATION_REQUIRED
 * without credentials, never "live" from static config, and it refuses to
 * deploy (an honest error) rather than fabricating a success.
 */
import { describe, it, expect, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  KUBERNS_ADAPTER_ENABLED: 'false',
  KUBERNS_API_URL: '',
  KUBERNS_API_TOKEN: '',
}));
vi.mock('../../config/env.js', () => ({ env: mockEnv }));

import { kubernsStatus, kubernsConfigured, kubernsAdapterEnabled, assertKubernsReady, kubernsDeploySupported } from './adapter.js';

const reset = (overrides: Partial<typeof mockEnv> = {}) => {
  mockEnv.KUBERNS_ADAPTER_ENABLED = 'false';
  mockEnv.KUBERNS_API_URL = '';
  mockEnv.KUBERNS_API_TOKEN = '';
  Object.assign(mockEnv, overrides);
};

describe('kuberns adapter boundary', () => {
  it('is disabled by default and never claims to be live', () => {
    reset();
    const s = kubernsStatus();
    expect(kubernsAdapterEnabled()).toBe(false);
    expect(s.enabled).toBe(false);
    expect(s.state).toBe('DISABLED');
    expect(s.live).toBe(false);
  });

  it('reports CONFIGURATION_REQUIRED when enabled without credentials', () => {
    reset({ KUBERNS_ADAPTER_ENABLED: 'true' });
    expect(kubernsConfigured()).toBe(false);
    const s = kubernsStatus();
    expect(s.state).toBe('CONFIGURATION_REQUIRED');
    expect(s.live).toBe(false);
  });

  it('reports CONFIGURED (not live) once a URL and token are present', () => {
    reset({ KUBERNS_ADAPTER_ENABLED: 'true', KUBERNS_API_URL: 'https://api.kuberns.example', KUBERNS_API_TOKEN: 'tok' });
    expect(kubernsConfigured()).toBe(true);
    const s = kubernsStatus();
    expect(s.state).toBe('CONFIGURED');
    expect(s.live).toBe(false);
  });

  it('treats a blank URL or token as not configured', () => {
    reset({ KUBERNS_ADAPTER_ENABLED: 'true', KUBERNS_API_URL: '   ', KUBERNS_API_TOKEN: 'tok' });
    expect(kubernsConfigured()).toBe(false);
  });

  it('refuses to deploy while disabled or unconfigured', () => {
    reset();
    expect(() => assertKubernsReady()).toThrowError(/Kuberns adapter is disabled/);
    reset({ KUBERNS_ADAPTER_ENABLED: 'true' });
    expect(() => assertKubernsReady()).toThrowError(/required before the Kuberns adapter/);
  });

  it('passes the gate when configured but never supports deployment yet', () => {
    reset({ KUBERNS_ADAPTER_ENABLED: 'true', KUBERNS_API_URL: 'https://api.kuberns.example', KUBERNS_API_TOKEN: 'tok' });
    expect(() => assertKubernsReady()).not.toThrow();
    expect(kubernsDeploySupported()).toBe(false);
  });
});
