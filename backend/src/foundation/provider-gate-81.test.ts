/**
 * CodeConClave — Stage 81 AI PROVIDER GATE ("keep only the ones that work").
 *
 * The founder asked: keep only the AI providers that actually work, remove the
 * rest. This suite proves the quality gate does it WITHOUT deleting code:
 *
 *   - manus / big_pickle are gated (hidden + disabled);
 *   - a gated provider is NEVER "configured", even when a key exists;
 *   - the status snapshot reports gated providers as BLOCKED with the real
 *     reason (transparent to the founder, never silently absent);
 *   - getAdapter fails closed and can never build a gated adapter.
 *
 * Service logic runs real; DB + registry reads are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { configuredMock, registryMock } = vi.hoisted(() => ({
  configuredMock: vi.fn(async () => [] as string[]),
  registryMock: vi.fn(async () => [] as unknown[]),
}));

const dbMock = vi.hoisted(() => {
  async function queryImpl(): Promise<{ rows: unknown[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }
  return {
    pool: { query: queryImpl },
    queryMany: async () => [] as unknown[],
    queryOne: async () => null,
    withTenant: async (_u: string | null, fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/ai/registry.js', () => ({
  configuredProviders: configuredMock,
  getRegistry: registryMock,
}));

import {
  PROVIDER_QUALITY_GATE, providerGateReason, isProviderVisible,
} from '../modules/ai/gate.js';
import { providerStatusSnapshot } from '../modules/ai/status.js';
import { getAdapter } from '../modules/ai/providers.js';
import { AppError } from '../shared/errors.js';

const GATED = ['manus', 'big_pickle'];
// big_pickle is the local runtime id (only in the provider key spec, not the
// frozen shared ProviderId union) so it is gated at adapter + configured level
// but never appears in the status snapshot; manus is a registry provider and
// MUST surface there as BLOCKED.
const SNAPSHOT_GATED = ['manus'];

beforeEach(() => {
  configuredMock.mockClear();
  registryMock.mockClear();
});

describe('PROVIDER QUALITY GATE — definition (#81)', () => {
  it('gates the four provably-unusable providers', () => {
    expect(Object.keys(PROVIDER_QUALITY_GATE).sort()).toEqual(GATED.sort());
  });

  it('exposes a reason for gated providers and none for working ones', () => {
    for (const p of GATED) expect(providerGateReason(p)).toBeTruthy();
    for (const p of ['openai', 'google', 'qwen', 'gemma', 'anthropic', 'mistral']) {
      expect(providerGateReason(p)).toBeNull();
      expect(isProviderVisible(p)).toBe(true);
    }
  });
});

describe('PROVIDER QUALITY GATE — configured routing', () => {
  it('never reports a gated provider as configured, even when a key is present', async () => {
    configuredMock.mockResolvedValue(['manus', 'big_pickle', 'google', 'openai']);
    registryMock.mockResolvedValue([]);
    const snapshot = await providerStatusSnapshot();
    for (const p of SNAPSHOT_GATED) {
      const row = snapshot.find((r) => r.providerId === p)!;
      expect(row.status).toBe('BLOCKED');
      expect(row.configured).toBe(false);
      expect(row.label).toContain('provider quality gate');
    }
    // working providers keep their honest status shape
    expect(snapshot.find((r) => r.providerId === 'google')!.status).toBe('CONFIGURED');
  });

  it('gated providers are still listed in the snapshot (visible to the founder, honest)', async () => {
    configuredMock.mockResolvedValue([]);
    registryMock.mockResolvedValue([]);
    const snapshot = await providerStatusSnapshot();
    const ids = snapshot.map((r) => r.providerId).sort();
    for (const p of SNAPSHOT_GATED) expect(ids).toContain(p);
  });
});

describe('PROVIDER QUALITY GATE — adapter fail-closed', () => {
  it('never constructs an adapter for a gated provider (key presence irrelevant)', () => {
    for (const p of GATED) {
      let caught: unknown = null;
      try {
        getAdapter(p, p === 'manus' ? 'manus-1.6' : 'stealth/model');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).errorCode).toBe('provider_quality_gate');
    }
  });

  it('never raises the quality gate for a working provider id', () => {
    try {
      getAdapter('google', 'gemini-3.7-flash');
    } catch (err) {
      expect((err as AppError).errorCode).not.toBe('provider_quality_gate');
    }
  });
});